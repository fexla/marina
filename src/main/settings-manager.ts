/**
 * @file src/main/settings-manager.ts
 * @purpose 维护应用设置:加载 / deep merge partial update / 校验 / 持久化 /
 *   广播变更。设置即改即生效,无"保存"按钮 (ADR-007、软件定义书 6.6.1)。
 *
 * @关键设计:
 * - 默认值集中在 DEFAULT_SETTINGS,持久化文件缺字段时自动填默认 (deep
 *   merge 保证向前兼容)
 * - update(partial) deep-merge → validate → commit,validate 失败不 commit
 * - emit('settingsChanged', { settings, changedKeys }) 给 IPC 广播,
 *   changedKeys 是 dotted path (e.g. "appearance.theme") 给 renderer 做局部更新
 * - 写盘走 JsonStore 的 debounce 500ms (软件定义书 11.3)
 *
 * @对应文档章节: 软件定义书.md 6.6、11.1、11.3 节;
 *   ipc-protocol.md 5.5、6.4 节
 *
 * @CP-2 范围:
 * 完整 schema 已定义,validate 只校验基础范围 (theme 枚举、字号范围等)。
 * 完整 schema 校验 + 版本迁移 + export/import 在 CP-4。
 */
import { EventEmitter } from 'node:events';
import type { Settings, ThemeId } from '@shared/types';
import type { DeepPartial } from '@shared/types-helpers';
import type { JsonStore } from './persistence';

export type { DeepPartial };

/**
 * 默认设置 (软件定义书 11.1 settings.json)。
 *
 * 任何字段缺失时,deep merge 会自动用此处的值填充 — 这是版本兼容的关键。
 * 修改默认值前确认是否需要 bump Settings.version。
 */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  appearance: {
    theme: 'rose-pine',
    windowStyle: 'windows',
    terminalFontFamily:
      "'Cascadia Mono', 'JetBrains Mono', 'Consolas', 'LXGW WenKai Mono', monospace",
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    uiFontFamily: "'LXGW WenKai', system-ui, sans-serif",
    uiZoom: 1.0,
  },
  shell: {
    defaultShellId: '',
    newTerminalShellPolicy: 'default',
  },
  behavior: {
    startupBehavior: 'open-window',
    autoStart: false,
    confirmOnQuit: true,
    selectOnCopy: true,
    terminalRightClick: 'menu',
  },
  systemIntegration: {
    explorerContextMenu: false,
  },
  advanced: {
    logLevel: 'INFO',
    activeIdleThresholdSeconds: 2,
  },
};

const VALID_THEMES: ThemeId[] = [
  'rose-pine',
  'rose-pine-dawn',
  'rose-pine-moon',
  'cutie',
  'business',
  'ubuntu',
  'windows-terminal',
];

/**
 * 设置变更错误。code 与 ipc-protocol 7.1 对齐。
 */
