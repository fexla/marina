/**
 * @file src/renderer/pending-line-jump.ts
 * @purpose Feature F(T15)行号跳转的 renderer 端传递通道:TerminalView 点击带 `:行号`
 *   的路径链接时记录目标行,TextViewer 打开该文件时消费并滚动到该行。
 *
 * @为什么不用 IPC payload 透传(ADR-027 决策 4):
 *   ADR-027 明确「实现无需后端改动」。行号是纯 renderer 前端能力(滚动定位),走
 *   组件外缓存(模块级 Map,参照 git-status-cache 模式)最轻,不动 protocol/main。
 *
 * @key 设计(绝对路径):
 *   - TerminalView 从终端文本只拿到**相对路径**(`src/x.ts`),不知道绝对路径。
 *   - 但 invoke `cmd:file-panel:open` 成功后返回的 snapshot.activePath 是**绝对路径**。
 *   - 故:TerminalView 先用相对 path 临时存,invoke resolve 后用 activePath 把 key
 *     重写为绝对路径(`movePendingLineJump`)。
 *   - TextViewer 用 file.path(绝对)查 → 命中即跳,跳完删除(一次性)。
 *
 * @边缘情况(接受,不阻塞 v1):
 *   文件**已打开**时再点它的 `:行号` 链接 → activePath 不变 → TextViewer 不 remount
 *   → 不重新跳行。只有首次打开该文件时跳。后续可加 activePath 变化监听补全。
 */
const pending = new Map<string, number>();

/**
 * 记录一个待跳转(临时用相对 path 作 key,TerminalView 调用)。
 * 调用方应在 invoke 成功后用 `movePendingLineJump` 把 key 换成绝对路径。
 */
export function setPendingLineJump(key: string, line: number): void {
  pending.set(key, line);
}

/**
 * 把 pending 的 key 从旧的(相对 path)换成新的(绝对 activePath)。
 * invoke 成功后调用:TerminalView 拿 snapshot.activePath 重写。
 */
export function movePendingLineJump(oldKey: string, newKey: string): void {
  const line = pending.get(oldKey);
  if (line !== undefined) {
    pending.delete(oldKey);
    pending.set(newKey, line);
  }
}

/**
 * 消费一个待跳转(TextViewer 打开文件时调用,一次性:读到即删)。
 * @param absPath 文件绝对路径(FilePanel 里 OpenedFile.path)
 * @returns 行号(1-based),无则 undefined
 */
export function consumePendingLineJump(absPath: string): number | undefined {
  const line = pending.get(absPath);
  if (line !== undefined) pending.delete(absPath);
  return line;
}
