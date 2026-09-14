#!/usr/bin/env node
/**
 * @file scripts/publish-release.mjs
 * @purpose 把 release/<version>/ 下的安装器双发到 GitLab Generic Package + GitHub Releases。
 *
 * @背景
 * 本地/CI 打完包后,产物落在 release/<version>/。本脚本负责:
 *   1. 上传到自建 GitLab 的 Generic Package Registry + 创建 GitLab Release
 *   2. (可选)同步到 GitHub Releases(GH_TOKEN 存在时)
 *
 * 不依赖第三方 HTTP 客户端 — Node 20 原生 fetch / FormData 够用
 * (AGENTS.md 边界 2:不轻易加 npm 包)。
 *
 * @用法
 *   npm run publish:release
 *   npm run publish:release -- --version=0.3.3 --dry-run
 *   npm run publish:release -- --gitlab-only
 *   npm run publish:release -- --github-only
 *
 * @环境变量
 *   GitLab(必填,除非 --github-only):
 *     GITLAB_URL          例 https://fexlagame.top:4812
 *     GITLAB_PROJECT_ID   数字项目 id,或 URL-encoded path(如 aitool%2Fmarina)
 *     GITLAB_TOKEN        personal / project / CI_JOB_TOKEN(需 api 权限)
 *   GitHub(可选,有则双发):
 *     GH_TOKEN            classic PAT,repo scope
 *     GITHUB_OWNER        默认 fexla
 *     GITHUB_REPO         默认 marina
 *
 * @退出码
 *   0 = 全部目标成功(或 dry-run)
 *   1 = 任一目标失败
 *   2 = 参数/环境错误
 *
 * @对应文档
 *   docs/打包发布流程.md §4 GitLab CI
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), '..');

// ============================================================
// 参数
// ============================================================
const args = process.argv.slice(2);
const opts = {
  version: null,
  dryRun: false,
  gitlabOnly: false,
  githubOnly: false,
  help: false,
};

for (const a of args) {
  if (a.startsWith('--version=')) opts.version = a.slice('--version='.length);
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--gitlab-only') opts.gitlabOnly = true;
  else if (a === '--github-only') opts.githubOnly = true;
  else if (a === '--help' || a === '-h') opts.help = true;
  else {
    console.error(`[publish] 未知参数:${a}`);
    process.exit(2);
  }
}

if (opts.help) {
  console.log(`Marina 双源发布(GitLab Generic Package + GitHub Releases)

用法:
  npm run publish:release [-- --version=<v>] [--dry-run] [--gitlab-only|--github-only]

环境变量见 scripts/publish-release.mjs 文件头注释。`);
  process.exit(0);
}

if (opts.gitlabOnly && opts.githubOnly) {
  console.error('[publish] --gitlab-only 与 --github-only 不能同时给');
  process.exit(2);
}

// ============================================================
// 工具
// ============================================================
const ANSI = process.stdout.isTTY;
const C = {
  reset: ANSI ? '\x1b[0m' : '',
  bold: ANSI ? '\x1b[1m' : '',
  dim: ANSI ? '\x1b[2m' : '',
  red: ANSI ? '\x1b[31m' : '',
  green: ANSI ? '\x1b[32m' : '',
  yellow: ANSI ? '\x1b[33m' : '',
  blue: ANSI ? '\x1b[36m' : '',
};

function info(...m) {
  console.log(`${C.blue}  →${C.reset}`, ...m);
}
function ok(...m) {
  console.log(`${C.green}  ✓${C.reset}`, ...m);
}
function warn(...m) {
  console.log(`${C.yellow}  ⚠${C.reset}`, ...m);
}
function err(...m) {
  console.error(`${C.red}  ✗${C.reset}`, ...m);
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/**
 * 扫 release/<version>/ 选出应上传的安装器与元数据。
 * 跳过 unpacked/ 目录与 .blockmap(hash 文件本身,用户不需要单独下)。
 * blockmap 仍需要传给 GitHub — electron-updater 增量更新会用;GitLab 侧也一并传。
 */
