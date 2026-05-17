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
import { getLocale, resolveLocale, setLocale, t, tx, type Locale } from '@shared/i18n';
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

  // PER-LANG 修复:在 render 阶段同步 module-level currentLocale。
  //
  // 原方案用 useEffect(() => setLocale(locale), [locale]) — 但 useEffect 在
  // paint 之后才跑。导致 settings.language 变化时,LanguageProvider 重渲触发
  // children(SettingsView 等)重渲,children 调 t()/tx() **仍读旧 currentLocale**
  // (因为 effect 还没执行),要等用户下次手动触发 re-render(切 tab / 退出
  // 设置页 / hover 等)才能看到新文案。表现为"切语言不实时生效"。
  //
  // render 阶段同步调 setLocale 让 module variable 在 children 重渲前就更新好。
  // 这是 "render-time side effect" — React 严格模式下幂等 mutation 是安全的
  // (跑两次 setLocale 同值是 no-op),也是 react-i18next 等 i18n 库的通用做法。
  // 加 if 守卫避免每次 re-render 都触发等值赋值(纯优化,不影响正确性)。
  if (getLocale() !== locale) {
    setLocale(locale);
  }

  // <html lang> 同步,方便 DevTools / 截图工具识别(DOM 操作仍在 effect 里,
  // 因为 documentElement.lang 是真 DOM 副作用)
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  return <LanguageContext.Provider value={{ locale }}>{children}</LanguageContext.Provider>;
}

/** UI 组件可用的 hook;返回当前 locale,组件 re-render 时 t() / tx() 自动用新 locale */
export function useTranslation(): { locale: Locale; t: typeof t; tx: typeof tx } {
  const { locale } = useContext(LanguageContext);
  return { locale, t, tx };
}
