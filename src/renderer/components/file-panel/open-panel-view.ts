/**
 * @file open-panel-view.ts
 * @purpose ADR-037:「已打开」面板内正在看哪一侧(文件 / 命令)的解析。
 *
 * @关键设计:
 * - 命令面板整合进 file-panel 后,dock 级 activePanels 只表达「面板本身」;
 *   面板内文件侧/命令侧的切换由 store.openPanelViews 记录(程序推送与用户点
 *   tab 两个写入点,见 store.tsx)。
 * - 本函数是唯一读取方兜底:无记录时默认文件侧;记录的一侧已被清空(全关了)
 *   时回退另一侧 —— 否则用户关掉最后一个文件后会停在永远空着的文件侧,
 *   看不到仍存在的命令输出。
 * - 纯函数,FilePanel(渲染/滚动/demand)与 LayoutHost(SearchBar gate)
 *   共用同一份判定,避免两处各写一套漂移。
 *
 * @不要在这里做的事:
 * - 不写 store(回退只是显示层决策,记录值保持用户/程序的最后意图)。
 */

export type OpenPanelView = 'file' | 'command';

export function resolveOpenPanelView(
  stored: OpenPanelView | undefined,
  fileCount: number,
  commandCount: number,
): OpenPanelView {
  // 无记录默认文件侧:面板的空态提示以「打开文件」为主文案;marina run 推送
  // 总是带 requestActivation(会把 stored 写成 'command'),不会落到这里。
  const preferred: OpenPanelView = stored ?? 'file';
  if (preferred === 'file' && fileCount === 0 && commandCount > 0) return 'command';
  if (preferred === 'command' && commandCount === 0 && fileCount > 0) return 'file';
  return preferred;
}
