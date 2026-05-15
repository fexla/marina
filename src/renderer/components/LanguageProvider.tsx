/**
 * @file src/renderer/components/LanguageProvider.tsx
 * @purpose BETA-004:订阅 settings.appearance.language,更新全局 i18n locale。
 *   不向 Context 暴露 t() — t() 是 module 单例,任何组件直接 import 即用。
 *   存在的意义只是把"settings 变 → setLocale + 触发 re-render"这条线路装好。
 *
 *   关键设计:setLocale 是 module-level mutation,React 不会感知。所以
 *   provider 自己持有 reactiveLocale state,作为 Context value;UI 组件
 *   读 useTranslation() 拿到这个值就会随之 re-render。
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { resolveLocale, setLocale, t, type Locale } from '@shared/i18n';
import { useAppState } from '../store';

interface LanguageContextValue {
  locale: Locale;
}

const LanguageContext = createContext<LanguageContextValue>({ locale: 'zh-CN' });

export function LanguageProvider({ children }: { children: ReactNode }): JSX.Element {
  const state = useAppState();
  const pref = state.settings?.appearance?.language ?? 'system';

  const locale = useMemo<Locale>(() => {
    return resolveLocale(pref, typeof navigator !== 'undefined' ? navigator.language : undefined);
  }, [pref]);

  // 同步 module-level state(t() 用)
  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  // <html lang> 同步,方便 DevTools / 截图工具识别
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  return <LanguageContext.Provider value={{ locale }}>{children}</LanguageContext.Provider>;
}

/** UI 组件可用的 hook;返回当前 locale,组件 re-render 时 t() 自动用新 locale */
export function useTranslation(): { locale: Locale; t: typeof t } {
  const { locale } = useContext(LanguageContext);
  return { locale, t };
}
