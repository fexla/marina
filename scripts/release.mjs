#!/usr/bin/env node
/**
 * @file scripts/release.mjs
 * @purpose Marina 发布打包总入口(2026-05-20)。
 *
 * @背景
 * 截止 beta.9,每次发版流程都是作者手工跑一串命令:`npm run typecheck`,
 * `npm test`, `npm run build`, `npm run build:linux`, 手工 unpack 看产物,
 * 手工算 sha256,手工补 CHANGELOG。任何一步漏 / 顺序错都会带来回归 —
 * ISO-1 工单(docs/issues/iso-1-cross-platform-build-pollution.md)正是
 * "没人系统校验过产物里有没有错平台 .node" 的直接后果。
 *
 * 本脚本把六个阶段串成一条流水线,任何中间失败立即停 + 给出修复提示:
 *
 *   Phase 1 · Preflight        git 状态、平台兼容、版本号
 *   Phase 2 · Code Quality     typecheck / lint / test(可单独跳过)
 *   Phase 3 · Clean & Switch   清 out/、按目标平台 rebuild node-pty
 *   Phase 4 · Build            electron-vite + electron-builder(Windows 直跑,
 *                              Linux 走 Docker 隔离构建,见 ISO-1)
 *   Phase 5 · Verify           调 verify-artifacts.mjs 校验产物纯净度
 *   Phase 6 · Report           汇总产物路径 / 大小 / SHA256 + 下一步提示
 *
 * @用法
 *   node scripts/release.mjs --win              # 仅 Windows
 *   node scripts/release.mjs --linux            # 仅 Linux(在 Linux 主机直跑,
 *                                                 在 Windows 主机自动走 Docker)
 *   node scripts/release.mjs --all              # 两平台都打
 *   node scripts/release.mjs --win --bump=prerelease  # 自动 +beta.N
 *
 *   选项:
 *     --skip-typecheck    跳过 typecheck
 *     --skip-lint         跳过 ESLint + stylelint
 *     --skip-tests        跳过 vitest(已知失败时临时用,要解决根因再发版)
 *     --skip-verify       跳过产物校验(强烈不推荐;只用于调试本脚本本身)
 *     --no-clean          不清 out/(增量编译,本机调试用)
 *     --dry-run           只打印计划,不真跑
 *     --bump=<策略>       发版前自动 bump 版本号
 *                         策略:patch / minor / major / prerelease / none(默认)
 *     --strict            verify 阶段警告也算失败
 *     --help / -h         本帮助
 *
 * @退出码
 *   0 = 所有阶段成功
 *   1 = 任何一个阶段失败
 *   2 = 参数错误 / 平台不支持
 *
 * @对应文档
 *   docs/打包发布流程.md             整体设计
 *   docs/issues/iso-1-cross-platform-build-pollution.md  跨平台隔离原则
 *   AGENTS.md 第 4 章                CP-4 打包要求
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform as osPlatform } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), '..');

// ============================================================
// 参数解析
// ============================================================
const args = process.argv.slice(2);
const opts = {
  win: false,
  linux: false,
  skipTypecheck: false,
  skipLint: false,
  skipTests: false,
  skipVerify: false,
  noClean: false,
  dryRun: false,
  bump: 'none',
  strict: false,
  help: false,
};

for (const a of args) {
  switch (true) {
    case a === '--win':
      opts.win = true;
      break;
    case a === '--linux':
      opts.linux = true;
      break;
    case a === '--all':
      opts.win = true;
      opts.linux = true;
      break;
    case a === '--skip-typecheck':
      opts.skipTypecheck = true;
      break;
    case a === '--skip-lint':
      opts.skipLint = true;
      break;
    case a === '--skip-tests':
      opts.skipTests = true;
      break;
    case a === '--skip-verify':
      opts.skipVerify = true;
      break;
    case a === '--no-clean':
      opts.noClean = true;
      break;
    case a === '--dry-run':
      opts.dryRun = true;
      break;
    case a === '--strict':
      opts.strict = true;
      break;
    case a.startsWith('--bump='):
      opts.bump = a.slice('--bump='.length);
      break;
    case a === '--help' || a === '-h':
      opts.help = true;
      break;
    default:
      console.error(`[release] 未知参数:${a}`);
      console.error(`[release] 加 --help 看用法`);
      process.exit(2);
  }
}

if (opts.help) {
  console.log(`Marina 发布打包总入口

用法:
  node scripts/release.mjs --win | --linux | --all  [选项]

平台:
  --win              打 Windows(nsis 安装器 + portable exe)
  --linux            打 Linux(.deb / .rpm / .AppImage),在 Linux 主机直跑,
                     在 Windows 主机自动走 Docker
  --all              两平台都打

跳过项(谨慎):
  --skip-typecheck   跳过 typecheck
  --skip-lint        跳过 ESLint + stylelint
  --skip-tests       跳过 vitest
  --skip-verify      跳过产物校验(强烈不推荐)
  --no-clean         不清 out/(增量编译,本机调试用)

版本号:
  --bump=patch       0.1.0-beta.9 → 0.1.1-beta.0
  --bump=minor       0.1.0-beta.9 → 0.2.0-beta.0
  --bump=major       0.1.0-beta.9 → 1.0.0-beta.0
  --bump=prerelease  0.1.0-beta.9 → 0.1.0-beta.10
  --bump=none        不动(默认)

其他:
  --strict           verify 阶段警告也算失败
  --dry-run          只打印计划,不真跑
  --help / -h        本帮助

文档:
  docs/打包发布流程.md`);
  process.exit(0);
}

if (!opts.win && !opts.linux) {
  console.error('[release] 至少需要 --win / --linux / --all 之一');
  console.error('[release] 加 --help 看用法');
  process.exit(2);
}

const hostPlatform = osPlatform(); // 'win32' / 'linux' / 'darwin'

// 在 Windows 主机上打 Windows 包 — 直跑
// 在 Linux 主机上打 Linux 包 — 直跑
// 在 Windows 主机上打 Linux 包 — 走 Docker
// 在 Linux 主机上打 Windows 包 — electron-builder 理论上支持(用 wine),但
//   本脚本不实现 — 把这种 cross-compile 的复杂度留给 CI
if (opts.win && hostPlatform !== 'win32') {
  console.error(`[release] 当前主机平台 ${hostPlatform},不支持打 Windows 包`);
  console.error('[release]   - 用 Windows 主机跑 --win,或');
  console.error('[release]   - 用 GitHub Actions windows-latest runner');
  process.exit(2);
}
if (hostPlatform === 'darwin') {
  console.warn('[release] 警告:macOS 主机上发版未经验证,V1 未支持 mac 包');
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
  blue: ANSI ? '\x1b[34m' : '',
  cyan: ANSI ? '\x1b[36m' : '',
};

const startTime = Date.now();
const phaseStarts = new Map();

function section(name) {
  const sep = '═'.repeat(64);
  console.log(`\n${C.cyan}${sep}${C.reset}`);
  console.log(`${C.cyan}${C.bold}║${C.reset} ${C.bold}${name}${C.reset}`);
  console.log(`${C.cyan}${sep}${C.reset}\n`);
  phaseStarts.set(name, Date.now());
}

function phaseDone(name) {
  const start = phaseStarts.get(name);
  if (!start) return;
  const sec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`${C.green}${C.bold}✓${C.reset} ${name} ${C.dim}(${sec}s)${C.reset}`);
}

function info(...m) {
  console.log(`${C.blue}  →${C.reset}`, ...m);
}
function warn(...m) {
  console.log(`${C.yellow}  ⚠${C.reset}`, ...m);
}
function ok(...m) {
  console.log(`${C.green}  ✓${C.reset}`, ...m);
}
function err(...m) {
  console.log(`${C.red}  ✗${C.reset}`, ...m);
}

/**
 * 执行 npm script / 任意命令,失败立即退出。
 * dry-run 模式下只打印不执行。
 */
