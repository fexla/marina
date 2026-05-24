/**
 * @file src/renderer/components/SettingsView.tsx
 * @purpose CP-4 设置页面 — view 形态 (替换整个 body),左侧 7 分类导航 +
 *   右侧详情面板,所有设置项即改即生效 (无保存按钮,软件定义书 6.6.1)。
 *
 * @关键设计:
 * - 不是 modal,不是新窗口,而是替换 app body 的 view (用户决策对齐)
 * - 任一窗口里的设置 UI 完全相同;改一处 → main 广播 → 所有窗口同步
 * - 校验失败由 main 端 SettingsManager 抛 InvalidSettings,renderer 显示
 *   错误条但不阻止用户继续输入 (input 内部状态 = main 实际值)
 * - 7 分类按软件定义书 6.6.2 分组:外观 / Shell 与启动 / 行为 / 数据 /
 *   系统集成 / 高级 / 关于
 *
 * @CP-4 chunk 范围:
 * - chunk 1: 骨架 + 主题
 * - chunk 2 (本): 外观/Shell/行为/高级 全部接通;数据/系统集成 留 placeholder;
 *   关于留 placeholder (chunk 5 接构建信息 + 链接)
 * - chunk 4: 数据导入/导出 (data 分类) + 启动模板管理子页 (shell 分类内)
 * - chunk 5: 关于 + 构建信息
 *
 * @对应文档章节: 软件定义书.md 6.6 节 (设置页面)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  COMMAND_CHANNELS,
  type AddTemplatePayload,
  type AddTemplateResponse,
  type ExplorerIntegrationStatus,
  type ImportSettingsResponse,
  type ListShellsResponse,
  type ExportSettingsResponse,
  type SetExplorerIntegrationResponse,
  type UpdateTemplatePayload,
  type UpdateTemplateResponse,
} from '@shared/protocol';
import type {
  NewTerminalShellPolicy,
  PostExitAction,
  StartupBehavior,
  Template,
  TerminalRightClick,
  ThemeId,
  WindowStyle,
} from '@shared/types';
import type { DeepPartial } from '@shared/types-helpers';
import type { Settings } from '@shared/types';
import { useAppDispatch, useAppState } from '../store';
import {
  RECOMMENDED_TERMINAL_FONTS,
  RECOMMENDED_UI_FONTS,
  listAllFonts,
  probeFonts,
  type FontEntry,
} from './font-detection';
import { Icon, type IconName } from './icons';
import { useModal } from './Modal';
import { TemplateIcon } from './TemplateIcon';
import { useToast } from './Toast';
import { useTranslation } from './LanguageProvider';
import { TERMINAL_KEYBINDINGS } from '@shared/terminal-keybindings';

type CategoryId =
  | 'appearance'
  | 'shell'
  | 'behavior'
  | 'data'
  | 'system-integration'
  | 'ai'
  | 'advanced'
  | 'about';

// CP-4 勘误 #11:用 lucide 图标替换原有 Emoji。BETA-031 新增 'AI 助手'。
// BETA-004:title 改 i18n key,渲染时由 t() 转。
const CATEGORIES: Array<{ id: CategoryId; iconName: IconName; titleKey: string }> = [
  { id: 'appearance', iconName: 'appearance', titleKey: 'settings.category.appearance' },
  { id: 'shell', iconName: 'shell', titleKey: 'settings.category.shell' },
  { id: 'behavior', iconName: 'behavior', titleKey: 'settings.category.behavior' },
  { id: 'data', iconName: 'data', titleKey: 'settings.category.data' },
  { id: 'system-integration', iconName: 'systemIntegration', titleKey: 'settings.category.systemIntegration' },
  { id: 'ai', iconName: 'ai', titleKey: 'settings.category.ai' },
  { id: 'advanced', iconName: 'advanced', titleKey: 'settings.category.advanced' },
  { id: 'about', iconName: 'about', titleKey: 'settings.category.about' },
];

// 把 settings update 走 IPC 的副作用集中,所有控件都用这个
async function updateSettings(
  partial: DeepPartial<Settings>,
  setError: (msg: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    await window.api.invoke(COMMAND_CHANNELS.SETTINGS_UPDATE, { partial });
  } catch (err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

export function SettingsView(): JSX.Element {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [active, setActive] = useState<CategoryId>('appearance');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    dispatch({ type: 'view/exit-settings' });
  }, [dispatch]);

  return (
    <div className="settings-view">
      <header className="settings-header">
        <button
          type="button"
          className="settings-close"
          onClick={handleClose}
          title={t('settings.close')}
          aria-label={t('settings.close')}
        >
          ×
        </button>
        <h1 className="settings-title">{t('settings.title')}</h1>
        {errorMsg && (
          <span className="settings-error" role="alert">
            <Icon name="alertTriangle" size={12} /> {errorMsg}
          </span>
        )}
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`settings-nav-item${active === c.id ? ' active' : ''}`}
              onClick={() => setActive(c.id)}
            >
              <span className="settings-nav-icon" aria-hidden="true">
                <Icon name={c.iconName} size={14} />
              </span>
              <span className="settings-nav-label">{t(c.titleKey)}</span>
            </button>
          ))}
        </nav>
        <main className="settings-detail">
          <CategoryPanel categoryId={active} setError={setErrorMsg} />
        </main>
      </div>
    </div>
  );
}

interface CategoryPanelProps {
  categoryId: CategoryId;
  setError: (msg: string | null) => void;
}

function CategoryPanel({ categoryId, setError }: CategoryPanelProps): JSX.Element {
  switch (categoryId) {
    case 'appearance':
      return <AppearancePanel setError={setError} />;
    case 'shell':
      return <ShellPanel setError={setError} />;
    case 'behavior':
      return <BehaviorPanel setError={setError} />;
    case 'data':
      return <DataPanel setError={setError} />;
    case 'system-integration':
      return <SystemIntegrationPanel setError={setError} />;
    case 'ai':
      return <AiPanel setError={setError} />;
    case 'advanced':
      return <AdvancedPanel setError={setError} />;
    case 'about':
      return <AboutPanel />;
    default:
      return <></>;
  }
}

// ──────────────────────────────────────────────────────────────────
// 外观分类
// ──────────────────────────────────────────────────────────────────

const THEMES: Array<{ id: ThemeId; label: string; tone: '深色' | '浅色'; note?: string }> = [
  { id: 'rose-pine', label: 'Rose Pine', tone: '深色', note: '默认' },
  { id: 'rose-pine-dawn', label: 'Rose Pine Dawn', tone: '浅色' },
  { id: 'rose-pine-moon', label: 'Rose Pine Moon', tone: '深色' },
  { id: 'cutie', label: 'Cutie', tone: '浅色', note: 'Kawaii' },
  { id: 'light-pink', label: 'Light Pink', tone: '浅色', note: 'Kawaii' },
  { id: 'fairyfloss', label: 'Fairyfloss', tone: '深色', note: 'Kawaii' },
  { id: 'business', label: 'Business', tone: '深色' },
  { id: 'ubuntu', label: 'Ubuntu', tone: '深色' },
  { id: 'windows-terminal', label: 'Windows Terminal', tone: '深色' },
  // BETA-033 起新增的 4 个流行深色主题
  { id: 'one-dark-pro', label: 'One Dark Pro', tone: '深色' },
  { id: 'dracula', label: 'Dracula', tone: '深色' },
  { id: 'tokyo-night', label: 'Tokyo Night', tone: '深色' },
  { id: 'tokyo-night-day', label: 'Tokyo Night Day', tone: '浅色' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', tone: '深色' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', tone: '浅色' },
];

function AppearancePanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const a = state.settings.appearance;
  const theme = a?.theme ?? 'rose-pine';
  const windowStyle: WindowStyle = a?.windowStyle ?? 'windows';
  const terminalFontFamily = a?.terminalFontFamily ?? '';
  const terminalFontSize = a?.terminalFontSize ?? 13;
  const terminalLineHeight = a?.terminalLineHeight ?? 1.2;
  const uiFontFamily = a?.uiFontFamily ?? '';
  const uiZoom = a?.uiZoom ?? 1;

  const language = a?.language ?? 'system';

  // CP-4 勘误 #3:用 queryLocalFonts 真实枚举系统字体,推荐字体置顶。
  // 异步加载,装载前用 probeFonts(推荐) 快速兜底,UX 上看是"先出推荐再补全"。
  const [terminalFonts, setTerminalFonts] = useState<FontEntry[]>(() =>
    probeFonts(RECOMMENDED_TERMINAL_FONTS),
  );
  const [uiFonts, setUiFonts] = useState<FontEntry[]>(() =>
    probeFonts(RECOMMENDED_UI_FONTS),
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listAllFonts(RECOMMENDED_TERMINAL_FONTS, true),
      listAllFonts(RECOMMENDED_UI_FONTS, false),
    ])
      .then(([term, ui]) => {
        if (cancelled) return;
        setTerminalFonts(term);
        setUiFonts(ui);
      })
      .catch((err) => {
        console.warn('[Appearance] listAllFonts failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">外观</h2>

      <SettingRow
        label={tx('主题', 'Theme')}
        hint={tx('所有窗口立即同步;xterm 颜色与 UI 同步切换', 'Applies to all windows immediately; xterm colors stay in sync')}
      >
        {/* BETA-032:主题选择改纯文本列表 + tone tag,不再色卡 */}
        <ul className="settings-theme-list" role="radiogroup" aria-label={tx('主题', 'Theme')}>
          {THEMES.map((t) => (
            <li
              key={t.id}
              className={`settings-theme-row${theme === t.id ? ' active' : ''}`}
              role="radio"
              aria-checked={theme === t.id}
              tabIndex={0}
              onClick={() =>
                void updateSettings({ appearance: { theme: t.id } }, setError)
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void updateSettings({ appearance: { theme: t.id } }, setError);
                }
              }}
            >
              <span className="theme-name">{t.label}</span>
              <span className={`theme-tone-tag tone-${t.tone === '深色' ? 'dark' : 'light'}`}>
                {t.tone === '深色' ? tx('深色', 'Dark') : tx('浅色', 'Light')}
                {t.note ? ` · ${t.note === '默认' ? tx('默认', 'Default') : t.note}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </SettingRow>

      <SettingRow
        label={tx('窗口风格', 'Window style')}
        hint={tx('影响标题栏布局与窗口控制按钮位置(不影响主题配色)', 'Title bar layout and control button position (does not affect theme colors)')}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="window-style"
              value="windows"
              checked={windowStyle === 'windows'}
              onChange={() =>
                void updateSettings(
                  { appearance: { windowStyle: 'windows' as WindowStyle } },
                  setError,
                )
              }
            />
            Windows(按钮在右,方形)
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="window-style"
              value="macos"
              checked={windowStyle === 'macos'}
              onChange={() =>
                void updateSettings(
                  { appearance: { windowStyle: 'macos' as WindowStyle } },
                  setError,
                )
              }
            />
            macOS(三色 traffic light 在左,圆形)
          </label>
        </div>
      </SettingRow>

      <SettingRow label={tx('终端字体', 'Terminal font')} hint={tx('系统已安装的等宽字体 + 推荐字体', 'Installed monospace fonts + recommended')}>
        <FontPicker
          value={terminalFontFamily}
          fonts={terminalFonts}
          onChange={(value) =>
            void updateSettings(
              { appearance: { terminalFontFamily: value } },
              setError,
            )
          }
        />
      </SettingRow>

      <SettingRow label={tx('终端字号', 'Terminal font size')} hint={tx('范围 8 - 24', 'Range 8 - 24')}>
        <NumberInput
          value={terminalFontSize}
          min={8}
          max={24}
          step={1}
          onChange={(v) =>
            void updateSettings({ appearance: { terminalFontSize: v } }, setError)
          }
        />
      </SettingRow>

      <SettingRow label={tx('终端行高', 'Terminal line height')} hint={tx('范围 1.0 - 2.0', 'Range 1.0 - 2.0')}>
        <NumberInput
          value={terminalLineHeight}
          min={1}
          max={2}
          step={0.05}
          onChange={(v) =>
            void updateSettings({ appearance: { terminalLineHeight: v } }, setError)
          }
        />
      </SettingRow>

      <SettingRow label={tx('UI 字体', 'UI font')} hint={tx('侧栏 / 按钮 / 标签等 UI 区域', 'Sidebar / buttons / tabs and other UI areas')}>
        <FontPicker
          value={uiFontFamily}
          fonts={uiFonts}
          onChange={(value) =>
            void updateSettings({ appearance: { uiFontFamily: value } }, setError)
          }
        />
      </SettingRow>

      <SettingRow label={tx('UI 缩放', 'UI zoom')} hint={tx('范围 75% - 150%,影响整个 UI 字号', 'Range 75% - 150%, affects all UI font sizes')}>
        <NumberInput
          value={uiZoom}
          min={0.75}
          max={1.5}
          step={0.05}
          formatPercent
          onChange={(v) =>
            void updateSettings({ appearance: { uiZoom: v } }, setError)
          }
        />
      </SettingRow>

      {/* BETA-004:语言切换 */}
      <SettingRow
        label={tx('语言', 'Language')}
        hint={tx("切换 UI 显示语言;'跟随系统'下 zh-* 系统显示中文,其他显示英文", "Switch UI language; 'Follow system' picks Chinese for zh-* locales, English otherwise")}
      >
        <select
          className="settings-input"
          value={language}
          onChange={(e) =>
            void updateSettings(
              { appearance: { language: e.target.value as 'system' | 'zh-CN' | 'en-US' } },
              setError,
            )
          }
        >
          <option value="system">{tx('跟随系统', 'Follow system')}</option>
          <option value="zh-CN">中文</option>
          <option value="en-US">English</option>
        </select>
      </SettingRow>

      {/* BETA-023:macOS 风格红绿灯悬浮符号 */}
      {windowStyle === 'macos' && (
        <SettingRow
          label={tx('红绿灯悬浮符号', 'Traffic-light hover symbols')}
          hint={tx('macOS 风格下,鼠标移到红绿灯按钮上是否显示 ×/−/+;默认关(更克制)', 'Show ×/−/+ when hovering traffic-light buttons in macOS style; off by default (more minimal)')}
        >
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={a?.macOSTrafficLightHoverSymbols ?? false}
              onChange={(e) =>
                void updateSettings(
                  { appearance: { macOSTrafficLightHoverSymbols: e.target.checked } },
                  setError,
                )
              }
            />
            <span>启用</span>
          </label>
        </SettingRow>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Shell 与启动分类
// ──────────────────────────────────────────────────────────────────

function ShellPanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const sh = state.settings.shell;
  const defaultShellId = sh?.defaultShellId ?? '';
  const policy = sh?.newTerminalShellPolicy ?? 'default';

  const [shells, setShells] = useState<
    Array<{ id: string; displayName: string; executablePath: string }>
  >([]);
  const [templateMode, setTemplateMode] = useState<
    | { kind: 'list' }
    | { kind: 'edit'; templateId: string | null /* null = 新建 */ }
  >({ kind: 'list' });

  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, ListShellsResponse>(
        COMMAND_CHANNELS.SETTINGS_LIST_SHELLS,
        {},
      )
      .then((res) => {
        if (!cancelled) setShells(res.shells);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(tx(`枚举可用 shell 失败:${msg}`, `Failed to enumerate shells: ${msg}`));
      });
    return () => {
      cancelled = true;
    };
  }, [setError]);

  if (templateMode.kind === 'edit') {
    return (
      <TemplateEditor
        templateId={templateMode.templateId}
        onClose={() => setTemplateMode({ kind: 'list' })}
        setError={setError}
      />
    );
  }

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('Shell 与启动', 'Shell & Startup')}</h2>

      <SettingRow label={tx('默认 shell', 'Default shell')} hint={tx('新终端启动时使用的 shell', 'Shell used when a new terminal starts')}>
        <select
          className="settings-input"
          value={defaultShellId}
          onChange={(e) =>
            void updateSettings(
              { shell: { defaultShellId: e.target.value } },
              setError,
            )
          }
        >
          <option value="">{tx('自动检测最优(pwsh > powershell > cmd)', 'Auto-detect best (pwsh > powershell > cmd)')}</option>
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName} — {s.executablePath}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={tx('新终端使用的 shell', 'Shell for new terminals')}
        hint={tx('"默认 shell"或"上次用过的 shell"', '"Default shell" or "Last used shell"')}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-policy"
              value="default"
              checked={policy === 'default'}
              onChange={() =>
                void updateSettings(
                  {
                    shell: {
                      newTerminalShellPolicy: 'default' as NewTerminalShellPolicy,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('使用默认 shell', 'Use default shell')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-policy"
              value="last-used"
              checked={policy === 'last-used'}
              onChange={() =>
                void updateSettings(
                  {
                    shell: {
                      newTerminalShellPolicy: 'last-used' as NewTerminalShellPolicy,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('使用上次用过的 shell', 'Use last used shell')}
          </label>
        </div>
      </SettingRow>

      <SettingRow label={tx('启动模板', 'Launch templates')} hint={tx('新建终端时可选的模板;内置不可删,可改名', 'Templates for new terminals; built-ins can be renamed but not deleted')}>
        <TemplateList
          onEdit={(id) => setTemplateMode({ kind: 'edit', templateId: id })}
          onCreate={() => setTemplateMode({ kind: 'edit', templateId: null })}
          setError={setError}
        />
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 启动模板列表 (内嵌在 ShellPanel 中)
// ──────────────────────────────────────────────────────────────────

function TemplateList({
  onEdit,
  onCreate,
  setError,
}: {
  onEdit: (id: string) => void;
  onCreate: () => void;
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const templates = state.templates;
  const defaultId = state.defaultTemplateId;
  const modal = useModal();

  const handleSetDefault = (id: string): void => {
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.TEMPLATE_SET_DEFAULT, { id })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleDelete = async (id: string): Promise<void> => {
    // CPB-P2 / FOC-5 一致化:原生 confirm 关闭后焦点不可控,且不走主题样式。
    // 统一走 modal.confirm,与项目其他危险操作风格一致。
    const ok = await modal.confirm({
      title: tx('删除自定义模板', 'Delete custom template'),
      message: tx(
        '该操作不可撤销。删除后任何引用此模板的会话仍可运行,但新建终端时不会再出现。',
        'This action cannot be undone. Existing sessions keep running, but new terminals will no longer offer this template.',
      ),
      confirmLabel: tx('删除', 'Delete'),
      danger: true,
    });
    if (!ok) return;
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.TEMPLATE_DELETE, { id })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div className="template-list">
      {templates.map((t) => (
        <div key={t.id} className="template-list-item">
          <span className="template-list-icon">
            {/* P2-14:与 MainPane.TemplateLaunchButton 一致 — builtin 走 lucide
                矢量,自定义模板 fallback emoji。原 {t.icon} 让 builtin 列表里
                也只显示 emoji 与启动按钮视觉脱节。 */}
            <TemplateIcon template={t} size={16} />
          </span>
          <span className="template-list-name">{t.name}</span>
          {t.isBuiltin && <span className="template-list-tag">{tx('内置', 'Built-in')}</span>}
          {t.id === defaultId && <span className="template-list-tag default">{tx('默认', 'Default')}</span>}
          <span className="template-list-cmd" title={t.command || tx('(纯 shell)', '(plain shell)')}>
            {t.command || tx('(纯 shell)', '(plain shell)')}
          </span>
          <div className="template-list-actions">
            {t.id !== defaultId && (
              <button
                type="button"
                className="settings-button"
                onClick={() => handleSetDefault(t.id)}
              >
                {tx('设为默认', 'Set as default')}
              </button>
            )}
            <button
              type="button"
              className="settings-button"
              onClick={() => onEdit(t.id)}
            >
              {tx('编辑', 'Edit')}
            </button>
            {!t.isBuiltin && (
              <button
                type="button"
                className="settings-button danger"
                onClick={() => void handleDelete(t.id)}
              >
                {tx('删除', 'Delete')}
              </button>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="settings-button"
        style={{ marginTop: 8, alignSelf: 'flex-start' }}
        onClick={onCreate}
      >
        {tx('+ 新建自定义模板', '+ New custom template')}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 启动模板编辑器
// ──────────────────────────────────────────────────────────────────

function TemplateEditor({
  templateId,
  onClose,
  setError,
}: {
  templateId: string | null;
  onClose: () => void;
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const isCreate = templateId === null;
  const existing = templateId ? state.templates.find((t) => t.id === templateId) : null;

  const [draft, setDraft] = useState<Template>(() => {
    if (existing) {
      return {
        ...existing,
        args: [...existing.args],
        env: { ...existing.env },
      };
    }
    return {
      id: '',
      name: '',
      icon: '🔧',
      isBuiltin: false,
      command: '',
      args: [],
      env: {},
      shellFirst: true,
      postExitAction: 'keep_shell' as PostExitAction,
    };
  });

  const [argsText, setArgsText] = useState<string>(() => draft.args.join(' '));
  const [envText, setEnvText] = useState<string>(() =>
    Object.entries(draft.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const parsedArgs = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      const parsedEnv: Record<string, string> = {};
      for (const line of envText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) {
          throw new Error(tx(`环境变量行格式错: "${line}" 应为 KEY=VALUE`, `Invalid env line "${line}", expected KEY=VALUE`));
        }
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1);
        if (!key) throw new Error(tx(`环境变量名不能为空: "${line}"`, `Env var name cannot be empty: "${line}"`));
        parsedEnv[key] = value;
      }

      if (isCreate) {
        const payload: AddTemplatePayload = {
          name: draft.name,
          icon: draft.icon,
          command: draft.command,
          args: parsedArgs,
          env: parsedEnv,
          shellFirst: draft.shellFirst,
          postExitAction: draft.postExitAction,
        };
        await window.api.invoke<AddTemplatePayload, AddTemplateResponse>(
          COMMAND_CHANNELS.TEMPLATE_ADD,
          payload,
        );
      } else {
        const payload: UpdateTemplatePayload = {
          id: draft.id,
          partial: {
            name: draft.name,
            icon: draft.icon,
            command: draft.command,
            args: parsedArgs,
            env: parsedEnv,
            shellFirst: draft.shellFirst,
            postExitAction: draft.postExitAction,
          },
        };
        await window.api.invoke<UpdateTemplatePayload, UpdateTemplateResponse>(
          COMMAND_CHANNELS.TEMPLATE_UPDATE,
          payload,
        );
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">
        <button
          type="button"
          className="settings-button"
          style={{ marginRight: 8 }}
          onClick={onClose}
        >
          {tx('< 返回', '< Back')}
        </button>
        {isCreate ? tx('新建模板', 'New template') : tx(`编辑模板:${draft.name}`, `Edit template: ${draft.name}`)}
        {draft.isBuiltin && (
          <span className="template-list-tag" style={{ marginLeft: 8 }}>
            {tx('内置(可改 name/icon/command/args/env,不可删)', 'Built-in (editable, not deletable)')}
          </span>
        )}
      </h2>

      <SettingRow label={tx('名称', 'Name')}>
        <input
          type="text"
          className="settings-input"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={tx('例如:My Claude', 'e.g. My Claude')}
        />
      </SettingRow>

      <SettingRow label={tx('图标 (emoji)', 'Icon (emoji)')}>
        <input
          type="text"
          className="settings-input"
          value={draft.icon}
          onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
          placeholder="🔧"
          maxLength={4}
          style={{ minWidth: 60 }}
        />
      </SettingRow>

      <SettingRow label={tx('命令', 'Command')} hint={tx('留空表示启动纯 shell;不要写 shell 路径,Marina 会自动注入 shell', 'Leave empty for plain shell; do not specify the shell binary, Marina injects it')}>
        <input
          type="text"
          className="settings-input"
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          placeholder={tx('例如:claude / codex / 留空', 'e.g. claude / codex / leave empty')}
        />
      </SettingRow>

      <SettingRow label={tx('参数', 'Arguments')} hint={tx('空格分隔(简单 shell quoting,有空格的参数请避免)', 'Space-separated (avoid args with spaces — simple shell quoting only)')}>
        <input
          type="text"
          className="settings-input"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={tx('例如:--foo bar --baz', 'e.g. --foo bar --baz')}
        />
      </SettingRow>

      <SettingRow
        label={tx('环境变量', 'Environment variables')}
        hint={tx('每行一个 KEY=VALUE。默认遮罩,点👁切显示(防被旁人看到 API key)', 'One KEY=VALUE per line. Masked by default; click 👁 to reveal (avoid leaking API keys)')}
      >
        <EnvTextarea value={envText} onChange={setEnvText} />
      </SettingRow>

      <SettingRow
        label={tx('启动方式', 'Launch mode')}
        hint={tx('"先启动 shell"让命令退出后用户能继续看到 shell 提示符;"直接运行命令"启动更快', '"Shell first" keeps a prompt visible after the command exits; "Run command directly" is faster to start')}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-first"
              checked={draft.shellFirst}
              onChange={() => setDraft({ ...draft, shellFirst: true })}
            />
            {tx('先启动 shell 再运行命令', 'Start shell, then run command')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-first"
              checked={!draft.shellFirst}
              onChange={() => setDraft({ ...draft, shellFirst: false })}
            />
            {tx('直接运行命令', 'Run command directly')}
          </label>
        </div>
      </SettingRow>

      <SettingRow label={tx('命令退出后', 'After command exits')}>
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="post-exit"
              checked={draft.postExitAction === 'keep_shell'}
              onChange={() =>
                setDraft({ ...draft, postExitAction: 'keep_shell' as PostExitAction })
              }
            />
            {tx('留在 shell(若启动方式为先 shell)', 'Stay in shell (only if "Shell first")')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="post-exit"
              checked={draft.postExitAction === 'close_session'}
              onChange={() =>
                setDraft({
                  ...draft,
                  postExitAction: 'close_session' as PostExitAction,
                })
              }
            />
            {tx('关闭 session', 'Close session')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="post-exit"
              checked={draft.postExitAction === 'hold'}
              onChange={() =>
                setDraft({ ...draft, postExitAction: 'hold' as PostExitAction })
              }
            />
            {tx('保留显示,等待用户手动关闭', 'Hold view until user closes manually')}
          </label>
        </div>
      </SettingRow>

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="settings-button"
          onClick={() => void handleSave()}
          disabled={saving || !draft.name.trim()}
          style={{
            background: 'var(--color-accent-special, #f0f)',
            color: 'var(--color-bg-primary, #f0f)',
            borderColor: 'var(--color-accent-special, #f0f)',
          }}
        >
          {saving ? tx('保存中…', 'Saving…') : isCreate ? tx('创建', 'Create') : tx('保存', 'Save')}
        </button>
        <button type="button" className="settings-button" onClick={onClose}>
          {tx('取消', 'Cancel')}
        </button>
      </div>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 行为分类
// ──────────────────────────────────────────────────────────────────

function BehaviorPanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const b = state.settings.behavior;
  const startupBehavior = b?.startupBehavior ?? 'open-window';
  const confirmOnQuit = b?.confirmOnQuit ?? true;
  const selectOnCopy = b?.selectOnCopy ?? true;
  const terminalRightClick = b?.terminalRightClick ?? 'menu';

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('行为', 'Behavior')}</h2>

      <SettingRow label={tx('启动时行为', 'Startup behavior')} hint={tx('配开机启动用', 'Used together with auto-start at login')}>
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="startup"
              value="open-window"
              checked={startupBehavior === 'open-window'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      startupBehavior: 'open-window' as StartupBehavior,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('打开一个窗口', 'Open a window')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="startup"
              value="tray-only"
              checked={startupBehavior === 'tray-only'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      startupBehavior: 'tray-only' as StartupBehavior,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('仅启动到托盘', 'Tray only')}
          </label>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('完全退出前确认', 'Confirm before full quit')}
        hint={tx('托盘点"完全退出"且有 session 在跑时弹确认。关单窗口永远不弹', 'Asks for confirmation when quitting from the tray with active sessions. Never asked when closing a single window.')}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={confirmOnQuit}
            onChange={(e) =>
              void updateSettings(
                { behavior: { confirmOnQuit: e.target.checked } },
                setError,
              )
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      <SettingRow label={tx('选中即复制', 'Copy on select')} hint={tx('终端选中文本自动复制(类 Linux)', 'Automatically copy selected text in terminal (Linux style)')}>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={selectOnCopy}
            onChange={(e) =>
              void updateSettings(
                { behavior: { selectOnCopy: e.target.checked } },
                setError,
              )
            }
          />
          <span>{tx('启用', 'Enable')}</span>
        </label>
      </SettingRow>

      <SettingRow label={tx('终端右键行为', 'Terminal right-click action')} hint={tx('弹菜单 或 直接粘贴', 'Show menu or paste directly')}>
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="rclick"
              value="menu"
              checked={terminalRightClick === 'menu'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      terminalRightClick: 'menu' as TerminalRightClick,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('弹菜单', 'Show menu')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="rclick"
              value="paste"
              checked={terminalRightClick === 'paste'}
              onChange={() =>
                void updateSettings(
                  {
                    behavior: {
                      terminalRightClick: 'paste' as TerminalRightClick,
                    },
                  },
                  setError,
                )
              }
            />
            {tx('直接粘贴', 'Paste directly')}
          </label>
        </div>
      </SettingRow>

      <KeybindingsReference />
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 终端快捷键速查(KBD-1 整改,2026-05-24)— 数据源:terminal-keybindings.ts
//
// spec §7.2.2 写明唯一权威清单在代码侧的 TERMINAL_KEYBINDINGS,本卡片直接
// 渲染该数组,保证 spec / 代码 / UI 三处永不漂移。
//
// macOS 检测:用 navigator.platform(renderer 不能读 process.platform)。
// 命中 mac 时优先显示 specMac,否则 spec。
// ──────────────────────────────────────────────────────────────────

function KeybindingsReference(): JSX.Element {
  const { tx } = useTranslation();
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return (
    <div className="settings-keybindings-card">
      <h3 className="settings-keybindings-title">
        {tx('终端快捷键速查', 'Terminal keybindings')}
      </h3>
      <p className="settings-keybindings-hint">
        {tx(
          '此清单为唯一权威。Marina 不支持其他应用内快捷键(spec §7.1)。',
          'Authoritative list. Marina does not support any other in-app shortcuts (spec §7.1).',
        )}
      </p>
      <table className="settings-keybindings-table">
        <thead>
          <tr>
            <th>{tx('键位', 'Key')}</th>
            <th>{tx('功能', 'Function')}</th>
          </tr>
        </thead>
        <tbody>
          {TERMINAL_KEYBINDINGS.map((b) => (
            <tr key={b.id}>
              <td>
                <kbd>{isMac && b.specMac ? b.specMac : b.spec}</kbd>
              </td>
              <td>{b.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 数据分类 (chunk 4 完整接通,chunk 2 仅 "打开数据目录")
// ──────────────────────────────────────────────────────────────────

function DataPanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  // BETA-039:从主进程取真实 userData 路径(app.getPath('userData')),
  // portable / dev / 自定义 userData 场景下 UI 都准确;首次渲染前显示占位。
  const [dataDir, setDataDir] = useState<string>('…');
  useEffect(() => {
    let cancelled = false;
    window.api
      .invoke<unknown, { dataDir: string }>(COMMAND_CHANNELS.SYSTEM_GET_DATA_DIR, {})
      .then((res) => {
        if (!cancelled && res?.dataDir) setDataDir(res.dataDir);
      })
      .catch(() => {
        // 静默:UI 退回到占位文本;真实路径取不到不影响其他功能。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenDataDir = (): void => {
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_DATA_DIR, {})
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleExport = async (): Promise<void> => {
    setError(null);
    setLastExportPath(null);
    setBusy('export');
    try {
      const res = await window.api.invoke<unknown, ExportSettingsResponse>(
        COMMAND_CHANNELS.SETTINGS_EXPORT,
        {},
      );
      if (res.filePath) setLastExportPath(res.filePath);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async (): Promise<void> => {
    setError(null);
    setBusy('import');
    try {
      const res = await window.api.invoke<unknown, ImportSettingsResponse>(
        COMMAND_CHANNELS.SETTINGS_IMPORT,
        {},
      );
      if (res.status === 'error') {
        setError(tx(`导入失败:${res.errorMessage ?? '未知错误'}`, `Import failed: ${res.errorMessage ?? 'unknown error'}`));
      }
      // 'imported' / 'cancelled' 不需提示;'imported' 之后 main 会立即 relaunch
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('数据', 'Data')}</h2>

      <SettingRow label={tx('数据目录', 'Data directory')} hint={tx('所有 Marina 配置文件存放处', 'Where all Marina configuration files live')}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="settings-info-text" title={dataDir}>{dataDir}</span>
          <button type="button" className="settings-button" onClick={handleOpenDataDir}>
            {tx('在文件管理器中打开', 'Open in file manager')}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label={tx('导出设置', 'Export settings')}
        hint={tx('把全部配置(收藏 / 最近 / 模板 / 设置)导出为 JSON 文件', 'Export everything (bookmarks / recent / templates / settings) to a JSON file')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            className="settings-button"
            disabled={busy !== null}
            onClick={() => void handleExport()}
          >
            {busy === 'export' ? tx('导出中…', 'Exporting…') : tx('导出…', 'Export…')}
          </button>
          {lastExportPath && (
            <span className="settings-info-text" style={{ fontSize: 11 }}>
              {tx('已导出到', 'Exported to')}: {lastExportPath}
            </span>
          )}
        </div>
      </SettingRow>

      <SettingRow
        label={tx('导入设置', 'Import settings')}
        hint={tx('选择导出文件,二次确认后整体替换并重启应用', 'Pick an export file; after a confirm, everything is replaced and the app restarts')}
      >
        <button
          type="button"
          className="settings-button"
          disabled={busy !== null}
          onClick={() => void handleImport()}
        >
          {busy === 'import' ? tx('导入中…', 'Importing…') : tx('导入…', 'Import…')}
        </button>
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 系统集成分类 — Explorer 右键 "在 Marina 终端中打开"
//
// 经典菜单(HKCU 注册表)和 Win11 新菜单(MSIX + 证书)各自独立卡片,
// 独立开关。状态来自现场查 HKCU / Get-AppxPackage(IPC),不进 settings.json。
// 仅 installed 构建可写;dev / portable 全部置灰。
// ──────────────────────────────────────────────────────────────────

function SystemIntegrationPanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const sys = state.settings?.systemIntegration;
  const openIn = sys?.explorerOpenIn ?? 'new-window';
  const autoStart = state.settings.behavior?.autoStart ?? false;
  const toast = useToast();

  const [status, setStatus] = useState<ExplorerIntegrationStatus | null>(null);
  const [busy, setBusy] = useState<'classic' | 'modern' | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await window.api.invoke<undefined, ExplorerIntegrationStatus>(
        COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_STATUS,
        undefined,
      );
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [setError]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSet = async (
    kind: 'classic' | 'modern',
    enabled: boolean,
  ): Promise<void> => {
    setError(null);
    setBusy(kind);
    try {
      const channel =
        kind === 'classic'
          ? COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_CLASSIC
          : COMMAND_CHANNELS.EXPLORER_INTEGRATION_SET_MODERN;
      const res = await window.api.invoke<
        { enabled: boolean },
        SetExplorerIntegrationResponse
      >(channel, { enabled });
      setStatus(res.status);
      if (!res.ok) {
        setError(res.message || `操作失败 (${kind})`);
      } else if (kind === 'modern') {
        // BETA-044:Win11 新菜单 install/uninstall 后,MSIX 加载有 OS 级延迟
        // (不是 Marina bug)。提示用户重启电脑确保生效;不做"一键重启 Explorer"
        // 按钮(用户选了最保守的方案)。详见 docs/known-issues.md。
        toast.push({
          kind: 'info',
          message: tx('右键菜单已更新,确保设置生效请重启计算机', 'Context menu updated. Restart the computer to ensure the change takes effect.'),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('系统集成', 'System integration')}</h2>

      <SettingRow
        label={tx('开机启动', 'Launch on login')}
        hint={tx('系统启动时自动启动 Marina', 'Automatically start Marina when the system starts')}
      >
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) =>
              void updateSettings(
                { behavior: { autoStart: e.target.checked } },
                setError,
              )
            }
          />
          <span>{tx('开机启动', 'Launch on login')}</span>
        </label>
      </SettingRow>

      {/* —— Win11 新菜单卡片 —— */}
      <ExplorerIntegrationCard
        title={tx('Win11 新菜单', 'Win11 modern menu')}
        subtitle={tx('圆角右键菜单,无需展开「显示更多选项」;走 IExplorerCommand,需 MSIX 包 + 证书', 'Modern right-click menu; uses IExplorerCommand, requires MSIX package + cert')}
        status={status?.modern}
        unsupportedReason={status?.modernUnsupportedReason ?? null}
        busy={busy === 'modern'}
        onToggle={(next) => void handleSet('modern', next)}
        detail={
          status?.modern === 'enabled' && status.package ? (
            <div className="explorer-integration-meta">
              <div>
                <strong>{tx('包:', 'Package:')}</strong> {status.package.name} {status.package.version}
              </div>
              <div className="text-muted" style={{ wordBreak: 'break-all' }}>
                {status.package.installLocation}
              </div>
            </div>
          ) : null
        }
        certInfo={status?.cert ?? null}
      />

      {/* —— 经典右键菜单卡片 —— */}
      <ExplorerIntegrationCard
        title={tx('经典右键菜单', 'Classic right-click menu')}
        subtitle={tx('HKCU 注册表项,藏在「显示更多选项」内;Win10 / Win11 通用,无 UAC、无证书', 'HKCU registry entries, under "Show more options"; works on Win10 / Win11, no UAC or cert needed')}
        status={status?.classic}
        unsupportedReason={status?.classicUnsupportedReason ?? null}
        busy={busy === 'classic'}
        onToggle={(next) => void handleSet('classic', next)}
        detail={null}
        certInfo={null}
      />

      {/* —— 打开方式(纯偏好,保留在 settings.json) —— */}
      <SettingRow
        label={tx('打开方式', 'Open in')}
        hint={tx('Marina 已在运行时,从 Explorer 触发的新会话开在哪里', 'When Marina is already running, where new sessions from the file manager appear')}
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="explorer-open-in"
              value="new-window"
              checked={openIn === 'new-window'}
              onChange={() =>
                void updateSettings(
                  { systemIntegration: { explorerOpenIn: 'new-window' } },
                  setError,
                )
              }
            />
            {tx('新窗口打开', 'New window')}
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="explorer-open-in"
              value="recent-window-tab"
              checked={openIn === 'recent-window-tab'}
              onChange={() =>
                void updateSettings(
                  {
                    systemIntegration: { explorerOpenIn: 'recent-window-tab' },
                  },
                  setError,
                )
              }
            />
            {tx('在最近活动的窗口新开标签', 'New tab in the most recently active window')}
          </label>
        </div>
      </SettingRow>
    </section>
  );
}

interface ExplorerIntegrationCardProps {
  title: string;
  subtitle: string;
  status: ExplorerIntegrationStatus['classic'] | undefined;
  unsupportedReason: string | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  detail: ReactNode;
  certInfo: ExplorerIntegrationStatus['cert'];
}

function ExplorerIntegrationCard({
  title,
  subtitle,
  status,
  unsupportedReason,
  busy,
  onToggle,
  detail,
  certInfo,
}: ExplorerIntegrationCardProps): JSX.Element {
  const { tx } = useTranslation();
  const isUnsupported = status === 'unsupported';
  const isEnabled = status === 'enabled';
  const disabled = isUnsupported || busy || status === undefined;

  const statusLabel = (() => {
    if (status === undefined) return tx('查询中…', 'Querying…');
    if (status === 'unsupported') return tx('不可用', 'Unavailable');
    if (status === 'enabled') return tx('已启用', 'Enabled');
    return tx('未启用', 'Disabled');
  })();

  return (
    <div className="explorer-integration-card">
      <div className="explorer-integration-header">
        <div>
          <div className="explorer-integration-title">{title}</div>
          <div className="explorer-integration-subtitle">{subtitle}</div>
        </div>
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={isEnabled}
            disabled={disabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>{busy ? tx('处理中…', 'Working…') : statusLabel}</span>
        </label>
      </div>

      {isUnsupported && unsupportedReason && (
        <div className="explorer-integration-unsupported">{unsupportedReason}</div>
      )}

      {detail}

      {certInfo && (
        <div className="explorer-integration-meta">
          <div>
            <strong>{tx('证书:', 'Cert:')}</strong> {certInfo.subject}
          </div>
          <div className="text-muted">
            {tx('指纹', 'Fingerprint')} {certInfo.thumbprint.slice(0, 8)}…{certInfo.thumbprint.slice(-4)} · {tx('至', 'until')}{' '}
            {new Date(certInfo.notAfter).toISOString().slice(0, 10)} · {tx('已信任', 'trusted')}
          </div>
        </div>
      )}

    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// AI 助手分类(BETA-031)
// ──────────────────────────────────────────────────────────────────

function AiPanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const toast = useToast();
  const ai = state.settings.ai;
  const provider = ai?.provider ?? null;
  const apiKey = ai?.apiKey ?? '';
  const baseURL = ai?.baseURL ?? '';
  const model = ai?.model ?? '';
  const statusRecheckEnabled = ai?.statusRecheckEnabled ?? false;
  const statusRecheckSource = ai?.statusRecheckSource ?? 'headless';
  const [testing, setTesting] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const handleTest = async (): Promise<void> => {
    setError(null);
    setTesting(true);
    try {
      const res = await window.api.invoke<undefined, { ok: boolean; message: string }>(
        COMMAND_CHANNELS.AI_TEST_CONNECTION,
        undefined,
      );
      toast.push({
        kind: res.ok ? 'success' : 'error',
        message: res.message || (res.ok ? tx('连接成功', 'Connected') : tx('连接失败', 'Connection failed')),
      });
    } catch (err) {
      toast.push({
        kind: 'error',
        message: tx(`测试失败:${err instanceof Error ? err.message : String(err)}`, `Test failed: ${err instanceof Error ? err.message : String(err)}`),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('AI 助手', 'AI Assistant')}</h2>
      <p className="settings-panel-hint">
        {tx(
          'Marina 第一个 LLM 集成点。当前唯一用途是 BETA-006:active→idle 跃迁前让 LLM 看一眼 scrollback,避免 Vite 等长输出工具被误判 idle。所有 API 调用走主进程,不暴露 key 到 renderer。',
          "Marina's first LLM integration. Current use: BETA-006 status recheck — let the LLM glance at the scrollback before active→idle transition, so long-running tools like Vite aren't falsely marked idle. All API calls go through the main process; the key is never exposed to the renderer.",
        )}
      </p>

      <SettingRow label={tx('服务商', 'Provider')} hint={tx('选择后才会激活其它字段', 'Other fields activate after you pick a provider')}>
        <select
          className="settings-input"
          value={provider ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            void updateSettings(
              {
                ai: { provider: v === '' ? null : (v as 'anthropic' | 'openai') },
              },
              setError,
            );
          }}
        >
          <option value="">{tx('未启用', 'Disabled')}</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </SettingRow>

      {provider !== null && (
        <>
          <SettingRow label={tx('API key', 'API key')} hint={tx('存储于本地 settings.json,导出时会带出', 'Stored locally in settings.json and included when exporting')}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type={showKey ? 'text' : 'password'}
                className="settings-input"
                value={apiKey}
                placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                onChange={(e) =>
                  void updateSettings({ ai: { apiKey: e.target.value } }, setError)
                }
                style={{ minWidth: 280 }}
              />
              <button
                type="button"
                className="settings-button"
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? tx('隐藏', 'Hide') : tx('显示', 'Show')}
              </button>
            </div>
          </SettingRow>

          <SettingRow
            label={tx('Base URL', 'Base URL')}
            hint={tx('留空走官方默认;代理网关 / Azure OpenAI / 自托管 LLM 在此覆盖', 'Empty = official default; override here for proxy / Azure OpenAI / self-hosted LLM')}
          >
            <input
              type="text"
              className="settings-input"
              value={baseURL}
              placeholder={
                provider === 'anthropic'
                  ? 'https://api.anthropic.com'
                  : 'https://api.openai.com/v1'
              }
              onChange={(e) =>
                void updateSettings({ ai: { baseURL: e.target.value } }, setError)
              }
              style={{ minWidth: 320 }}
              spellCheck={false}
            />
          </SettingRow>

          <SettingRow label={tx('模型', 'Model')} hint={tx('留空走默认(haiku / gpt-4o-mini)', 'Empty = default (haiku / gpt-4o-mini)')}>
            <input
              type="text"
              className="settings-input"
              value={model}
              placeholder={
                provider === 'anthropic'
                  ? 'claude-haiku-4-5-20251001'
                  : 'gpt-4o-mini'
              }
              onChange={(e) =>
                void updateSettings({ ai: { model: e.target.value } }, setError)
              }
              style={{ minWidth: 280 }}
            />
          </SettingRow>

          <SettingRow label={tx('测试连接', 'Test connection')} hint={tx('跑一次最小 ping 请求验证 key 有效', 'Run a minimal ping to verify the key works')}>
            <button
              type="button"
              className="settings-button"
              onClick={() => void handleTest()}
              disabled={testing || !apiKey.trim()}
            >
              {testing ? tx('测试中…', 'Testing…') : tx('测试连接', 'Test connection')}
            </button>
          </SettingRow>

          <div className="settings-privacy-notice" role="note">
            <strong>{tx('隐私提示', 'Privacy notice')}</strong> · {tx(
              '开启"状态复核"后,Marina 在每次 active→idle 跃迁时会把以下数据通过 HTTPS 发送给你配置的 AI 服务商(可能是第三方,如 Kimi / DeepSeek / OpenAI / Anthropic):',
              'When "Status recheck" is on, Marina sends the following over HTTPS to the AI provider you configured (may be a third party such as Kimi / DeepSeek / OpenAI / Anthropic) on each active→idle transition:',
            )}
            <ul>
              <li>
                <strong>{tx('终端尾部内容', 'Terminal tail content')}</strong> — {tx(
                  '最近约 40 行已渲染文本(会包含你看到的命令、输出、错误信息、API 输出等)',
                  'Last ~40 rendered lines (commands, output, error messages, API responses, etc.)',
                )}
              </li>
              <li>
                <strong>{tx('按键时间元数据', 'Keystroke timing metadata')}</strong> — {tx(
                  '最近 ≤20 个按键的',
                  'Up to 20 most recent keystrokes:',
                )}
                <em>{tx('时间戳 + 类别', 'timestamps + categories')}</em>{tx(
                  '(char / enter / backspace / other),',
                  ' (char / enter / backspace / other), ',
                )}
                <strong>{tx('不包含按键内容', 'NOT the key content')}</strong>{tx(
                  ',不会泄露密码 / token / 命令体',
                  ' — passwords / tokens / command bodies are never sent',
                )}
              </li>
            </ul>
            {tx(
              '如果你正在处理敏感信息(密码、私有代码、客户数据),建议先关闭复核;纯 Anthropic / OpenAI 官方 endpoint 走他们的 API 数据策略,自托管 / 代理网关请确认你的数据流向。',
              'If you handle sensitive material (passwords, proprietary code, customer data), disable recheck first. Official Anthropic / OpenAI endpoints follow their API data policy; for self-hosted / proxy gateways, verify where your data flows.',
            )}
          </div>

          <SettingRow
            label={tx('状态复核(BETA-006)', 'Status recheck (BETA-006)')}
            hint={tx('active→idle 跃迁前让 LLM 复核;失败时回退原阈值,不阻塞', 'Let the LLM verify before active→idle transition; falls back to the threshold on error, never blocks')}
          >
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={statusRecheckEnabled}
                onChange={(e) =>
                  void updateSettings(
                    { ai: { statusRecheckEnabled: e.target.checked } },
                    setError,
                  )
                }
                disabled={!apiKey.trim()}
              />
              <span>{tx('启用', 'Enable')}</span>
            </label>
          </SettingRow>

          <SettingRow
            label={tx('复核输入源', 'Recheck input source')}
            hint={tx('headless=已渲染的字符矩阵(无 ANSI 噪音、无重绘残影)', 'headless=rendered character matrix (no ANSI noise, no redraw artifacts)')}
          >
            <select
              className="settings-input"
              value={statusRecheckSource}
              onChange={(e) =>
                void updateSettings(
                  {
                    ai: {
                      statusRecheckSource: e.target.value as 'headless',
                    },
                  },
                  setError,
                )
              }
              disabled={!statusRecheckEnabled}
            >
              <option value="headless">{tx('headless (已渲染文本)', 'headless (rendered text)')}</option>
            </select>
          </SettingRow>
        </>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 高级分类
// ──────────────────────────────────────────────────────────────────

function AdvancedPanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const state = useAppState();
  const adv = state.settings.advanced;
  const logLevel = adv?.logLevel ?? 'INFO';
  const terminalRenderer = adv?.terminalRenderer ?? 'auto';

  const [confirmingReset, setConfirmingReset] = useState(false);

  const handleOpenLogs = (): void => {
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_LOGS_DIR, {})
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleReset = (): void => {
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.SETTINGS_RESET, {})
      .then(() => {
        setConfirmingReset(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('高级', 'Advanced')}</h2>

      <SettingRow label={tx('日志级别', 'Log level')} hint={tx('DEBUG 会记录所有 IPC 与 PTY 字节(性能影响)', 'DEBUG logs all IPC and PTY bytes (performance impact)')}>
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="loglevel"
              value="INFO"
              checked={logLevel === 'INFO'}
              onChange={() =>
                void updateSettings(
                  { advanced: { logLevel: 'INFO' } },
                  setError,
                )
              }
            />
            INFO
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="loglevel"
              value="DEBUG"
              checked={logLevel === 'DEBUG'}
              onChange={() =>
                void updateSettings(
                  { advanced: { logLevel: 'DEBUG' } },
                  setError,
                )
              }
            />
            DEBUG
          </label>
        </div>
      </SettingRow>

      <SettingRow label={tx('日志目录', 'Log directory')} hint={tx('用户数据目录下的 logs/ 子目录', 'logs/ under the user data directory')}>
        <button type="button" className="settings-button" onClick={handleOpenLogs}>
          {tx('打开日志目录', 'Open log directory')}
        </button>
      </SettingRow>

      <SettingRow
        label={tx('终端渲染器', 'Terminal renderer')}
        hint={tx(
          'auto=平台默认(Win/macOS WebGL,Linux DOM);dom=强制软渲(性能差但稳,某些 TUI 光标在 WebGL 下异常时用)。变更对已打开的 tab 不生效,需关 tab 重开。',
          'auto = platform default (Win/macOS WebGL, Linux DOM); dom = force DOM (slower but compatible — useful when some TUIs render cursors incorrectly under WebGL). Takes effect on next opened tab.',
        )}
      >
        <select
          className="settings-input"
          value={terminalRenderer}
          onChange={(e) =>
            void updateSettings(
              {
                advanced: {
                  terminalRenderer: e.target.value as
                    | 'auto'
                    | 'webgl'
                    | 'dom',
                },
              },
              setError,
            )
          }
        >
          <option value="auto">{tx('auto (平台默认)', 'auto (platform default)')}</option>
          <option value="webgl">{tx('webgl (强制)', 'webgl (force)')}</option>
          <option value="dom">{tx('dom (强制软渲)', 'dom (force DOM)')}</option>
        </select>
      </SettingRow>

      <SettingRow
        label={tx('重置所有设置', 'Reset all settings')}
        hint={tx('把所有设置回到出厂默认。收藏 / 模板 / 最近不受影响', 'Reset all settings to factory default. Bookmarks / templates / recent are unaffected.')}
      >
        {!confirmingReset ? (
          <button
            type="button"
            className="settings-button danger"
            onClick={() => setConfirmingReset(true)}
          >
            {tx('重置…', 'Reset…')}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: 'var(--color-danger, #f0f)', fontSize: 12 }}>
              {tx('确认重置?', 'Confirm reset?')}
            </span>
            <button
              type="button"
              className="settings-button danger"
              onClick={handleReset}
            >
              {tx('确认', 'Confirm')}
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => setConfirmingReset(false)}
            >
              {tx('取消', 'Cancel')}
            </button>
          </div>
        )}
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 关于分类
// ──────────────────────────────────────────────────────────────────

const GITHUB_REPO = 'https://github.com/Liyue-Cheng/marina';
const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;

const ACKNOWLEDGEMENTS: Array<{ name: string; url: string; tone: string }> = [
  { name: 'Electron', url: 'https://www.electronjs.org/', tone: '应用框架 (MIT)' },
  { name: 'React', url: 'https://react.dev/', tone: 'UI 库 (MIT)' },
  { name: 'electron-vite + Vite', url: 'https://electron-vite.org/', tone: '构建工具 (MIT)' },
  { name: 'xterm.js', url: 'https://xtermjs.org/', tone: '终端模拟器 (MIT)' },
  { name: 'node-pty', url: 'https://github.com/microsoft/node-pty', tone: 'PTY 绑定 (MIT)' },
  { name: 'lucide-react', url: 'https://lucide.dev/', tone: 'UI 图标库 (ISC)' },
  { name: 'Rose Pine theme', url: 'https://rosepinetheme.com/', tone: '默认主题灵感 (MIT)' },
  { name: '霞鹜文楷 (LXGW WenKai)', url: 'https://github.com/lxgw/LxgwWenKai', tone: '中文字体 (OFL)' },
];

function AboutPanel(): JSX.Element {
  const { tx } = useTranslation();
  // build define 在 dev 模式可能未定义,做个兜底
  // (vite 实际上 dev 时也会做 string 替换,但为了万无一失)
  const commit =
    typeof __MARINA_BUILD_COMMIT__ !== 'undefined'
      ? __MARINA_BUILD_COMMIT__
      : 'dev';
  const builtAt =
    typeof __MARINA_BUILD_TIME__ !== 'undefined'
      ? __MARINA_BUILD_TIME__
      : 'dev';

  // app 版本号通过 handshake 已经拿到,从 store 读不太合适 (store 里没存)
  // 走一次 getProtocolVersion 就够,这里 inline state
  const [appVersion, setAppVersion] = useState<string>('—');
  useEffect(() => {
    let cancelled = false;
    window.api
      .getProtocolVersion()
      .then((res) => {
        if (!cancelled) setAppVersion(res.buildVersion);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openExternal = (url: string): void => {
    window.api
      .invoke(COMMAND_CHANNELS.SYSTEM_OPEN_EXTERNAL, { url })
      .catch((err) => console.warn('[About] open-external failed', err));
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">{tx('关于', 'About')}</h2>

      <SettingRow label={tx('版本号', 'Version')}>
        <span className="settings-info-text">v{appVersion}</span>
      </SettingRow>

      <SettingRow label={tx('构建信息', 'Build info')}>
        <span className="settings-info-text">
          commit {commit} · {builtAt}
        </span>
      </SettingRow>

      <SettingRow label={tx('检查更新', 'Check for updates')} hint={tx('V1 仅打开 GitHub Releases 页面;auto-updater 留 V1.1', 'V1 just opens the GitHub Releases page; auto-updater is V1.1')}>
        <button
          type="button"
          className="settings-button"
          onClick={() => openExternal(GITHUB_RELEASES)}
        >
          {tx('打开 GitHub Releases', 'Open GitHub Releases')}
        </button>
      </SettingRow>

      <SettingRow label={tx('GitHub 仓库', 'GitHub repository')}>
        <button
          type="button"
          className="settings-button"
          onClick={() => openExternal(GITHUB_REPO)}
        >
          {GITHUB_REPO}
        </button>
      </SettingRow>

      <SettingRow label="License">
        <span className="settings-info-text">MIT</span>
      </SettingRow>

      <SettingRow label={tx('致谢', 'Acknowledgements')} hint={tx('Marina 站在这些项目的肩上', 'Marina stands on the shoulders of these projects')}>
        <ul className="acknowledgements-list">
          {ACKNOWLEDGEMENTS.map((a) => (
            <li key={a.name}>
              <button
                type="button"
                className="acknowledgements-link"
                onClick={() => openExternal(a.url)}
              >
                {a.name}
              </button>
              <span className="acknowledgements-tone"> — {a.tone}</span>
            </li>
          ))}
        </ul>
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 通用控件
// ──────────────────────────────────────────────────────────────────

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-meta">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

interface NumberInputProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** 显示成 100% 而不是 1 (UI 缩放用) */
  formatPercent?: boolean;
  onChange: (v: number) => void;
}

function NumberInput({
  value,
  min,
  max,
  step,
  formatPercent,
  onChange,
}: NumberInputProps): JSX.Element {
  // 内部 string state 让用户能输入"1.2" → 不被立即截成 1
  const [text, setText] = useState<string>(
    formatPercent ? `${Math.round(value * 100)}` : `${value}`,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  // value (来自 main 广播) 变化时同步内部 text。仅在 input 当前不聚焦时
  // 同步:跨窗口场景下另一窗口在改字号/UI 缩放等会广播 SETTINGS_CHANGED,
  // 若本地正在输入则会被无条件覆盖(FBK-3)。聚焦时跳过,blur/commit 时
  // 自然走 onChange 路径,不丢用户输入。
  useEffect(() => {
    if (inputRef.current && document.activeElement === inputRef.current) return;
    setText(formatPercent ? `${Math.round(value * 100)}` : `${value}`);
  }, [value, formatPercent]);

  const commit = (): void => {
    const raw = parseFloat(text);
    if (!Number.isFinite(raw)) return;
    const v = formatPercent ? raw / 100 : raw;
    if (v < min || v > max) {
      // 越界回退显示
      setText(formatPercent ? `${Math.round(value * 100)}` : `${value}`);
      return;
    }
    if (v === value) return;
    onChange(v);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setText(e.target.value);
  };

  const handleBlur = (): void => commit();

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        ref={inputRef}
        type="number"
        className="settings-input numeric"
        value={text}
        min={formatPercent ? min * 100 : min}
        max={formatPercent ? max * 100 : max}
        step={formatPercent ? Math.round(step * 100) : step}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {formatPercent && <span style={{ color: 'var(--color-text-secondary, #f0f)' }}>%</span>}
    </span>
  );
}

/**
 * M1-I:模板编辑器环境变量输入框 — 默认遮罩(显示 ***),点眼睛切真实。
 * 模糊视觉用 CSS filter blur,真值始终在 input value 里,不影响保存。
 * 复制粘贴时浏览器拿真值;肉眼看不见。
 *
 * 安全:遮罩仅靠"显示/隐藏"按钮显式切换。早期版本把 hover/focus 也作为
 * 自动 reveal,被审计判定与 hint("防被旁人看到 API key")矛盾 — 鼠标偶然
 * 路过即明文,违背设计意图。现回归"显式开关"。
 */
function EnvTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const { tx } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'flex-start' }}>
      <textarea
        className="settings-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="ANTHROPIC_API_KEY=sk-..."
        rows={4}
        style={{
          minWidth: 320,
          fontFamily: 'var(--terminal-font-family, monospace)',
          filter: revealed ? 'none' : 'blur(4px)',
          transition: 'filter 120ms ease',
        }}
      />
      <button
        type="button"
        className="settings-button"
        onClick={() => setRevealed((v) => !v)}
        title={revealed ? tx('遮罩内容', 'Mask content') : tx('查看明文', 'Reveal content')}
        style={{ padding: '4px 8px' }}
      >
        {revealed ? tx('隐藏', 'Hide') : tx('显示', 'Show')}
      </button>
    </span>
  );
}

interface FontPickerProps {
  value: string;
  fonts: FontEntry[];
  onChange: (value: string) => void;
}

/**
 * 字体下拉:推荐字体 + 系统已装字体 + "自定义" 选项。
 *
 * CP-4 勘误 #3:fonts 数组现在含 recommended 字段;UI 把它分两组显示
 * (<optgroup>) — 推荐组在上,系统其他在下,直观且不遗漏用户已装但不在
 * 我们推荐里的字体。
 */
function FontPicker({ value, fonts, onChange }: FontPickerProps): JSX.Element {
  const { tx } = useTranslation();
  const firstFamily = useMemo(() => extractFirstFontFamily(value), [value]);
  const knownFamily = fonts.find((f) => f.family === firstFamily);
  const [isCustom, setIsCustom] = useState<boolean>(!knownFamily);
  const [customText, setCustomText] = useState<string>(value);

  useEffect(() => {
    setCustomText(value);
    setIsCustom(!fonts.find((f) => f.family === extractFirstFontFamily(value)));
  }, [value, fonts]);

  // 分组:推荐 vs 系统其他
  const { recommended, others } = useMemo(() => {
    const rec: FontEntry[] = [];
    const oth: FontEntry[] = [];
    for (const f of fonts) {
      if (f.recommended) rec.push(f);
      else oth.push(f);
    }
    return { recommended: rec, others: oth };
  }, [fonts]);

  if (isCustom) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          type="text"
          className="settings-input"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onBlur={() => onChange(customText)}
          placeholder={tx("例如 'My Font', monospace", "e.g. 'My Font', monospace")}
        />
        <button
          type="button"
          className="settings-button"
          onClick={() => setIsCustom(false)}
        >
          {tx('切回下拉', 'Back to dropdown')}
        </button>
      </span>
    );
  }

  return (
    <select
      className="settings-input"
      value={firstFamily}
      onChange={(e) => {
        if (e.target.value === '__custom__') {
          setIsCustom(true);
          return;
        }
        onChange(e.target.value);
      }}
    >
      <optgroup label={tx('推荐', 'Recommended')}>
        {recommended.map((f) => (
          <option
            key={f.family}
            value={f.family}
            style={{ fontFamily: `"${f.family}", monospace` }}
          >
            {f.family}
            {f.installed ? '' : tx(' (未装)', ' (not installed)')}
          </option>
        ))}
      </optgroup>
      {others.length > 0 && (
        <optgroup label={tx(`系统已安装 (${others.length})`, `Installed on system (${others.length})`)}>
          {others.map((f) => (
            <option
              key={f.family}
              value={f.family}
              style={{ fontFamily: `"${f.family}", monospace` }}
            >
              {f.family}
            </option>
          ))}
        </optgroup>
      )}
      <option value="__custom__">{tx('— 自定义 —', '— Custom —')}</option>
    </select>
  );
}

function extractFirstFontFamily(cssFontFamily: string): string {
  // 取逗号前第一个 token,去引号
  const first = (cssFontFamily.split(',')[0] ?? '').trim();
  return first.replace(/^['"]|['"]$/g, '');
}
