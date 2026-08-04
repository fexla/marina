/**
 * @file scripts/filter-node-pty-after-pack.cjs
 * @purpose 在 electron-builder 的 staging 目录中移除目标平台/架构不会加载的 node-pty 二进制。
 *
 * electron-builder 的 files 负 glob 与 asarUnpack 合用时曾无法过滤 prebuilds
 * （ISO-2）。这里仅操作本次构建生成的 context.appOutDir，绝不修改 node_modules；
 * 因而既能确定性消除跨平台二进制，也不会破坏开发机下一次切平台所需的依赖。
 */
const fs = require('node:fs');
const path = require('node:path');

// builder-util Arch 枚举在 electron-builder 24.x 的稳定编号。
const ARCH_NAMES = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal'],
]);

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function filterNodePtyAfterPack(context) {
  const nodePtyRoot = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  );
  if (!fs.existsSync(nodePtyRoot)) {
    console.warn(`[afterPack:node-pty] skip: staging root not found at ${nodePtyRoot}`);
    return;
  }

  const archName = ARCH_NAMES.get(context.arch);
  if (!archName) {
    throw new Error(
      `[afterPack:node-pty] Unknown electron-builder Arch enum value=${String(context.arch)}. ` +
        'Refusing to filter native binaries; update ARCH_NAMES before packaging this architecture.',
    );
  }

  const prebuildsRoot = path.join(nodePtyRoot, 'prebuilds');
  const buildRoot = path.join(nodePtyRoot, 'build');
  let keptPrebuilds = new Set();

  if (context.electronPlatformName === 'win32') {
    keptPrebuilds = new Set([`win32-${archName}`]);
    removeGeneratedPath(buildRoot, 'Windows uses the matching upstream prebuild');
  } else if (context.electronPlatformName === 'darwin') {
    keptPrebuilds =
      archName === 'universal'
        ? new Set(['darwin-x64', 'darwin-arm64'])
        : new Set([`darwin-${archName}`]);
    removeGeneratedPath(buildRoot, 'macOS uses the matching upstream prebuild');
  } else if (context.electronPlatformName === 'linux') {
    // node-pty has no Linux prebuild in the pinned package; install-app-deps compiles build/Release.
    removeGeneratedPath(
      prebuildsRoot,
      'Linux uses build/Release compiled in its build environment',
    );
    console.log(`[afterPack:node-pty] platform=linux arch=${archName}; kept build/Release only`);
    return;
  } else {
    throw new Error(
      `[afterPack:node-pty] Unsupported platform=${context.electronPlatformName}. ` +
        'Refusing to guess which native binaries are safe to keep.',
    );
  }

  if (!fs.existsSync(prebuildsRoot)) {
    throw new Error(
      `[afterPack:node-pty] Missing prebuilds at ${prebuildsRoot}; ` +
        `cannot package ${context.electronPlatformName}-${archName}. ` +
        'Run electron-builder install-app-deps and verify the node-pty installation.',
    );
  }

  const existing = fs
    .readdirSync(prebuildsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const directory of existing) {
    if (!keptPrebuilds.has(directory)) {
      removeGeneratedPath(path.join(prebuildsRoot, directory), 'not used by target platform/arch');
    }
  }

  const missing = [...keptPrebuilds].filter(
    (directory) => !fs.existsSync(path.join(prebuildsRoot, directory)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[afterPack:node-pty] Required prebuild missing for ${context.electronPlatformName}-${archName}: ` +
        `${missing.join(', ')}. Existing before filter: ${existing.join(', ') || '(none)'}.`,
    );
  }
  console.log(
    `[afterPack:node-pty] platform=${context.electronPlatformName} arch=${archName}; ` +
      `kept=${[...keptPrebuilds].join(', ')}`,
  );
};

function removeGeneratedPath(target, reason) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[afterPack:node-pty] removed ${target} (${reason})`);
}