function collectArtifacts(version) {
  const dir = join(projectRoot, 'release', version);
  if (!existsSync(dir)) {
    throw new Error(
      `找不到产物目录 ${dir}\n` +
        `  先跑: npm run release:win / release:linux / release:all`,
    );
  }
  const installers = [];
  const meta = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    if (name.endsWith('-unpacked') || name.includes('unpacked')) continue;
    const isInstaller = /\.(exe|deb|rpm|AppImage|dmg|zip|nupkg)$/i.test(name);
    const isMeta =
      name === 'latest.yml' ||
      name === 'latest-linux.yml' ||
      name === 'latest-mac.yml' ||
      name.endsWith('.blockmap') ||
      name === 'RELEASE_NOTES.md' ||
      name === 'sha256sums.txt';
    if (isInstaller || isMeta) {
      const item = { name, path: full, size: statSync(full).size, sha256: sha256File(full) };
      if (isInstaller) installers.push(item);
      else meta.push(item);
    }
  }
  if (installers.length === 0) {
    throw new Error(`${dir} 下没有任何安装器(.exe/.deb/.rpm/.AppImage)`);
  }
  return { dir, installers, meta, all: [...installers, ...meta] };
}

function writeSha256sums(dir, files) {
  const lines = files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n';
  const out = join(dir, 'sha256sums.txt');
  if (!opts.dryRun) {
    writeFileSync(out, lines);
  }
  return out;
}

// ============================================================
// GitLab
// ============================================================

/**
 * 查已上传到该 package version 下的文件,用于幂等判断。
 *
 * 为什么需要:GitLab Generic Package Registry **不允许同一 version 下重复文件名**,
 * 重复 PUT 返回 403。没有这层预检时,任何 pipeline retry / 失败重跑都会在第一个
 * 文件就挂掉(GitHub 侧有 existingNames 去重,这里是补齐对称性)。
 *
 * 为什么要带 sha256 而不是只带文件名:同一个版本可能被**增量补传**——例如先发
 * Windows 包,之后再补 Linux 包,此时 `sha256sums.txt` 的内容必须从"只含 Windows"
 * 改成"含全部"。只按名字判重会把它误判成"已存在"而跳过,留下的就是过期校验和。
 * 带上 sha256 后:内容一致才跳过;内容变了则删掉远端旧文件再传。
 *
 * @returns Map<string, {fileId:number, packageId:number, sha256:string}> | null
 *          null 表示查询失败(权限不足等),调用方应退回盲传
 */
async function fetchExistingPackageFiles(api, headers, pkgName, version) {
  const listUrl =
    `${api}/packages?package_type=generic&package_name=${encodeURIComponent(pkgName)}` +
    `&package_version=${encodeURIComponent(version)}&per_page=100`;
  const res = await fetch(listUrl, { headers });
  if (!res.ok) return null;
  const pkgs = await res.json();
  if (!Array.isArray(pkgs)) return null;
  const files = new Map();
  for (const p of pkgs) {
    const filesRes = await fetch(`${api}/packages/${p.id}/package_files?per_page=100`, { headers });
    if (!filesRes.ok) continue;
    const list = await filesRes.json();
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      files.set(f.file_name, {
        fileId: f.id,
        packageId: p.id,
        sha256: f.file_sha256 || '',
      });
    }
  }
  return files;
}

