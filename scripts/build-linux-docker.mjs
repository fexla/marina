#!/usr/bin/env node
/**
 * @file scripts/build-linux-docker.mjs
 * @purpose 在 Docker 容器内构建 Marina 的 Linux 安装包(ISO-1,2026-05-20)。
 *
 * @背景
 * `npm run build:linux:docker` 原写法是
 *   `docker build -f ... && docker run -v "$(pwd)/release:/build/release" ...`
 * 但 `$(pwd)` 在 Windows `cmd.exe`(npm 默认 script-shell)里不展开,在
 * PowerShell 里语法也是 `${PWD}`。统一用 Node 包装,process.cwd() 给出
 * 跨平台稳的绝对路径,然后用 child_process.spawnSync 同步执行 docker。
 *
 * @用法
 *   npm run build:linux:docker
 *
 *   # 或直接:
 *   node scripts/build-linux-docker.mjs
 *
 *   # 重建镜像不走 cache:
 *   node scripts/build-linux-docker.mjs --no-cache
 *
 *   # 只 build 镜像不 run(用于 CI 单步):
 *   node scripts/build-linux-docker.mjs --build-only
 *
 *   # 不 build 直接 run 已有镜像(快速迭代):
 *   node scripts/build-linux-docker.mjs --run-only
 *
 * @退出码
 *   0 = 成功 / 镜像构建并产出 release/${version}/ 下 deb / rpm / AppImage
 *   1 = 任何一步失败
 *
 * @对应文档
 *   docs/issues/iso-1-cross-platform-build-pollution.md
 *   Dockerfile.linux-build(镜像定义)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const dockerfile = join(projectRoot, 'Dockerfile.linux-build');
const dockerignore = join(projectRoot, '.dockerignore');
const releaseDir = join(projectRoot, 'release');

if (!existsSync(dockerfile)) {
  console.error(`[docker-build] 找不到 ${dockerfile}`);
  process.exit(1);
}
if (!existsSync(dockerignore)) {
  console.warn(
    `[docker-build] 警告:找不到 ${dockerignore},主机 node_modules 可能会被` +
      ` COPY 进镜像污染 Linux 构建(详见 docs/issues/iso-1-...md)`,
  );
}

const args = new Set(process.argv.slice(2));
const noCache = args.has('--no-cache');
const buildOnly = args.has('--build-only');
const runOnly = args.has('--run-only');
args.delete('--no-cache');
args.delete('--build-only');
args.delete('--run-only');

const validFlags = ['--no-cache', '--build-only', '--run-only'];
for (const a of args) {
  if (!validFlags.includes(a)) {
    console.error(`[docker-build] 未知参数:${a}`);
    console.error(`  合法:${validFlags.join(' / ')}`);
    process.exit(1);
  }
}
if (buildOnly && runOnly) {
  console.error('[docker-build] --build-only 与 --run-only 互斥');
  process.exit(1);
}

const imageTag = 'marina-linux-build:local';

function runCmd(label, cmd, cmdArgs) {
  console.log(`\n[docker-build] === ${label} ===`);
  console.log(`[docker-build] $ ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: projectRoot,
    shell: false,
  });
  if (result.error) {
    console.error(`[docker-build] ${label} 执行失败:${result.error.message}`);
    if (result.error.code === 'ENOENT') {
      console.error(`[docker-build] 提示:看起来 ${cmd} 不在 PATH,确认 Docker 已安装并启动`);
    }
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[docker-build] ${label} 退出码 ${result.status},中止`);
    process.exit(result.status ?? 1);
  }
}

// 1. docker build
if (!runOnly) {
  const buildArgs = [
    'build',
    '-f', 'Dockerfile.linux-build',
    '-t', imageTag,
  ];
  if (noCache) buildArgs.push('--no-cache');
  buildArgs.push('.');
  runCmd('构建 Linux build 镜像', 'docker', buildArgs);
}

// 2. docker run(产物 mount 出来)
if (!buildOnly) {
  // 用绝对路径 + posix 风格(Docker Desktop on Windows 接受 C:/... 或 /c/... 但
  // 必须是绝对的)。Node 的 path.resolve 在 Windows 上给 'E:\projects\terminal\release',
  // Docker CLI 接受这种带反斜杠的形式 — 不要再做手工转换,Docker daemon 内部会
  // 走 WSL2 文件系统映射。
  const runArgs = [
    'run',
    '--rm',
    '-v', `${releaseDir}:/build/release`,
    imageTag,
  ];
  runCmd('在容器内跑 build:linux', 'docker', runArgs);

  console.log('\n[docker-build] 完成。产物应该在:');
  console.log(`  ${releaseDir}/`);
}
