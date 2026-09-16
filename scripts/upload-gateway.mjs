#!/usr/bin/env node
/**
 * @file scripts/upload-gateway.mjs
 * @purpose 把 GitLab Generic Package 里已发布的 marina 安装包镜像到包体网关(OSS),供 VPN 内网下载。
 *
 * @背景
 * 发布产物先经 publish-release.mjs 进 GitLab Generic Packages(Windows 包由
 * Windows 机器本地 publish,从不经过 Linux runner)。本脚本以 GitLab 包为唯一
 * 镜像源 —— 拉 GitLab 才能三平台全覆盖;网关侧按对象 size 幂等,重跑即补齐
 * 后续到位的文件(如 Windows 包)。
 *
 * @用法
 *   node scripts/upload-gateway.mjs --version=0.3.3
 *   node scripts/upload-gateway.mjs --tag=v0.4.0          (等价:version=0.4.0)
 *   node scripts/upload-gateway.mjs --version=0.3.3 --dest-prefix=_selftest/marina-0.3.3 --dry-run
 *
 * @环境变量
 *   PKG_GATEWAY_TOKEN   必填,网关上传 Bearer token(项目 CI/CD 变量,masked)
 *   PKG_GATEWAY_BASE    可选,默认 http://10.0.0.1:8090(仅 VPN 内可达)
 *   GitLab(必填,同 publish-release.mjs):
 *     GITLAB_URL / GITLAB_PROJECT_ID / GITLAB_TOKEN
 *
 * @dev 判定与留存
 *   version 含 dev/rc/beta/alpha/nightly → 上传带 ?tag=dev(OSS 生命周期 30 天自动删);
 *   其余为 stable,无标签长期留存。--dev / --stable 可强制覆盖。
 *
 * @退出码
 *   0 = 全部成功(或 dry-run)
 *   1 = 任一文件失败
 *   2 = 参数/环境错误
 *
 * @对应文档
 *   docs/打包发布流程.md §4 GitLab CI;网关详见 Manager 仓库
 *   common/plans/gitlab-packages-gateway.md
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// ============================================================
// 参数
// ============================================================
const args = process.argv.slice(2);
const opts = {
  version: null,
  tag: null,
  destPrefix: null,
  dev: null, // null=自动判定;true/false 为 --dev/--stable 强制
  dryRun: false,
  help: false,
};

for (const a of args) {
  if (a.startsWith('--version=')) opts.version = a.slice('--version='.length);
  else if (a.startsWith('--tag=')) opts.tag = a.slice('--tag='.length);
  else if (a.startsWith('--dest-prefix=')) opts.destPrefix = a.slice('--dest-prefix='.length);
  else if (a === '--dev') opts.dev = true;
  else if (a === '--stable') opts.dev = false;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--help' || a === '-h') opts.help = true;
  else {
    console.error(`[gateway] 未知参数:${a}`);
    process.exit(2);
  }
}

if (opts.help) {
  console.log(`Marina 发布包镜像到包体网关(GitLab Generic Packages → OSS)

用法:
  node scripts/upload-gateway.mjs --version=<v> [--dest-prefix=<p>] [--dev|--stable] [--dry-run]
  node scripts/upload-gateway.mjs --tag=<vX.Y.Z>     (version=X.Y.Z, dest-prefix=marina/vX.Y.Z)

环境变量见 scripts/upload-gateway.mjs 文件头注释。`);
  process.exit(0);
}

// tag 与 version 互相推导;dest-prefix 默认 marina/<tag>
if (!opts.version && opts.tag) opts.version = opts.tag.replace(/^v/, '');
if (!opts.tag && opts.version) opts.tag = `v${opts.version}`;
if (!opts.version) {
  console.error('[gateway] 缺少 --version 或 --tag');
  process.exit(2);
}
if (!opts.destPrefix) opts.destPrefix = `marina/${opts.tag}`;
if (opts.destPrefix.endsWith('/')) opts.destPrefix = opts.destPrefix.replace(/\/+$/, '');

const isDev = opts.dev ?? /(dev|rc|beta|alpha|nightly)/i.test(opts.version);

// ============================================================
// 环境
// ============================================================
const GATEWAY_BASE = (process.env.PKG_GATEWAY_BASE || 'http://10.0.0.1:8090').replace(/\/$/, '');
const GATEWAY_TOKEN = process.env.PKG_GATEWAY_TOKEN || '';
const GITLAB_URL = (process.env.GITLAB_URL || '').replace(/\/$/, '');
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID || '';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';

const missing = [];
if (!GATEWAY_TOKEN) missing.push('PKG_GATEWAY_TOKEN');
if (!GITLAB_URL) missing.push('GITLAB_URL');
if (!GITLAB_PROJECT_ID) missing.push('GITLAB_PROJECT_ID');
if (!GITLAB_TOKEN) missing.push('GITLAB_TOKEN');
if (missing.length) {
  console.error(`[gateway] 环境不完整:缺少 ${missing.join(' / ')}`);
  process.exit(2);
}

const api = `${GITLAB_URL}/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}`;
const glHeaders = { 'PRIVATE-TOKEN': GITLAB_TOKEN };

const info = (m) => console.log(`[gateway] ${m}`);
const warn = (m) => console.warn(`[gateway] ⚠ ${m}`);
const err = (m) => console.error(`[gateway] ✗ ${m}`);

// ============================================================
// 工具
// ============================================================
async function withRetries(label, attempts, fn) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        const wait = i * 2000;
        warn(`${label} 第 ${i} 次失败(${e.message}),${wait / 1000}s 后重试`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/** OSS key 各段单独 URL 编码(filenames 可能含非安全字符)。 */