async function publishGitLab(version, artifacts) {
  const url = (process.env.GITLAB_URL || '').replace(/\/$/, '');
  const projectId = process.env.GITLAB_PROJECT_ID || '';
  // 鉴权优先级:project access token > CI job token。两者用的 HTTP 头不同
  // (PAT 走 PRIVATE-TOKEN,job token 走 JOB-TOKEN),混用必然 401/403。
  const pat = process.env.GITLAB_TOKEN || '';
  const jobToken = process.env.CI_JOB_TOKEN || '';
  const token = pat || jobToken;

  if (opts.githubOnly) {
    info('跳过 GitLab(--github-only)');
    return { skipped: true };
  }

  const missing = [];
  if (!url) missing.push('GITLAB_URL');
  if (!projectId) missing.push('GITLAB_PROJECT_ID');
  if (!token) missing.push('GITLAB_TOKEN');

  // dry-run 的用途就是"没凭据也能预览",所以缺变量只在真上传时才致命。
  if (missing.length) {
    if (!opts.dryRun) {
      err(`GitLab 环境不完整:缺少 ${missing.join(' / ')}`);
      throw new Error('GitLab env missing');
    }
    warn(`dry-run:缺少 ${missing.join(' / ')},目标 URL 用占位值展示`);
  }

  const api = `${url || '<GITLAB_URL>'}/api/v4/projects/${encodeURIComponent(projectId || '<GITLAB_PROJECT_ID>')}`;
  const pkgName = 'marina';
  const headers = jobToken && !pat ? { 'JOB-TOKEN': jobToken } : { 'PRIVATE-TOKEN': token };

  info(`GitLab:${url || '(未配置)'} project=${projectId || '(未配置)'} package=${pkgName}@${version}`);

  // 0) 预检已存在的文件(幂等:内容一致才跳过,变了就删旧传新)
  let existingFiles = null;
  if (!opts.dryRun && !missing.length) {
    existingFiles = await fetchExistingPackageFiles(api, headers, pkgName, version);
    if (existingFiles === null) {
      warn('无法查询已有 package 文件(权限不足?),将直接上传');
    } else if (existingFiles.size > 0) {
      info(`该版本远端已有 ${existingFiles.size} 个文件,将逐个比对 sha256`);
    }
  }

  // 1) 上传 Generic Package
  let uploaded = 0;
  let replaced = 0;
  let skipped = 0;
  for (const f of artifacts.all) {
    const uploadUrl = `${api}/packages/generic/${pkgName}/${version}/${encodeURIComponent(f.name)}`;
    if (opts.dryRun) {
      info(`[dry-run] PUT ${uploadUrl} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    const remote = existingFiles ? existingFiles.get(f.name) : undefined;
    if (remote) {
      if (!remote.sha256) {
        // 拿不到远端校验和,无法判断内容是否变化 —— 保守跳过并提示。
        info(`已存在(远端未返回 sha256,跳过): ${f.name}`);
        skipped++;
        continue;
      }
      if (remote.sha256 === f.sha256) {
        info(`已存在且内容一致,跳过: ${f.name}`);
        skipped++;
        continue;
      }
      // 同名但内容不同(典型场景:补传平台后重算 sha256sums.txt)。
      // GitLab 不允许同 version 重名,必须先删远端旧文件再传。
      info(`内容已变化,先删远端旧文件: ${f.name}`);
      const del = await fetch(`${api}/packages/${remote.packageId}/package_files/${remote.fileId}`, {
        method: 'DELETE',
        headers,
      });
      if (!del.ok && del.status !== 404) {
        const text = await del.text();
        throw new Error(
          `删除远端旧文件失败 ${f.name}: HTTP ${del.status} ${text.slice(0, 200)}。` +
            `建议:确认 token 具备 api scope 且对该项目有 maintainer 权限。`,
        );
      }
      replaced++;
    }
    info(`上传 ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    const buf = readFileSync(f.path);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
      },
      body: buf,
    });
    if (res.status === 403) {
      // 预检成功却仍 403,说明是权限问题而非重名;预检失败时则两者皆有可能。
      throw new Error(
        `GitLab 上传被拒 ${f.name}: HTTP 403。` +
          `可能原因:(1) 同名文件已存在于该 package version(GitLab 不允许重复文件名),` +
          `(2) token 缺 api 权限或已过期。` +
          `建议:确认 GITLAB_TOKEN 是带 api scope 的 project access token。`,
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab 上传失败 ${f.name}: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    uploaded++;
  }
  if (!opts.dryRun) {
    ok(
      `Generic Package 上传完成(上传 ${uploaded} 个,其中覆盖重名 ${replaced} 个;跳过 ${skipped} 个)`,
    );
  }

  // 2) 创建 / 更新 Release,资产链到 Generic Package 下载 URL
  //
  // 必须用 **API 路径** `/api/v4/projects/<id>/packages/generic/...`:
  //   - API 路径:匿名即可下载(公开项目),返回 application/octet-stream。
  //   - 网页路径 `/<-/packages/generic/...`:即使项目 public,匿名访问也只会
  //     返回 GitLab 登录页(HTTP 200 + text/html),用户点开 Releases 页面上的
  //     链接会看到"Sign in"。这是实测结论(2026-09-20,自建 fexlagame.top)。
  // 代价:链接里带项目数字 id。可接受 —— 稳定且能直接下载。
  const assetLinks = artifacts.all.map((f) => ({
    name: f.name,
    url: `${api}/packages/generic/${pkgName}/${version}/${encodeURIComponent(f.name)}`,
    link_type: 'package',
  }));

  const releaseBody = {
    tag_name: `v${version}`,
    name: `Marina ${version}`,
    description: readReleaseNotes(version),
    assets: { links: assetLinks },
  };
  // 预发布标记:GitLab Releases API **没有** prerelease 布尔字段。
  // 不要用 upcoming_release 顶替 —— 它的语义是"排期在未来、尚未发布的 Release"
  // (配合 released_at 使用),拿它标 dev 包会让 GitLab UI 显示成 "Upcoming Release"。
  // 预发布信息由版本号自身承载:tag / name 里的 `-dev.N` / `-beta.N` 后缀即是标识。
  // (GitHub 侧有原生 prerelease 字段,见 publishGitHub)

  if (opts.dryRun) {
    info(`[dry-run] POST ${api}/releases tag=v${version} assets=${assetLinks.length}`);
    return { ok: true, dryRun: true };
  }

  // 已存在同 tag → 先删再建,避免 409
  const existing = await fetch(`${api}/releases/v${version}`, { headers });
  if (existing.status === 200) {
    warn(`Release v${version} 已存在,先删除再重建`);
    const del = await fetch(`${api}/releases/v${version}`, { method: 'DELETE', headers });
    if (!del.ok && del.status !== 404) {
      throw new Error(`删除旧 Release 失败: HTTP ${del.status}`);
    }
  }

  const relRes = await fetch(`${api}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(releaseBody),
  });
  if (!relRes.ok) {
    const text = await relRes.text();
    throw new Error(`创建 GitLab Release 失败: HTTP ${relRes.status} ${text.slice(0, 400)}`);
  }
  const rel = await relRes.json();
  ok(`GitLab Release 已创建: ${rel._links?.self || rel.tag_name}`);
  return { ok: true, url: rel._links?.self };
}

// ============================================================
// GitHub
// ============================================================
async function publishGitHub(version, artifacts) {
  if (opts.gitlabOnly) {
    info('跳过 GitHub(--gitlab-only)');
    return { skipped: true };
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const owner = process.env.GITHUB_OWNER || 'fexla';
  const repo = process.env.GITHUB_REPO || 'marina';
  if (!token) {
    warn('未设置 GH_TOKEN / GITHUB_TOKEN — 跳过 GitHub 同步');
    return { skipped: true, reason: 'no-token' };
  }

  info(`GitHub:${owner}/${repo}`);

  const apiBase = 'https://api.github.com';
  const auth = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'marina-publish-release',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const tag = `v${version}`;
  const isPrerelease = version.includes('-');

  if (opts.dryRun) {
    info(`[dry-run] GitHub release ${tag} prerelease=${isPrerelease} assets=${artifacts.all.length}`);
    return { ok: true, dryRun: true };
  }

  // 找已有 release
  let releaseId = null;
  const listRes = await fetch(`${apiBase}/repos/${owner}/${repo}/releases/tags/${tag}`, {
    headers: auth,
  });
  if (listRes.status === 200) {
    const existing = await listRes.json();
    releaseId = existing.id;
    warn(`GitHub Release ${tag} 已存在(id=${releaseId}),复用并补传资产`);
  } else if (listRes.status === 404) {
    const createRes = await fetch(`${apiBase}/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: `Marina ${version}`,
        body: readReleaseNotes(version),
        prerelease: isPrerelease,
        draft: false,
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`创建 GitHub Release 失败: HTTP ${createRes.status} ${text.slice(0, 400)}`);
    }
    releaseId = (await createRes.json()).id;
  } else {
    const text = await listRes.text();
    throw new Error(`查询 GitHub Release 失败: HTTP ${listRes.status} ${text.slice(0, 300)}`);
  }

  // 已有资产名 → 跳过重传
  const assetsRes = await fetch(`${apiBase}/repos/${owner}/${repo}/releases/${releaseId}/assets`, {
    headers: auth,
  });
  const existingNames = new Set(
    assetsRes.ok ? (await assetsRes.json()).map((a) => a.name) : [],
  );

  for (const f of artifacts.all) {
    if (existingNames.has(f.name)) {
      info(`资产已存在,跳过: ${f.name}`);
      continue;
    }
    info(`上传 GitHub 资产 ${f.name}`);
    const buf = readFileSync(f.path);
    const uploadRes = await fetch(
      `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(f.name)}`,
      {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/octet-stream',
        },
        body: buf,
      },
    );
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`GitHub 上传失败 ${f.name}: HTTP ${uploadRes.status} ${text.slice(0, 300)}`);
    }
  }
  ok(`GitHub Release 就绪: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
  return {
    ok: true,
    url: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
  };
}

function readReleaseNotes(version) {
  // 优先取 CHANGELOG 里该版本段;找不到则用通用说明
  const changelogPath = join(projectRoot, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    const text = readFileSync(changelogPath, 'utf8');
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `##\\s*\\[?${escaped}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    );
    const m = text.match(re);
    if (m && m[1].trim()) {
      return m[1].trim().slice(0, 8000);
    }
  }
  return [
    `Marina ${version}`,
    '',
    '### 下载',
    '- Windows: `Marina-Setup-*-x64.exe`(安装)或 `Marina-Portable-*-x64.exe`(便携)',
    '- Linux: `.deb` / `.rpm` / `.AppImage`(x64)',
    '',
    '### 校验',
    '同目录 `sha256sums.txt`。',
    '',
    '### 注意',
    'Windows 包尚未代码签名,SmartScreen 首次运行会拦截 →「更多信息 → 仍要运行」。',
    '',
    '完整变更见 CHANGELOG.md。',
  ].join('\n');
}

