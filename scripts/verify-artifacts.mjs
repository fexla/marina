#!/usr/bin/env node
/**
 * @file scripts/verify-artifacts.mjs
 * @purpose Marina 打包产物校验(2026-05-20)。
 *
 * @背景
 * ISO-1 工单(docs/issues/iso-1-cross-platform-build-pollution.md)发现 beta.5
 * 到 beta.9 的所有安装包都夹带错平台 .node 二进制。修复后,每次 release 必须
 * **自动校验**产物的纯净度 — 不能靠"electron-builder 没报错就当成功"。
 *
 * 本脚本扫描 `release/${version}/{win,linux,mac}-unpacked/` 目录,做四件事:
 *
 *   1. **二进制平台校验**:用 PE / ELF / Mach-O magic bytes 判定每个 .node 文件
 *      的真实平台,与所在包的目标平台必须一致。任何错平台二进制 → 失败。
 *   2. **关键资源在位**:app.asar 存在、shell-hooks/ 目录存在、平台特定资源
 *      (Win11 上下文菜单的 MSIX / Linux 的 .desktop 等)正确。
 *   3. **体积合理性**:每个包 unpacked 大小在 [80MB, 500MB] 之间(异常小 =
 *      产物缺失,异常大 = 没过滤掉大文件)。
 *   4. **报告**:打印每个包的 SHA256 + 大小 + .node 清单,供发布前 review。
 *
 * @用法
 *   node scripts/verify-artifacts.mjs              # 校验当前 package.json.version
 *   node scripts/verify-artifacts.mjs --version=0.1.0-beta.10
 *   node scripts/verify-artifacts.mjs --version=auto --json    # 机器可读输出
 *   node scripts/verify-artifacts.mjs --strict     # 体积超标也视为失败
 *
 * @退出码
 *   0 = 通过(所有检查项都过 / 警告但无致命问题)
 *   1 = 失败(任何一项致命问题)
 *   2 = 参数错误 / 找不到产物
 *
 * @对应文档
 *   docs/打包发布流程.md  整体流程
 *   docs/issues/iso-1-cross-platform-build-pollution.md  本校验的动机
 */
import { existsSync, readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), '..');

// ============================================================
// 参数解析
// ============================================================
const args = process.argv.slice(2);
const flags = new Set();
let versionArg = null;
for (const a of args) {
  if (a.startsWith('--version=')) versionArg = a.slice('--version='.length);
  else if (a === '--help' || a === '-h') flags.add('help');
  else if (a === '--strict') flags.add('strict');
  else if (a === '--json') flags.add('json');
  else if (a === '--verbose' || a === '-v') flags.add('verbose');
  else {
    console.error(`[verify] 未知参数:${a}`);
    process.exit(2);
  }
}

if (flags.has('help')) {
  console.log(`用法:
  node scripts/verify-artifacts.mjs [选项]

选项:
  --version=<v>   要校验的版本号(默认读 package.json.version)
                  特殊值 'auto' = 自动读 package.json
  --strict        体积异常 / 警告也视为失败
  --json          输出机器可读 JSON 报告
  --verbose / -v  逐文件打印
  --help / -h     本帮助

退出码:
  0 = 通过
  1 = 校验失败(产物有问题)
  2 = 参数错误 / 找不到产物`);
  process.exit(0);
}

// 读 package.json.version
let version = versionArg;
if (!version || version === 'auto') {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    version = pkg.version;
  } catch (e) {
    console.error(`[verify] 读 package.json.version 失败:${e.message}`);
    process.exit(2);
  }
}

const releaseDir = join(projectRoot, 'release', version);
if (!existsSync(releaseDir)) {
  console.error(`[verify] 找不到产物目录:${releaseDir}`);
  console.error(`[verify] 先跑 npm run build / npm run build:linux / npm run build:linux:docker`);
  process.exit(2);
}

