/**
 * @file src/renderer/components/Toast.tsx
 * @purpose 全局 Toast 通知 (M1-J)。任何组件可 useToast().push(...) 弹消息。
 *
 *   - info / success / warn / error 四种类型
 *   - 4 秒自动消失(error 类型 8 秒);hover 暂停计时
 *   - 多条堆叠右下角,新的在上
 *   - 关闭按钮 + 点击 toast 体也可关闭
 *   - 主进程 IPC 错误等场景:catch 后 toast.push({ kind: 'error', message })
 *
 *   不引入新依赖,纯 React + CSS。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icons';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastInput {
  kind: ToastKind;
  message: string;
  /** 显示时长 ms;不传走默认(error 8s,其余 4s) */
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: number;
  bornAt: number;
}

interface ToastApi {
  push(t: ToastInput): void;
  dismiss(id: number): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('[Toast] useToast must be inside <ToastProvider>');
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const pausedIds = useRef<Set<number>>(new Set());

  const dismiss = useCallback((id: number): void => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    pausedIds.current.delete(id);
  }, []);

  const push = useCallback((t: ToastInput): void => {
    const id = nextId.current++;
    const toast: Toast = { id, bornAt: Date.now(), ...t };
    setItems((prev) => [toast, ...prev].slice(0, 6)); // 最多堆 6 条
  }, []);

  // 单一 ticker 检查每条是否到期,500ms 间隔(对 4s 时长足够精度)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setItems((prev) =>
        prev.filter((t) => {
          if (pausedIds.current.has(t.id)) return true;
          const dur = t.durationMs ?? (t.kind === 'error' ? 8000 : 4000);
          return now - t.bornAt < dur;
        }),
      );
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            onMouseEnter={() => pausedIds.current.add(t.id)}
            onMouseLeave={() => pausedIds.current.delete(t.id)}
            onClick={() => dismiss(t.id)}
          >
            <span className="toast-icon" aria-hidden="true">
              {t.kind === 'error' || t.kind === 'warn' ? (
                <Icon name="alertTriangle" size={14} />
              ) : (
                <Icon name="circleDot" size={14} />
              )}
            </span>
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-close"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
              aria-label="关闭通知"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