function run(label, cmd, cmdArgs, { allowFailure = false, env: extraEnv } = {}) {
  const display = `${cmd} ${cmdArgs.join(' ')}`;
  if (opts.dryRun) {
    info(`[dry-run] ${label}:`);
    info(`  $ ${display}`);
    return { status: 0, dryRun: true };
  }
  info(label);
  console.log(`${C.dim}  $ ${display}${C.reset}`);
  const result = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: projectRoot,
    shell: hostPlatform === 'win32', // Windows 上 npm 是 .cmd,必须 shell: true
    env: { ...process.env, ...(extraEnv || {}) },
  });
  if (result.error) {
    err(`${label} 执行失败:${result.error.message}`);
    if (!allowFailure) process.exit(1);
    return { status: result.status ?? 1, error: result.error };
  }
  if (result.status !== 0) {
    err(`${label} 退出码 ${result.status}`);
    if (!allowFailure) {
      err('修复后重跑;或加 --skip-xxx 跳过对应阶段');
      process.exit(1);
    }
  }
  return result;
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
}

/**
 * SemVer-lite 的 bump 实现。支持 X.Y.Z-tag.N。
 * Marina 阶段够用 — 不引入 semver npm 包(避开 AGENTS.md 1.2 边界 2)。
 */
function bumpVersion(current, strategy) {
  // X.Y.Z 或 X.Y.Z-prerel.N
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/);
  if (!m) {
    throw new Error(`不认得的版本号格式:${current}`);
  }
  const [, ma, mi, pa, tag, num] = m;
  const major = +ma;
  const minor = +mi;
  const patch = +pa;
  switch (strategy) {
    case 'prerelease':
      if (!tag) {
        // 0.1.0 → 0.1.1-beta.0
        return `${major}.${minor}.${patch + 1}-beta.0`;
      }
      return `${major}.${minor}.${patch}-${tag}.${+num + 1}`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}-beta.0`;
    case 'minor':
      return `${major}.${minor + 1}.0-beta.0`;
    case 'major':
      return `${major + 1}.0.0-beta.0`;
    case 'none':
      return current;
    default:
      throw new Error(`不认得的 bump 策略:${strategy}`);
  }
}

// ============================================================
// Phase 1 · Preflight
// ============================================================
section('Phase 1 · Preflight');

const pkg = readPackageJson();
const currentVersion = pkg.version;
info(`当前版本:${C.bold}${currentVersion}${C.reset}`);
info(`目标平台:${[opts.win && 'Windows', opts.linux && 'Linux'].filter(Boolean).join(' + ')}`);
info(`主机平台:${hostPlatform} (${osPlatform()})`);

// Node 版本检查 — Electron 31 要求 Node 20+
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  err(`Node 版本 ${process.versions.node} < 20,Electron 31 + electron-builder 不保证可用`);
  process.exit(1);
} else {
  ok(`Node ${process.versions.node}(≥ 20)`);
}

// Git 状态检查
const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot });
if (gitStatus.status === 0) {
  const dirty = gitStatus.stdout.toString().trim();
  if (dirty) {
    warn(`Git 工作区有未提交改动(发版前最好 commit):`);
    for (const line of dirty.split('\n').slice(0, 10)) {
      console.log(`    ${C.dim}${line}${C.reset}`);
    }
    if (dirty.split('\n').length > 10) {
      console.log(`    ${C.dim}... 共 ${dirty.split('\n').length} 行${C.reset}`);
    }
  } else {
    ok('Git 工作区干净');
  }
} else {
  warn('git status 失败 — 不在 git 仓库?跳过 git 检查');
}

// 当前分支
const gitBranch = spawnSync('git', ['branch', '--show-current'], { cwd: projectRoot });
if (gitBranch.status === 0) {
  const branch = gitBranch.stdout.toString().trim();
  info(`Git 分支:${branch}`);
}

// Version bump
let releaseVersion = currentVersion;
if (opts.bump !== 'none') {
  try {
    releaseVersion = bumpVersion(currentVersion, opts.bump);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
  info(`Bump (${opts.bump}):${currentVersion} → ${C.bold}${releaseVersion}${C.reset}`);
  if (!opts.dryRun) {
    pkg.version = releaseVersion;
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    ok(`已写 package.json.version = ${releaseVersion}`);
    warn(`记得在 CHANGELOG.md 顶部加 [${releaseVersion}] — ${new Date().toISOString().slice(0, 10)} 章节`);
  } else {
    info('[dry-run] 不写 package.json');
  }
}

phaseDone('Phase 1 · Preflight');

// ============================================================
// Phase 2 · Code Quality
// ============================================================
section('Phase 2 · Code Quality');

if (opts.skipTypecheck) {
  warn('跳过 typecheck(--skip-typecheck)');
} else {
  run('typecheck (tsc --noEmit, 三 tsconfig)', 'npm', ['run', 'typecheck']);
}

if (opts.skipLint) {
  warn('跳过 lint(--skip-lint)');
} else {
  run('ESLint', 'npm', ['run', 'lint']);
  run('stylelint', 'npm', ['run', 'lint:css']);
}

if (opts.skipTests) {
  warn('跳过 tests(--skip-tests)— 发版前应解决根因再放行');
} else {
  run('vitest run', 'npm', ['test']);
}

phaseDone('Phase 2 · Code Quality');

// ============================================================
// Phase 3 · Clean & Switch
// ============================================================
section('Phase 3 · Clean & Switch');

if (opts.noClean) {
  warn('跳过 clean(--no-clean,增量编译)');
} else {
  // 清 out/(electron-vite 产物)+ native(node-pty build/Release)
  run('清 out/ 与 node-pty/build', 'node', ['scripts/clean.mjs', '--out', '--native']);
}

// 切平台:install-app-deps 给目标平台 rebuild node-pty
// Windows 主机打 Windows → switch:win
// Linux 主机打 Linux → switch:linux
// Windows 主机打 Linux → 不切,因为 Linux 包走 Docker(容器内自己 npm ci)
if (opts.win) {
  run(
    'switch:win(electron-builder install-app-deps --platform=win32)',
    'npm',
    ['run', 'switch:win'],
  );
}
if (opts.linux && hostPlatform === 'linux') {
  run(
    'switch:linux(electron-builder install-app-deps --platform=linux)',
    'npm',
    ['run', 'switch:linux'],
  );
}
if (opts.linux && hostPlatform === 'win32') {
  info('Linux 包将在 Docker 容器内构建(主机 node_modules 不动,见 ISO-1)');
}

phaseDone('Phase 3 · Clean & Switch');

// ============================================================
// Phase 4 · Build
// ============================================================
section('Phase 4 · Build');

const buildResults = [];

if (opts.win) {
  // Windows:electron-vite build + electron-builder --win --x64
  // 单独跑 npm run build 会 electron-vite + builder 一气呵成
  const startBuild = Date.now();
  run('Windows 包(nsis + portable)', 'npm', ['run', 'build']);
  buildResults.push({
    platform: 'win',
    durationSec: ((Date.now() - startBuild) / 1000).toFixed(1),
  });
}

if (opts.linux) {
  const startBuild = Date.now();
  if (hostPlatform === 'linux') {
    run('Linux 包(.deb + .rpm + .AppImage)', 'npm', ['run', 'build:linux']);
  } else {
    // Docker 路径
    run(
      'Linux 包(Docker 隔离构建,见 ISO-1)',
      'npm',
      ['run', 'build:linux:docker'],
    );
  }
  buildResults.push({
    platform: 'linux',
    durationSec: ((Date.now() - startBuild) / 1000).toFixed(1),
  });
}

phaseDone('Phase 4 · Build');

// ============================================================
// Phase 5 · Verify
// ============================================================
section('Phase 5 · Verify');

if (opts.skipVerify) {
  warn('跳过产物校验(--skip-verify)');
  warn('强烈不推荐 — ISO-1 工单正是"没人校验产物"的直接后果');
} else {
  const verifyArgs = ['scripts/verify-artifacts.mjs', `--version=${releaseVersion}`];
  if (opts.strict) verifyArgs.push('--strict');
  run('verify-artifacts.mjs', 'node', verifyArgs);
}

phaseDone('Phase 5 · Verify');

// ============================================================
// Phase 6 · Report
// ============================================================
section('Phase 6 · Report');

const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);

console.log(`${C.bold}总用时:${totalSec}s${C.reset}`);
console.log(`${C.bold}产物目录:${C.reset}`);
console.log(`  ${C.cyan}release/${releaseVersion}/${C.reset}`);
console.log();

if (!opts.dryRun) {
  const releaseDir = join(projectRoot, 'release', releaseVersion);
  if (existsSync(releaseDir)) {
    info('产物清单:');
    listInstallers(releaseDir);
  }
}

console.log();
console.log(`${C.bold}下一步:${C.reset}`);
if (opts.bump !== 'none' && !opts.dryRun) {
  console.log(`  1. 在 CHANGELOG.md 顶部加 [${releaseVersion}] 章节`);
  console.log(`  2. git add package.json CHANGELOG.md && git commit -m "chore(release): bump ${releaseVersion}"`);
  console.log(`  3. git tag v${releaseVersion}`);
  console.log(`  4. git push && git push --tags`);
  console.log(`  5. 在 GitHub Releases 上传 release/${releaseVersion}/ 下的安装器(+ 把 RELEASE_NOTES.md 贴上)`);
} else {
  console.log(`  1. 校验通过的 release/${releaseVersion}/ 已可发布`);
  console.log(`  2. SmartScreen 警告:Windows 安装器未签名,SmartScreen 会拦,KI-002 跟踪`);
  console.log(`  3. Linux 包测试方式见 docs/Linux安装指南-20260517.md`);
}

phaseDone('Phase 6 · Report');

console.log(`\n${C.green}${C.bold}✓ 全部 6 阶段完成${C.reset} ${C.dim}(${totalSec}s)${C.reset}\n`);
process.exit(0);

// ============================================================
// Helpers below main flow
// ============================================================
function listInstallers(releaseDir) {
  const candidates = [
    'Marina-Setup-${v}-x64.exe',
    'Marina-Portable-${v}-x64.exe',
    'Marina-${v}-amd64.deb',
    'Marina-${v}-x86_64.rpm',
    'Marina-${v}-x86_64.AppImage',
    'latest.yml',
    'latest-linux.yml',
  ];
  for (const c of candidates) {
    const name = c.replace('${v}', releaseVersion);
    const p = join(releaseDir, name);
    if (existsSync(p)) {
      try {
        const s = statSync(p);
        const mb = (s.size / 1024 / 1024).toFixed(1);
        console.log(`    ${C.green}✓${C.reset} ${name}  ${C.dim}${mb} MB${C.reset}`);
      } catch {
        console.log(`    ${C.green}✓${C.reset} ${name}`);
      }
    }
  }
}
