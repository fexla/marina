/**
 * @file src/renderer/components/LocalAppearanceProvider.tsx
 * @purpose 提供"本机客户端外观"的 React context,与远程连接状态彻底解耦。
 *
 * @关键设计:
 * - 在 App 最顶层挂载(handshake 之前),让错误/握手态也能拿到本机主题。
 * - 通过 local-control 命令 SETTINGS_GET_APPEARANCE 拉取。preload 的 invoke()
 *   对 local-control 命令 bypass ensureTransport(见 src/preload/index.ts invoke():
 *   `getCommandRouting(channel) === 'local-control'` 时直接 invokeLocal)——所以
 *   远程窗口即使连不上 daemon,也走客户端本地 ipcRenderer 立即返回。
 * - 订阅 SETTINGS_LOCAL_APPEARANCE_CHANGED,用户在设置页/另一窗口切主题时实时同步。
 *
 * @为什么需要它(修 Bug 2):
 * - 远程窗口外观设计上继承本机(docs/plans/远程窗口外观继承本机.md)。
 * - 但原本机外观拉取嵌在 useIpcSync(store.tsx)的 snapshot 流程里,只在连接成功
 *   后执行。错误态(mismatch / handshake error / sync.error)不走 useIpcSync →
 *   store.settings 为空对象 → RemoteConnectionErrorScreen 的主题恒 fallback
 *   'rose-pine',即使用户本地设了别的主题。
 * - 本 Provider 把"本机外观获取"从连接成功路径剥离出来,任何窗口形态(含错误态)
 *   都能拿到正确的本机主题。
 *
 * @与 useIpcSync 的关系(为什么不合并):
 * - 正常路径(ConnectedShell)仍用 store.settings.appearance(由 useIpcSync 在
 *   snapshot 加载后用本机 appearance 覆盖)。本 Provider 不干预正常路径。
 * - 本 Provider 只服务错误/握手态(FramelessShell 消费)。
 * - 两者都拉 SETTINGS_GET_APPEARANCE(本机),数据源一致、appearance 幂等,各拉
 *   一次本地 IPC 代价极小。不合并是为了:① 不动已通过的 useIpcSync 逻辑;
 *   ② 避免 snapshot 与 Provider 异步拉取的时序坑(Provider 若晚于 snapshot 到达,
 *   没有 change 事件触发覆盖,远程窗口会先闪一下 daemon 外观)。
 *
 * @对应文档: docs/plans/远程窗口错误态架构修复.md、docs/plans/远程窗口外观继承本机.md
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  COMMAND_CHANNELS,
  EVENT_CHANNELS,
  type LocalAppearanceChangedPayload,
} from '@shared/protocol';
import type { Settings } from '@shared/types';

interface LocalAppearanceContextValue {
  /**
   * 本机 appearance 块。拉取完成前为 null —— 消费者应 fallback 到默认值
   * (DEFAULT_SETTINGS.appearance,见 settings-manager.ts)。绝不阻塞 UI 渲染:
   * FramelessShell 在 null 时用默认主题先画出标题栏,appearance 到达后切换。
   */
  appearance: Settings['appearance'] | null;
}

const LocalAppearanceContext = createContext<LocalAppearanceContextValue | null>(null);

export function LocalAppearanceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [appearance, setAppearance] = useState<Settings['appearance'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 首次拉取本机 appearance。local-control 命令,远程窗口也走客户端本地 IPC
    // (不经远程 WS),所以远程连接失败时依然可用 —— 这是修 Bug 2 的关键。
    void window.api
      .invoke(
        COMMAND_CHANNELS.SETTINGS_GET_APPEARANCE,
        undefined,
      )
      .then((res) => {
        if (!cancelled) setAppearance(res.appearance);
      })
      .catch(() => {
        // 本地 main 未注册命令(理论上不会发生 —— 本地始终注册该 handler)时
        // 保持 null,消费者 fallback 默认主题。外观拉取失败绝不阻塞 UI 渲染。
      });
    // 订阅本机外观变更:用户在设置页切主题,或另一窗口改了外观,实时同步。
    const off = window.api.on<LocalAppearanceChangedPayload>(
      EVENT_CHANNELS.SETTINGS_LOCAL_APPEARANCE_CHANGED,
      (p) => {
        if (!cancelled) setAppearance(p.appearance);
      },
    );
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return (
    <LocalAppearanceContext.Provider value={{ appearance }}>{children}</LocalAppearanceContext.Provider>
  );
}

/**
 * 读取本机客户端外观(与远程连接状态无关)。必须在 LocalAppearanceProvider 内使用。
 *
 * @returns 本机 appearance 块,或 null(尚未拉到)。消费者应自行 fallback 默认主题:
 *          `const theme = appearance?.theme ?? 'rose-pine'`。
 */
export function useLocalAppearance(): Settings['appearance'] | null {
  const ctx = useContext(LocalAppearanceContext);
  if (!ctx) {
    throw new Error(
      '[LocalAppearanceProvider] useLocalAppearance 必须在 LocalAppearanceProvider 内使用',
    );
  }
  return ctx.appearance;
}
