/**
 * @file src/shared/i18n.ts
 * @purpose BETA-004:自写的轻量 i18n 层。AGENTS.md 1.2 边界 2 禁止引入新依赖,
 *   ~100 行自实现足够覆盖 Marina 当前规模(~300-400 个文案点)。
 *
 *   设计:
 *   - 静态 import zh-CN.json + en-US.json,无运行时加载
 *   - t(key) 优先查当前 locale,缺译回退到 en-US,再缺回退到 key 字面值
 *     (开发期暴露漏译;生产期不至于 UI 空白)
 *   - 占位符替换:t('foo.bar', { count: 3 }) 把 "{count}" 替换为 3
 *   - 主进程 + renderer 都直接 import 同一份字典,运行时 setLocale 切换
 *
 *   语言选择:settings.appearance.language
 *     - 'system' = 根据 app.getLocale() / navigator.language 推断
 *     - 'zh-CN' / 'en-US' = 显式
 *
 * @对应文档章节: 工单库 BETA-004
 */

// 直接 import JSON;TypeScript 走 resolveJsonModule(tsconfig 已开)
import zhCN from '../renderer/i18n/zh-CN.json';
import enUS from '../renderer/i18n/en-US.json';

export type Locale = 'zh-CN' | 'en-US';

type Dict = Record<string, string>;

const DICTIONARIES: Record<Locale, Dict> = {
  'zh-CN': zhCN as Dict,
  'en-US': enUS as Dict,
};

let currentLocale: Locale = 'zh-CN';

/**
 * 设置当前 locale。renderer 在 settings 变化时调一次,主进程也单独维护一份。
 */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * 把 'system' 解析成具体 locale。
 * - 浏览器环境:navigator.language(调用方传入)
 * - 主进程:由调用方传入 app.getLocale()
 *
 * 该模块同时被 main / renderer / shared 导入,不在这里直接读 navigator
 * 避免 main process tsc 报错(无 DOM types)。
 */
export function resolveLocale(
  preference: 'system' | 'zh-CN' | 'en-US',
  systemLocale?: string,
): Locale {
  if (preference === 'zh-CN' || preference === 'en-US') return preference;
  const sys = systemLocale ?? 'en-US';
  return sys.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

/**
 * 翻译查找。fallback 链:currentLocale → en-US → key 字面值。
 * params 中的占位符按 {name} 形式替换;缺占位符不报错,留在文本里。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const fromCurrent = DICTIONARIES[currentLocale]?.[key];
  const fromEn = DICTIONARIES['en-US']?.[key];
  let template = fromCurrent ?? fromEn ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}
