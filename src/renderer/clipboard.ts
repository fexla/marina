/**
 * @file src/renderer/clipboard.ts
 * @purpose Renderer 侧剪贴板统一入口。所有"复制 / 粘贴"调用都走这里,
 *   不要直接用 navigator.clipboard 也不要直接 window.api.invoke。
 *
 * @背景:
 *   navigator.clipboard.{read,write}Text 在 Electron file:// 上下文需 web
 *   Permission API 放行(clipboard-read / clipboard-write)。Marina 早期的
 *   setPermissionRequestHandler 默认拒掉了 clipboard-write,导致选中即复制 /
 *   右键粘贴 / Ctrl+Shift+C/V 全部静默失败(.catch(()=>{}) 把权限 reject 吞掉)。
 *
 *   修法:走 main 端的 Electron `clipboard` 模块(IPC),完全绕开 web 权限层。
 *   优先用 preload 暴露的 window.api.clipboard.*;若 preload 是旧版没这个
 *   字段(electron-vite dev 没立刻重打包 preload 的常见场景),直接 invoke
 *   同 IPC channel — 行为完全等价,只要 main 端注册了 handler 就行。
 *
 *   任何抛错都吞掉:写失败返回 false,读失败返回空串。调用方应据此决定提示。
 */
import { COMMAND_CHANNELS } from '@shared/protocol';

type ApiWithClipboard = typeof window.api & {
  clipboard?: {
    readText: () => Promise<string>;
    writeText: (text: string) => Promise<boolean>;
  };
};

/**
 * 把字符串写入系统剪贴板。返回 true 表示已落盘;false 表示链路有问题(main
 * handler 未注册 / Electron 内部异常等)。空串 / 任意 Unicode 都允许。
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    const api = window.api as ApiWithClipboard;
    if (api.clipboard?.writeText) {
      return await api.clipboard.writeText(text);
    }
    const res = await window.api.invoke<{ text: string }, { ok: boolean }>(
      COMMAND_CHANNELS.SYSTEM_CLIPBOARD_WRITE_TEXT,
      { text },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 从系统剪贴板读取字符串。空剪贴板 / 失败 都返回空串。
 */
export async function readClipboardText(): Promise<string> {
  try {
    const api = window.api as ApiWithClipboard;
    if (api.clipboard?.readText) {
      return await api.clipboard.readText();
    }
    const res = await window.api.invoke<undefined, { text: string }>(
      COMMAND_CHANNELS.SYSTEM_CLIPBOARD_READ_TEXT,
      undefined,
    );
    return res.text;
  } catch {
    return '';
  }
}