function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** 网关 HEAD:对象存在返回 { size },不存在返回 null。 */
async function gatewayHead(key) {
  const res = await fetch(`${GATEWAY_BASE}/dl/${encodeKey(key)}`, { method: 'HEAD' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HEAD /dl/${key} -> HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  return { size: len };
}

/** 流式下载到文件,返回 { size, sha256 }。 */
async function downloadToFile(url, headers, destPath) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    Readable.fromWeb(res.body)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .pipe(out)
      .on('error', reject)
      .on('finish', resolve);
  });
  return { size: statSync(destPath).size, sha256: hash.digest('hex') };
}

/**
 * 流式 PUT 到网关。
 * 必须用 node:http + 显式 Content-Length:fetch 的流式 body 走 chunked 编码,
 * 网关返回 411(curl -T 能过正是因为它自动带长度)。文件不进内存,边读边传。
 */
function gatewayPut(key, filePath, size, devTag) {
  const u = new URL(`${GATEWAY_BASE}/up/${encodeKey(key)}${devTag ? '?tag=dev' : ''}`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode);
          else reject(new Error(`PUT ${key} -> HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        });
      }
    );
    req.on('error', reject);
    createReadStream(filePath).pipe(req);
  });
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ============================================================
// 主流程
// ============================================================
const pkgName = 'marina';

info(`镜像 marina@${opts.version} → ${GATEWAY_BASE}/dl/${opts.destPrefix}/ (${isDev ? 'dev,30 天生命周期' : 'stable,长期留存'})`);

// 1) 网关健康预检
const health = await fetch(`${GATEWAY_BASE}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
if (!health || !health.ok) {
  err(`网关不可达:${GATEWAY_BASE}/healthz(VPN 断了?)`);
  process.exit(1);
}

// 2) 列出 GitLab 包文件(name/size/sha256) — 与 publish-release.mjs 同一 API 形状
const listUrl =
  `${api}/packages?package_type=generic&package_name=${encodeURIComponent(pkgName)}` +
  `&package_version=${encodeURIComponent(opts.version)}&per_page=100`;
const files = await withRetries('列包文件', 3, async () => {
  const res = await fetch(listUrl, { headers: glHeaders });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const pkgs = await res.json();
  const out = [];
  for (const p of pkgs) {
    const fr = await fetch(`${api}/packages/${p.id}/package_files?per_page=100`, { headers: glHeaders });
    if (!fr.ok) continue;
    for (const f of await fr.json()) {
      out.push({ name: f.file_name, size: f.size, sha256: f.file_sha256 || '' });
    }
  }
  return out;
});

if (!files.length) {
  err(`GitLab 上 marina@${opts.version} 没有任何包文件 — 先跑 publish:release`);
  process.exit(1);
}
info(`GitLab 包文件 ${files.length} 个:${files.map((f) => f.name).join(', ')}`);

// 3) 逐文件镜像
const tmpDir = mkdtempSync(join(tmpdir(), 'marina-gw-'));
let uploaded = 0;
let skipped = 0;
let failed = 0;

try {
  for (const f of files) {
    const key = `${opts.destPrefix}/${f.name}`;
    const dlUrl = `${api}/packages/generic/${pkgName}/${encodeURIComponent(opts.version)}/${encodeURIComponent(f.name)}`;

    const head = await gatewayHead(key).catch((e) => {
      warn(`HEAD ${key} 异常(${e.message}),按需上传处理`);
      return undefined;
    });
    if (head && head.size === f.size) {
      info(`跳过(远端已存在且 size 一致): ${f.name} ${mb(f.size)}`);
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      info(`[dry-run] 将下载 ${dlUrl} 并上传 → ${key}`);
      uploaded++;
      continue;
    }

    try {
      const t0 = Date.now();
      const dest = join(tmpDir, f.name);
      const dl = await withRetries(`下载 ${f.name}`, 3, () => downloadToFile(dlUrl, glHeaders, dest));
      if (f.sha256 && dl.sha256 !== f.sha256) {
        throw new Error(`sha256 不一致:本地 ${dl.sha256.slice(0, 12)}… vs GitLab ${f.sha256.slice(0, 12)}…`);
      }
      if (dl.size !== f.size) {
        throw new Error(`size 不一致:本地 ${dl.size} vs GitLab ${f.size}`);
      }

      await withRetries(`上传 ${f.name}`, 3, () => gatewayPut(key, dest, f.size, isDev));

      const after = await gatewayHead(key);
      if (!after || after.size !== f.size) {
        throw new Error(`上传后复核失败:远端 size=${after ? after.size : '404'},期望 ${f.size}`);
      }

      const secs = (Date.now() - t0) / 1000;
      info(`已镜像: ${f.name} ${mb(f.size)} in ${secs.toFixed(1)}s(${mb(f.size / secs)}/s)`);
      uploaded++;
    } catch (e) {
      err(`镜像失败: ${f.name} — ${e.message}`);
      failed++;
    }
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// 4) 汇总
info(`完成:上传 ${uploaded} / 跳过 ${skipped} / 失败 ${failed}`);
info(`浏览: ${GATEWAY_BASE}/browse/${opts.destPrefix}`);
info(`下载示例: curl -O ${GATEWAY_BASE}/dl/${opts.destPrefix}/<文件名>`);
process.exit(failed > 0 ? 1 : 0);
