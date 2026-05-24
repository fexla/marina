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
    language: 'system',
    terminalFontFamily:
      "'Cascadia Mono', 'JetBrains Mono', 'Consolas', 'LXGW WenKai Mono', monospace",
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    uiFontFamily: "'LXGW WenKai', system-ui, sans-serif",
    uiZoom: 1.0,
    // BETA-023 macOS 红绿灯悬浮符号,默认关(与 CP-4 勘误第二轮决策一致)
    macOSTrafficLightHoverSymbols: false,
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
    // fix/robustness-pass-20260513 / CPB-P8:默认开 bracketed paste
    // (Marina 默认 shell 是 PowerShell,7+ ReadLine 默认识别 ?2004)。
    bracketedPaste: true,
  },
  systemIntegration: {
    explorerOpenIn: 'new-window',
  },
  advanced: {
    logLevel: 'INFO',
    activeIdleThresholdSeconds: 2,
    // SSH 方案 v2.1 §阶段 2.1:默认不读 ~/.ssh/config,用户在 RemotePanel
    // 主动启用才合并显示。避免出现没看过 ssh_config 的用户误以为 Marina
    // 暴露了他们的远端清单。
    includeSshConfig: false,
    // SSH 方案 v2.1 §阶段 3.5:默认开 ControlMaster,同 host 多 session
    // 性能从 ~3s 握手 / 个降到 <100ms / 个。OpenSSH 8.x+ Windows 支持,
    // 老版本失败时 OpenSSH 自身会回退到新连接,Marina 不需要兜底逻辑。
    enableControlMaster: true,
    // SSH 方案 v2.1 §II.6:本地用户视野守护。默认 false,只有当用户加了
    // SshProfile 或主动勾此项时,远程相关 UI 才出现。本地用户的 sidebar /
    // 设置页视野与 beta.9 一致。
    enableRemote: false,
    // 终端渲染器默认 'auto':Windows/macOS WebGL、Linux DOM(PER-LINUX,
    // BETA-003 修复)。'webgl' / 'dom' 是显式覆盖,通常给调研某些 WebGL
    // 兼容性 bug 用(例如某些 TUI 的光标渲染在 WebGL 下异常)。
    terminalRenderer: 'auto',
  },
  // BETA-031 AI 助手默认全 disabled,用户开启 + 填 key 后才生效
  ai: {
    provider: null,
    apiKey: '',
    // F6(beta 勘误2):自定义 endpoint,空串走 SDK 默认地址
    baseURL: '',
    model: '',
    statusRecheckEnabled: false,
    // BETA-006 v2:默认走 headless(已渲染文本),消除 ANSI 噪音与 PSReadLine
    // 重绘残影。老用户升级后字段缺失也会因为 SettingsManager.merge 走 default。
    statusRecheckSource: 'headless',
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
  // BETA-033
  'one-dark-pro',
  'dracula',
  'tokyo-night',
  'catppuccin-mocha',
  // UI-2
  'catppuccin-latte',
  'tokyo-night-day',
  'light-pink',
  'fairyfloss',
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
    // v1.5+ 迁移:explorerContextMenu 从 settings 移到系统状态,如果老 settings.json
    // 残留这个字段,静默剥掉(避免 deepMerge 原样带进运行时 settings 对象,污染
    // 导入导出归档 + TS 类型断言失败)。
    const migrated = stripUnknownLegacyFields(result.value);
    // 不论从哪加载,都要走一遍 deep merge 防止用户文件少字段
    const merged = deepMerge(DEFAULT_SETTINGS, migrated as DeepPartial<Settings>);
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
    const cleaned = stripUnknownLegacyFields(newSettings);
    const merged = deepMerge(DEFAULT_SETTINGS, cleaned as DeepPartial<Settings>);
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
/**
 * 把已知应被剥除的"已迁移走"字段从读到的 settings 对象里清掉。
 *
 * v1.5+ 起 `systemIntegration.explorerContextMenu` 改为系统状态(查 HKCU/MSIX),
 * 不再驻留 settings.json。老用户文件里残留该字段需在加载/导入时静默丢弃,否则
 * deepMerge 会原样保留它(deepMerge 只看 partial 的键),污染运行时 Settings
 * 对象 + 导出归档。
 *
 * 实现上做一个浅克隆 + 显式 delete,避免动到调用方传入的对象。
 */
export function stripUnknownLegacyFields<T>(raw: T): T {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const ensureClone = (): Record<string, unknown> => {
    if (!next) next = { ...obj };
    return next;
  };

  if (
    obj['systemIntegration'] &&
    typeof obj['systemIntegration'] === 'object' &&
    !Array.isArray(obj['systemIntegration'])
  ) {
    const si = obj['systemIntegration'] as Record<string, unknown>;
    if ('explorerContextMenu' in si) {
      const cloned = ensureClone();
      const siClone = { ...si };
      delete siClone['explorerContextMenu'];
      cloned['systemIntegration'] = siClone;
    }
  }

  // 2026-05-16:'系统'独立分组已废除(桌面/主目录改为安装时默认收藏),
  // 老 settings.json 残留的 appearance.showSystemPaths / appearance.systemPaths
  // 在加载时静默剥掉 — 不剥的话 deepMerge 会把它们带进运行时 Settings 对象 +
  // 导出归档,污染未来读者。
  if (
    obj['appearance'] &&
    typeof obj['appearance'] === 'object' &&
    !Array.isArray(obj['appearance'])
  ) {
    const ap = obj['appearance'] as Record<string, unknown>;
    if ('showSystemPaths' in ap || 'systemPaths' in ap) {
      const cloned = ensureClone();
      const apClone = { ...ap };
      delete apClone['showSystemPaths'];
      delete apClone['systemPaths'];
      cloned['appearance'] = apClone;
    }
  }

  // CURSOR-1(2026-05-17):BETA-006 v2 输入源 'raw'(裸字节 scrollback 末尾)
  // 路径已删除,老 settings.json 残留 ai.statusRecheckSource='raw' 静默 coerce
  // 到 'headless'(唯一可用)。不 coerce 的话 validateSettings 会因枚举不匹
  // 配抛错。
  if (
    obj['ai'] &&
    typeof obj['ai'] === 'object' &&
    !Array.isArray(obj['ai'])
  ) {
    const ai = obj['ai'] as Record<string, unknown>;
    if (ai['statusRecheckSource'] === 'raw') {
      const cloned = ensureClone();
      const aiClone = { ...ai, statusRecheckSource: 'headless' };
      cloned['ai'] = aiClone;
    }
  }

  return (next ?? raw) as T;
}

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
  if (!['auto', 'webgl', 'dom'].includes(s.advanced.terminalRenderer)) {
    throw new SettingsError(
      'InvalidSettings',
      `advanced.terminalRenderer="${s.advanced.terminalRenderer}" 必须是 auto / webgl / dom`,
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
  if (
    !['new-window', 'recent-window-tab'].includes(s.systemIntegration.explorerOpenIn)
  ) {
    throw new SettingsError(
      'InvalidSettings',
      `systemIntegration.explorerOpenIn="${s.systemIntegration.explorerOpenIn}" 必须是 new-window 或 recent-window-tab`,
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