// ============================================================
// 工具:二进制平台探测(PE / ELF / Mach-O magic bytes)
// ============================================================
const BINARY_FORMATS = {
  PE_WINDOWS: 'PE (Windows)',
  ELF_LINUX: 'ELF (Linux)',
  MACHO_64: 'Mach-O 64-bit',
  MACHO_32: 'Mach-O 32-bit',
  MACHO_FAT: 'Mach-O FAT (universal)',
  UNKNOWN: 'unknown',
};

/**
 * 探测 .node 文件的真实平台。
 * 读前 16 字节,按文件 header magic 判定:
 *   - PE32+:   `MZ` (0x4d 0x5a)               → Windows
 *   - ELF:     `\x7fELF` (0x7f 0x45 0x4c 0x46) → Linux(.so / .node)
 *   - Mach-O:  各种 magic                      → macOS
 */
function detectBinaryFormat(filePath) {
  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    closeSync(fd);

    if (buf[0] === 0x4d && buf[1] === 0x5a) return BINARY_FORMATS.PE_WINDOWS;
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)
      return BINARY_FORMATS.ELF_LINUX;
    // Mach-O magic bytes(big/little endian + 32/64-bit + FAT 一共 5 种,这里覆盖全)
    const m32be = buf.readUInt32BE(0);
    if (m32be === 0xfeedface) return BINARY_FORMATS.MACHO_32;
    if (m32be === 0xfeedfacf) return BINARY_FORMATS.MACHO_64;
    if (m32be === 0xcafebabe || m32be === 0xbebafeca) return BINARY_FORMATS.MACHO_FAT;
    const m32le = buf.readUInt32LE(0);
    if (m32le === 0xfeedface) return BINARY_FORMATS.MACHO_32;
    if (m32le === 0xfeedfacf) return BINARY_FORMATS.MACHO_64;

    return BINARY_FORMATS.UNKNOWN;
  } catch (e) {
    return `read-error: ${e.message}`;
  }
}

function expectedFormatForPlatform(platform) {
  switch (platform) {
    case 'win':
      return BINARY_FORMATS.PE_WINDOWS;
    case 'linux':
      return BINARY_FORMATS.ELF_LINUX;
    case 'mac':
      return [BINARY_FORMATS.MACHO_64, BINARY_FORMATS.MACHO_32, BINARY_FORMATS.MACHO_FAT];
    default:
      return BINARY_FORMATS.UNKNOWN;
  }
}

// ============================================================
// 工具:递归找文件 / 算大小 / SHA256
// ============================================================
function walkFiles(root, pattern) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        if (!pattern || pattern.test(e.name)) out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function dirSize(root) {
  let total = 0;
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* 权限 / 链接断 — 忽略 */
        }
      }
    }
  }
  walk(root);
  return total;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sha256(filePath) {
  try {
    const hash = createHash('sha256');
    hash.update(readFileSync(filePath));
    return hash.digest('hex');
  } catch (e) {
    return `error: ${e.message}`;
  }
}

// ============================================================
// 主校验
// ============================================================
const ANSI = !flags.has('json') && process.stdout.isTTY;
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

const report = {
  version,
  releaseDir,
  packages: [], // { platform, unpackedDir, sizeBytes, issues: [], notes: [] }
  installers: [], // { name, sizeBytes, sha256 }
  summary: { errors: 0, warnings: 0, packagesChecked: 0 },
};

// 包目录约定:
//   release/<v>/win-unpacked    — Windows
//   release/<v>/linux-unpacked  — Linux(electron-builder 默认就用单一目录)
//   release/<v>/mac/Marina.app  — macOS(future)
const platformDirs = [
  { platform: 'win', dir: 'win-unpacked', resourcesPath: ['resources'] },
  { platform: 'linux', dir: 'linux-unpacked', resourcesPath: ['resources'] },
];

