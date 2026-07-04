#!/usr/bin/env node
/**
 * @file scripts/clean.mjs
 * @purpose 跨平台清理工具(ISO-1,2026-05-20)。
 *
 * @背景
 * Marina 单仓在 Windows / Linux 之间切换开发或构建时,会在 node_modules/
 * 与 out/ / release/ 留下上一个平台的残留:
 *
 *   1. node_modules/node-pty/build/Release/pty.node  ← install-app-deps
 *      产物,每次切平台必须 rebuild。上一个平台的 .node 不删会被新平台
 *      的 electron-builder 误带进包(见 docs/issues/iso-1-...md)
 *   2. out/{main,preload,renderer}/                 ← electron-vite 编译
 *      产物,平台无关但带平台特定的 build commit 元数据
 *   3. release/${version}/{win,linux}-unpacked/      ← electron-builder
 *      产物,平台特定
 *
 * 此脚本提供跨 Windows PowerShell / Linux bash 一致的清理入口,避免在
 * package.json 里写两套 `rm -rf` / `Remove-Item` 命令。
 *
 * @用法
 *   node scripts/clean.mjs --native     # 清 node-pty/build,准备切平台
 *   node scripts/clean.mjs --out        # 清 out/(electron-vite 产物)
 *   node scripts/clean.mjs --release    # 清 release/(electron-builder 产物)
 *   node scripts/clean.mjs --cache      # 清 .vite/ / coverage/ / 其他缓存
 *   node scripts/clean.mjs --all        # 上面全部 + node_modules/.cache
 *
 *   可组合:--native --out 一起跑
 *
 *   --dry-run / -n  打印将删的路径但不真删
 *   --verbose / -v  逐路径打印
 *
 * @退出码
 *   0 = 成功(包括"什么都没删"的情况,例如目录本就不存在)
 *   1 = 参数错误 / 不在项目根目录
 *
 * @对应文档
 *   docs/issues/iso-1-cross-platform-build-pollution.md
 */
import { existsSync, rmSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// 验证我们真的在项目根目录里(避免 cwd 漂移误删)
if (!existsSync(join(projectRoot, 'package.json'))) {
  console.error(`[clean] 致命:projectRoot=${projectRoot} 下没 package.json,拒绝继续`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || args.has('-n');
const verbose = args.has('--verbose') || args.has('-v');
args.delete('--dry-run');
args.delete('-n');
args.delete('--verbose');
args.delete('-v');

const validFlags = ['--native', '--out', '--release', '--cache', '--all'];
if (args.size === 0) {
  console.error('[clean] 至少需要一个动作标志:');
  for (const f of validFlags) console.error(`  ${f}`);
  console.error('  --dry-run / -n  只打印不删');
  console.error('  --verbose / -v  逐路径打印');
  process.exit(1);
}

for (const a of args) {
  if (!validFlags.includes(a)) {
    console.error(`[clean] 未知参数:${a}`);
    console.error(`  合法:${validFlags.join(' / ')}`);
    process.exit(1);
  }
}

const wantAll = args.has('--all');
const wantNative = wantAll || args.has('--native');
const wantOut = wantAll || args.has('--out');
const wantRelease = wantAll || args.has('--release');
const wantCache = wantAll || args.has('--cache');

const targets = [];

if (wantNative) {
  // node-pty 的本地编译产物 — 跨平台切换必须删。
  // 注意只删 build/(install-app-deps 产物),不删 prebuilds/(上游内置预编译)。
  targets.push({
    path: 'node_modules/node-pty/build',
    reason: 'node-pty 本地编译产物(跨平台切换前必删)',
  });
  // electron rebuild 缓存
  targets.push({
    path: 'node_modules/.cache',
    reason: 'node_modules 内部缓存(electron-rebuild 等)',
  });
}

if (wantOut) {
  targets.push({ path: 'out', reason: 'electron-vite 产物' });
}

if (wantRelease) {
  // release/ 下按版本号分目录,我们只清当前 package.json 里的版本号,避免
  // 误删旧版本归档(用户可能想回滚比对)。
  let currentVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    currentVersion = pkg.version;
  } catch {
    // 读不到 package.json.version 就保守地什么都不删,保留旧版本归档
  }
  if (currentVersion !== 'unknown') {
    targets.push({
      path: `release/${currentVersion}`,
      reason: `当前版本(${currentVersion})的 electron-builder 产物`,
    });
  } else {
    console.warn('[clean] 警告:读不到 package.json.version,跳过 release/ 清理(旧版本归档保留)');
  }
}

if (wantCache) {
  targets.push({ path: '.vite', reason: 'vite cache' });
  targets.push({ path: 'coverage', reason: 'vitest coverage 报告' });
  targets.push({ path: '.electron-builder.cache', reason: 'electron-builder cache' });
}

let removedCount = 0;
let skippedCount = 0;

for (const t of targets) {
  const fullPath = join(projectRoot, t.path);
  if (!existsSync(fullPath)) {
    if (verbose) console.log(`[clean] 跳过(不存在):${t.path}`);
    skippedCount++;
    continue;
  }

  // 算一下要删的大小,给用户一个数字感
  let sizeHint = '';
  try {
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      let count = 0;
      const walk = (dir) => {
        try {
          for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            const s = statSync(p);
            if (s.isDirectory()) walk(p);
            else count++;
          }
        } catch {
          // EPERM / ENOENT 等忽略,计数器允许低估
        }
      };
      walk(fullPath);
      sizeHint = `(~${count} files)`;
    }
  } catch {
    // 计数失败不阻塞删除
  }

  const action = dryRun ? '将删' : '删除';
  console.log(`[clean] ${action}:${t.path} ${sizeHint} — ${t.reason}`);

  if (!dryRun) {
    try {
      rmSync(fullPath, { recursive: true, force: true });
      removedCount++;
    } catch (err) {
      console.error(`[clean] 失败:${t.path} — ${err instanceof Error ? err.message : String(err)}`);
      // 不退出,继续删剩下的
    }
  }
}

if (dryRun) {
  console.log(`\n[clean] dry-run:共 ${targets.length - skippedCount} 个目标会被删,${skippedCount} 个不存在跳过`);
} else {
  console.log(`\n[clean] 完成:删了 ${removedCount} / ${targets.length} 个目标,${skippedCount} 个不存在跳过`);
}

process.exit(0);