// ============================================================
// main
// ============================================================
async function main() {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const version = opts.version || pkg.version;
  console.log(`\n${C.bold}Marina publish ${version}${C.reset}`);

  if (opts.version && opts.version !== pkg.version) {
    warn(`--version=${opts.version} 与 package.json (${pkg.version}) 不一致 — 以 --version 为准`);
  }

  const artifacts = collectArtifacts(version);
  // 先写 sha256sums,再把它算进 all。
  //
  // 必须先按名去重:产物目录里通常已存在上一轮生成的 sha256sums.txt,它会被
  // collectArtifacts 当作 meta 收进 all;此处再 push 一份就会产生重名条目,
  // GitLab 建 Release 时以 400 "links have duplicate values" 直接拒绝
  // (2026-09-20 实测,第二次发布 0.3.3 时踩到)。
  const sumsPath = writeSha256sums(artifacts.dir, artifacts.installers);
  if (!opts.dryRun) {
    artifacts.all = artifacts.all.filter((f) => f.name !== 'sha256sums.txt');
    artifacts.all.push({
      name: 'sha256sums.txt',
      path: sumsPath,
      size: statSync(sumsPath).size,
      sha256: sha256File(sumsPath),
    });
  } else {
    info('[dry-run] 将生成 sha256sums.txt');
  }

  info(`产物 ${artifacts.installers.length} 个安装器 + ${artifacts.meta.length} 个元数据`);
  for (const f of artifacts.installers) {
    console.log(`    ${C.green}•${C.reset} ${f.name}  ${C.dim}${(f.size / 1024 / 1024).toFixed(1)} MB  ${f.sha256.slice(0, 12)}…${C.reset}`);
  }

  const results = {};
  let failed = false;

  try {
    results.gitlab = await publishGitLab(version, artifacts);
  } catch (e) {
    err(`GitLab 发布失败: ${e.message}`);
    results.gitlab = { ok: false, error: e.message };
    failed = true;
  }

  try {
    results.github = await publishGitHub(version, artifacts);
  } catch (e) {
    err(`GitHub 发布失败: ${e.message}`);
    results.github = { ok: false, error: e.message };
    failed = true;
  }

  console.log('');
  if (failed) {
    err('发布未完全成功 — 见上方错误');
    process.exit(1);
  }
  ok(`双源发布完成: Marina ${version}`);
  if (results.gitlab?.url) console.log(`  GitLab: ${results.gitlab.url}`);
  if (results.github?.url) console.log(`  GitHub: ${results.github.url}`);
  console.log('');
}

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
