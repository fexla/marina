/**
 * @file src/renderer/clipboard.ts
 * @purpose Renderer 侧剪贴板统一入口。所有"复制 / 粘贴"调用都走这里,
 *   不要直接用 navigator.clipboard。
 *
 * @背景:
 *   navigator.clipboard.{read,write}Text 在 Electron file:// 上下文需 web
 *   Permission API 放行(clipboard-read / clipboard-write)。Marina 早期的
 *   setPermissionRequestHandler 默认拒掉了 clipboard-write,导致选中即复制 /
 *   右键粘贴 / Ctrl+Shift+C/V 全部静默失败(.catch(()=>{}) 把权限 reject 吞掉)。
 *
 *   修法:走 main 端的 Electron `clipboard` 模块(IPC),完全绕开 web 权限层。
 *   preload 稳定暴露 window.api.clipboard.*(其内部也走同一 IPC channel)。
 *
 *   任何抛错都吞掉:写失败返回 false,读失败返回空串。调用方应据此决定提示。
 */

/**
 * 把字符串写入系统剪贴板。返回 true 表示已落盘;false 表示链路有问题(main
 * handler 未注册 / Electron 内部异常等)。空串 / 任意 Unicode 都允许。
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    return await window.api.clipboard.writeText(text);
  } catch {
    return false;
  }
}

/**
 * 从系统剪贴板读取字符串。空剪贴板 / 失败 都返回空串。
 */
export async function readClipboardText(): Promise<string> {
  try {
    return await window.api.clipboard.readText();
  } catch {
    return '';
  }
}