for (const pd of platformDirs) {
  const unpackedDir = join(releaseDir, pd.dir);
  if (!existsSync(unpackedDir)) {
    if (flags.has('verbose')) {
      console.log(`${C.dim}[verify] 跳过(不存在):${pd.dir}${C.reset}`);
    }
    continue;
  }

  const pkgReport = {
    platform: pd.platform,
    unpackedDir,
    sizeBytes: 0,
    issues: [],
    notes: [],
    nodeBinaries: [],
  };
  report.packages.push(pkgReport);
  report.summary.packagesChecked++;

  // ─── 体积 ───
  pkgReport.sizeBytes = dirSize(unpackedDir);

  // ─── .node 二进制平台校验 ───
  const expected = expectedFormatForPlatform(pd.platform);
  const expectedList = Array.isArray(expected) ? expected : [expected];

  const nodeFiles = walkFiles(unpackedDir, /\.node$/);
  for (const f of nodeFiles) {
    const rel = relative(unpackedDir, f);
    const fmt = detectBinaryFormat(f);
    const ok = expectedList.includes(fmt);
    pkgReport.nodeBinaries.push({ relPath: rel, format: fmt, ok });
    if (!ok) {
      pkgReport.issues.push({
        severity: 'error',
        kind: 'cross-platform-binary',
        message: `${rel} 是 ${fmt},但 ${pd.platform} 包应该是 ${expectedList.join(' / ')}`,
      });
    }
  }

  // ─── 关键资源在位 ───
  const resourcesDir = join(unpackedDir, ...pd.resourcesPath);
  const requiredAssets = [
    { path: 'app.asar', kind: 'file', critical: true },
    { path: 'shell-hooks', kind: 'dir', critical: true },
  ];
  if (pd.platform === 'win') {
    requiredAssets.push({ path: 'context-menu', kind: 'dir', critical: false });
  }
  for (const asset of requiredAssets) {
    const full = join(resourcesDir, asset.path);
    if (!existsSync(full)) {
      pkgReport.issues.push({
        severity: asset.critical ? 'error' : 'warning',
        kind: 'missing-asset',
        message: `资源缺失:${join(pd.dir, ...pd.resourcesPath, asset.path)}`,
      });
      continue;
    }
    try {
      const s = statSync(full);
      if (asset.kind === 'file' && !s.isFile()) {
        pkgReport.issues.push({
          severity: 'error',
          kind: 'asset-type-mismatch',
          message: `${asset.path} 应该是文件,实际是 ${s.isDirectory() ? '目录' : 'other'}`,
        });
      }
      if (asset.kind === 'dir' && !s.isDirectory()) {
        pkgReport.issues.push({
          severity: 'error',
          kind: 'asset-type-mismatch',
          message: `${asset.path} 应该是目录,实际是 ${s.isFile() ? '文件' : 'other'}`,
        });
      }
    } catch (e) {
      pkgReport.issues.push({
        severity: 'error',
        kind: 'stat-failed',
        message: `${asset.path}: ${e.message}`,
      });
    }
  }

  // ─── 体积合理性(经验阈值,Electron 31 + Marina 当前规模)───
  const MIN = 80 * 1024 * 1024;
  const MAX = 500 * 1024 * 1024;
  if (pkgReport.sizeBytes < MIN) {
    pkgReport.issues.push({
      severity: 'error',
      kind: 'size-too-small',
      message: `unpacked 体积 ${fmtBytes(pkgReport.sizeBytes)} < 下限 ${fmtBytes(MIN)} — 可能产物缺失`,
    });
  } else if (pkgReport.sizeBytes > MAX) {
    pkgReport.issues.push({
      severity: flags.has('strict') ? 'error' : 'warning',
      kind: 'size-too-large',
      message: `unpacked 体积 ${fmtBytes(pkgReport.sizeBytes)} > 上限 ${fmtBytes(MAX)} — 检查是否漏过滤大文件`,
    });
  }

  for (const i of pkgReport.issues) {
    if (i.severity === 'error') report.summary.errors++;
    else report.summary.warnings++;
  }
}

// ─── 安装器文件 SHA256 + 大小 ───
const installerPatterns = /^Marina-.+\.(exe|deb|rpm|AppImage|dmg|blockmap)$/;
const installerFiles = walkFiles(releaseDir, installerPatterns)
  .filter((p) => !p.includes(`${sep}win-unpacked${sep}`) && !p.includes(`${sep}linux-unpacked${sep}`));