export class SettingsError extends Error {
  constructor(
    public readonly code: 'InvalidSettings' | 'IncompatibleVersion',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[SettingsManager] ${code}: ${message}`);
    this.name = 'SettingsError';
  }
}

export class SettingsManager extends EventEmitter {
  private settings: Settings = DEFAULT_SETTINGS;

  constructor(private readonly store: JsonStore<Settings>) {
    super();
  }

  /**
   * 应用启动时调一次。从 store 加载,与默认值 deep-merge 填充缺字段。
   *
   * @returns 来源:'main' / 'bak' / 'default'
   */
  async initialize(): Promise<'main' | 'bak' | 'default'> {
    const result = await this.store.load(DEFAULT_SETTINGS);
    // 不论从哪加载,都要走一遍 deep merge 防止用户文件少字段
    const merged = deepMerge(DEFAULT_SETTINGS, result.value as DeepPartial<Settings>);
    // 版本不兼容直接拒绝 (CP-4 加迁移逻辑;CP-2 简单粗暴)
    if (merged.version !== 1) {
      throw new SettingsError(
        'IncompatibleVersion',
        `Settings version=${merged.version} 不被当前应用支持 (期望 1)。` +
          `如果是从未来版本回退,请手工删除 settings.json 后重启。`,
      );
    }
    this.settings = merged;
    return result.source;
  }

  /**
   * 获取当前设置的深拷贝。返回值修改不影响内部状态。
   */
  get(): Settings {
    return structuredClone(this.settings);
  }

  /**
   * 部分更新。deep-merge 然后整体校验,通过则 commit + 持久化 + emit。
   *
   * @throws SettingsError InvalidSettings 校验失败
   */
  update(partial: DeepPartial<Settings>): void {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new SettingsError(
        'InvalidSettings',
        `partial 必须是对象,实际: ${typeof partial}${
          Array.isArray(partial) ? ' (Array)' : ''
        }`,
      );
    }
    const next = deepMerge(this.settings, partial);
    validateSettings(next);

    const changedKeys = diffKeys('', this.settings, next);
    if (changedKeys.length === 0) return; // 完全没变,不写不广播

    this.settings = next;
    this.store.set(structuredClone(next));
    this.emit('settingsChanged', { settings: structuredClone(next), changedKeys });
  }

  /**
   * 重置为默认 (危险操作,应通过 cmd:settings:reset 触发)。
   */
  reset(): void {
    const oldSettings = this.settings;
    this.settings = structuredClone(DEFAULT_SETTINGS);
    const changedKeys = diffKeys('', oldSettings, this.settings);
    this.store.set(structuredClone(this.settings));
    if (changedKeys.length > 0) {
      this.emit('settingsChanged', {
        settings: structuredClone(this.settings),
        changedKeys,
      });
    }
  }

  /**
   * CP-4 勘误 #12:整体替换 settings (设置导入用)。
   *
   * 走和 initialize 同样的 deep-merge 路径,这样导入的归档若缺新增字段
   * 会自动用 DEFAULT_SETTINGS 补齐;然后 validate + commit + emit,所有
   * 窗口通过 evt:settings:changed 立即同步,无需 app.relaunch。
   */
  replaceAll(newSettings: Partial<Settings>): void {
    const merged = deepMerge(DEFAULT_SETTINGS, newSettings as DeepPartial<Settings>);
    if (merged.version !== 1) {
      throw new SettingsError(
        'IncompatibleVersion',
        `Settings version=${merged.version} 不被当前应用支持 (期望 1)`,
      );
    }
    validateSettings(merged);
    const oldSettings = this.settings;
    this.settings = merged;
    this.store.set(structuredClone(merged));
    const changedKeys = diffKeys('', oldSettings, merged);
    if (changedKeys.length > 0) {
      this.emit('settingsChanged', {
        settings: structuredClone(merged),
        changedKeys,
      });
    }
  }

  /**
   * 等所有待写入落盘 (退出前调)。
   */
  async flush(): Promise<void> {
    await this.store.flush();
  }
}

// ──────────────────────────────────────────────────────────────────
// 工具函数 (导出以便 settings-manager.test.ts 直接测)
// ──────────────────────────────────────────────────────────────────

/**
 * 浅复制基础类型,深合并对象 (不合并数组,数组整体替换)。
 *
 * 注:这里没用 structuredClone(target) 再 mutate,而是逐字段递归;为了
 * 保持函数纯净,target 不被修改。
 */
export function deepMerge<T>(target: T, partial: DeepPartial<T> | undefined): T {
  if (partial === undefined || partial === null) return target;
  if (typeof target !== 'object' || target === null) {
    return (partial as unknown) as T;
  }
  if (Array.isArray(target)) {
    // 数组整体替换 (除非 partial 也是 array,直接用 partial)
    return (Array.isArray(partial) ? partial : target) as T;
  }
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(partial as object)) {
    const partialValue = (partial as Record<string, unknown>)[key];
    if (partialValue === undefined) continue; // undefined 不覆盖
    const targetValue = (target as Record<string, unknown>)[key];
    if (
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue) &&
      typeof partialValue === 'object' &&
      partialValue !== null &&
      !Array.isArray(partialValue)
    ) {
      result[key] = deepMerge(targetValue, partialValue as DeepPartial<unknown>);
    } else {
      result[key] = partialValue;
    }
  }
  return result as T;
}

/**
 * 算两个对象的字段差异,返回 dotted-path 列表 ("appearance.theme")。
 */
export function diffKeys<T>(prefix: string, a: T, b: T): string[] {
  if (a === b) return [];
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null ||
    Array.isArray(a) ||
    Array.isArray(b)
  ) {
    // 叶子节点或 array,直接比较
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || '*'];
  }
  const keys = new Set([
    ...Object.keys(a as Record<string, unknown>),
    ...Object.keys(b as Record<string, unknown>),
  ]);
  const result: string[] = [];
  for (const key of keys) {
    const subPrefix = prefix ? `${prefix}.${key}` : key;
    const aVal = (a as Record<string, unknown>)[key];
    const bVal = (b as Record<string, unknown>)[key];
    result.push(...diffKeys(subPrefix, aVal, bVal));
  }
  return result;
}

/**
 * Settings 校验。CP-2 仅基础范围 + 枚举值,完整 schema 校验在 CP-4。
 *
 * @throws SettingsError InvalidSettings 任意字段越界 / 枚举错误
 */
export function validateSettings(s: Settings): void {
  if (!VALID_THEMES.includes(s.appearance.theme)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.theme="${s.appearance.theme}" 不是合法主题,允许: ${VALID_THEMES.join(', ')}`,
      { field: 'appearance.theme', got: s.appearance.theme, allowed: VALID_THEMES },
    );
  }
  if (!['windows', 'macos'].includes(s.appearance.windowStyle)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.windowStyle="${s.appearance.windowStyle}" 必须是 windows 或 macos`,
    );
  }
  checkRange('appearance.terminalFontSize', s.appearance.terminalFontSize, 8, 24);
  checkRange('appearance.terminalLineHeight', s.appearance.terminalLineHeight, 1.0, 2.0);
  checkRange('appearance.uiZoom', s.appearance.uiZoom, 0.75, 1.5);
  checkRange(
    'advanced.activeIdleThresholdSeconds',
    s.advanced.activeIdleThresholdSeconds,
    0.1,
    60,
  );
  if (!['INFO', 'DEBUG'].includes(s.advanced.logLevel)) {
    throw new SettingsError(
      'InvalidSettings',
      `advanced.logLevel="${s.advanced.logLevel}" 必须是 INFO 或 DEBUG`,
    );
  }
  if (!['menu', 'paste'].includes(s.behavior.terminalRightClick)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.terminalRightClick="${s.behavior.terminalRightClick}" 必须是 menu 或 paste`,
    );
  }
  if (!['open-window', 'tray-only'].includes(s.behavior.startupBehavior)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.startupBehavior="${s.behavior.startupBehavior}" 必须是 open-window 或 tray-only`,
    );
  }
  if (!['default', 'last-used'].includes(s.shell.newTerminalShellPolicy)) {
    throw new SettingsError(
      'InvalidSettings',
      `shell.newTerminalShellPolicy="${s.shell.newTerminalShellPolicy}" 必须是 default 或 last-used`,
    );
  }
}

function checkRange(field: string, value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SettingsError('InvalidSettings', `${field} 必须是有限数,实际: ${value}`);
  }
  if (value < min || value > max) {
    throw new SettingsError(
      'InvalidSettings',
      `${field}=${value} 越界,允许 [${min}, ${max}]`,
      { field, value, min, max },
    );
  }
}
