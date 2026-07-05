/**
 * @file src/main/argv-utils.ts
 * @purpose 进程入口 argv 的小型纯函数解析器,独立成模块以便单测
 *   (import main/index.ts 会触发 bootstrap → 调用 electron.app,
 *    在测试环境无法运行)。
 */

/**
 * 解析 argv,提取 `--open-here <path>` 后第一个非 flag token 作为目录路径。
 *
 * Explorer 右键 "在 Marina 终端中打开" 通过注册表 command 字段调用
 * `Marina.exe --open-here "<path>"`。冷启动和 second-instance handler 都会
 * 走这个 parser。
 *
 * **TIT-2**: 不能用 `argv[idx+1]` 直接取下一项,因为 Electron 31 在
 * Windows 上派发 `second-instance` 事件时,会把 Chromium 注入的 flag
 * (实测 `--allow-file-access-from-files`) 插在 `--open-here` 和它的
 * value 之间。冷启动用的 `process.argv` 是 raw argv,不受影响 — 但
 * 既然这是 single parser 被两条路径共用,统一处理。
 *
 * 启发法: 从 idx+1 开始向后扫,跳过所有以 `--` 开头的 token,第一个
 * 非 flag token 即 path。安全性论证:
 * - Win 绝对路径 (`C:\`、`\\server`) / POSIX 绝对路径 (`/`、`~/`) 都不
 *   以 `--` 开头,不会与 flag 撞首字符。
 * - Chromium 注入的 flag 都是 `--key` (boolean) 或 `--key=value` (单
 *   token),不会出现 `--key value` 两 token 形式偷吃我们的 path。
 *
 * @returns 找到则返回 path 字符串;无 / 后续全是 flag / 后跟空串时返回 null
 */
export function parseOpenHere(argv: readonly string[]): string | null {
  // BETA-003c:Linux 文件管理器 / gnome-terminal 兼容 alias —
  // `--working-directory=<path>` 是 GTK 终端家族(gnome-terminal /
  // xfce4-terminal / wezterm)的事实标准 flag。我们的 .desktop Exec 行用
  // `marina --working-directory=%f`,Nautilus 会展开 %f 为目录路径。
  for (const tok of argv) {
    if (!tok) continue;
    if (tok.startsWith('--working-directory=')) {
      return tok.slice('--working-directory='.length);
    }
  }
  const wdIdx = argv.indexOf('--working-directory');
  if (wdIdx >= 0) {
    for (let i = wdIdx + 1; i < argv.length; i++) {
      const tok = argv[i];
      if (!tok) continue;
      if (tok.startsWith('--')) continue;
      return tok;
    }
  }

  const idx = argv.indexOf('--open-here');
  if (idx < 0) return null;
  for (let i = idx + 1; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok) continue;
    if (tok.startsWith('--')) continue;
    return tok;
  }
  return null;
}

/**
 * 解析 BETA-027 简易模式标记。约定:Explorer 右键集成 / shortcut 在
 * argv 任意位置出现 `--mode=simple` 或 `--simple` 即视为简易模式。
 *
 * 与 parseOpenHere 解耦:即使没有 --open-here(冷启动直接 simpleMode),
 * 也能通过这个标记影响首窗渲染。
 */
export function parseSimpleMode(argv: readonly string[]): boolean {
  for (const tok of argv) {
    if (!tok) continue;
    if (tok === '--simple' || tok === '--mode=simple') return true;
  }
  return false;
}

/**
 * 解析 v2.0 远程后端 daemon 启动参数(ADR-014 / 软件定义书 §14.9)。
 *
 * 触发:argv 出现 `--daemon` 或 `--headless` 任一即进入 daemon 模式
 * (Marina.exe --headless --daemon 是完整形式;单独 --headless 也隐含 daemon,
 * 方便记忆)。两者都出现是惯例写法。
 *
 * 端口:`--port=<N>` 覆盖默认 12580。
 *
 * @returns 非 daemon 启动返回 null;daemon 启动返回 { daemon, headless, port }
 */
export interface DaemonMode {
  /** 是否进入 daemon 模式(--daemon 或 --headless 任一) */
  daemon: boolean;
  /** 是否无窗口(--headless;daemon 可选保留窗口用于本地同时使用) */
  headless: boolean;
  /** WS server 监听端口 */
  port: number;
}
export function parseHeadlessDaemon(argv: readonly string[]): DaemonMode | null {
  const daemon = argv.includes('--daemon');
  const headless = argv.includes('--headless');
  if (!daemon && !headless) return null;
  let port = 12580;
  for (const tok of argv) {
    if (!tok) continue;
    if (tok.startsWith('--port=')) {
      const p = parseInt(tok.slice('--port='.length), 10);
      if (!Number.isNaN(p) && p > 0 && p < 65536) port = p;
    }
  }
  return { daemon: true, headless, port };
}
