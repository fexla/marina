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