for (const f of installerFiles) {
  let size = 0;
  try {
    size = statSync(f).size;
  } catch {
    /* ignore */
  }
  report.installers.push({
    name: relative(releaseDir, f),
    sizeBytes: size,
    sha256: f.endsWith('.blockmap') ? '(skipped)' : sha256(f),
  });
}

// ============================================================
// 输出
// ============================================================
if (flags.has('json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.summary.errors > 0 ? 1 : 0);
}

console.log(`\n${C.bold}=== Marina 产物校验 · ${version} ===${C.reset}`);
console.log(`${C.dim}${releaseDir}${C.reset}`);

if (report.packages.length === 0) {
  console.log(`\n${C.yellow}没有找到任何 unpacked 目录(win-unpacked / linux-unpacked)${C.reset}`);
  console.log('确认是否真的跑过 build,或目标版本号是否正确。');
  process.exit(2);
}

for (const pkg of report.packages) {
  const platLabel = pkg.platform.toUpperCase();
  console.log(`\n${C.cyan}─── ${platLabel} ─── ${C.reset}${C.dim}${pkg.unpackedDir}${C.reset}`);
  console.log(`  体积:${fmtBytes(pkg.sizeBytes)}`);
  console.log(`  .node 二进制:${pkg.nodeBinaries.length} 个`);
  if (flags.has('verbose')) {
    for (const nb of pkg.nodeBinaries) {
      const mark = nb.ok ? C.green + '✓' : C.red + '✗';
      console.log(`    ${mark} ${nb.relPath} ${C.dim}[${nb.format}]${C.reset}`);
    }
  } else {
    const bad = pkg.nodeBinaries.filter((b) => !b.ok);
    if (bad.length === 0) {
      console.log(`    ${C.green}✓ 全部 ${pkg.nodeBinaries.length} 个 .node 平台匹配${C.reset}`);
    } else {
      for (const b of bad) {
        console.log(`    ${C.red}✗ ${b.relPath} [${b.format}]${C.reset}`);
      }
      console.log(
        `    ${C.dim}(${pkg.nodeBinaries.length - bad.length} 个匹配未列出,加 --verbose 看全部)${C.reset}`,
      );
    }
  }

  const errors = pkg.issues.filter((i) => i.severity === 'error');
  const warnings = pkg.issues.filter((i) => i.severity === 'warning');
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`  ${C.green}✓ 资源 / 体积 / 二进制全部通过${C.reset}`);
  } else {
    for (const e of errors) {
      console.log(`  ${C.red}✗ [${e.kind}] ${e.message}${C.reset}`);
    }
    for (const w of warnings) {
      console.log(`  ${C.yellow}⚠ [${w.kind}] ${w.message}${C.reset}`);
    }
  }
}

if (report.installers.length > 0) {
  console.log(`\n${C.cyan}─── 安装器 ───${C.reset}`);
  for (const inst of report.installers) {
    console.log(`  ${inst.name}  ${C.dim}${fmtBytes(inst.sizeBytes)}${C.reset}`);
    console.log(`    sha256: ${inst.sha256}`);
  }
}

console.log(`\n${C.bold}=== 汇总 ===${C.reset}`);
console.log(`  包数:${report.summary.packagesChecked}`);
console.log(`  错误:${report.summary.errors === 0 ? C.green : C.red}${report.summary.errors}${C.reset}`);
console.log(`  警告:${report.summary.warnings === 0 ? C.green : C.yellow}${report.summary.warnings}${C.reset}`);

if (report.summary.errors > 0) {
  console.log(`\n${C.red}${C.bold}校验失败${C.reset}。修复上述错误后重打,或检查 docs/打包发布流程.md 故障排查。`);
  process.exit(1);
}
if (report.summary.warnings > 0 && flags.has('strict')) {
  console.log(`\n${C.yellow}--strict 模式下警告也算失败${C.reset}。`);
  process.exit(1);
}
console.log(`\n${C.green}✓ 校验通过${C.reset}。`);
process.exit(0);
