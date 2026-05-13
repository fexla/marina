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
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  COMMAND_CHANNELS,
  type AddTemplatePayload,
  type AddTemplateResponse,
  type ExplorerIntegrationStatus,
  type GetPsCommandsResponse,
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

type CategoryId =
  | 'appearance'
  | 'shell'
  | 'behavior'
  | 'data'
  | 'system-integration'
  | 'advanced'
  | 'about';

interface CategoryDef {
  id: CategoryId;
  iconName: IconName;
  title: string;
}

// CP-4 勘误 #11:用 lucide 图标替换原有 Emoji
const CATEGORIES: CategoryDef[] = [
  { id: 'appearance', iconName: 'appearance', title: '外观' },
  { id: 'shell', iconName: 'shell', title: 'Shell 与启动' },
  { id: 'behavior', iconName: 'behavior', title: '行为' },
  { id: 'data', iconName: 'data', title: '数据' },
  { id: 'system-integration', iconName: 'systemIntegration', title: '系统集成' },
  { id: 'advanced', iconName: 'advanced', title: '高级' },
  { id: 'about', iconName: 'about', title: '关于' },
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
          title="关闭设置"
          aria-label="关闭设置"
        >
          ×
        </button>
        <h1 className="settings-title">设置</h1>
        {errorMsg && (
          <span className="settings-error" role="alert">
            <Icon name="alertTriangle" size={12} /> {errorMsg}
          </span>
        )}
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="设置分类">
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
              <span className="settings-nav-label">{c.title}</span>
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

const THEMES: Array<{ id: ThemeId; label: string; tone: string }> = [
  { id: 'rose-pine', label: 'Rose Pine', tone: '深色 · 默认' },
  { id: 'rose-pine-dawn', label: 'Rose Pine Dawn', tone: '浅色' },
  { id: 'rose-pine-moon', label: 'Rose Pine Moon', tone: '深色变体' },
  { id: 'cutie', label: 'Cutie', tone: '奶油粉 · Kawaii' },
  { id: 'business', label: 'Business', tone: '商务蓝灰' },
  { id: 'ubuntu', label: 'Ubuntu', tone: '经典棕紫' },
  { id: 'windows-terminal', label: 'Windows Terminal', tone: 'Campbell 配色' },
];

function AppearancePanel({
  setError,
}: {
  setError: (msg: string | null) => void;
}): JSX.Element {
  const state = useAppState();
  const a = state.settings.appearance;
  const theme = a?.theme ?? 'rose-pine';
  const windowStyle: WindowStyle = a?.windowStyle ?? 'windows';
  const terminalFontFamily = a?.terminalFontFamily ?? '';
  const terminalFontSize = a?.terminalFontSize ?? 13;
  const terminalLineHeight = a?.terminalLineHeight ?? 1.2;
  const uiFontFamily = a?.uiFontFamily ?? '';
  const uiZoom = a?.uiZoom ?? 1;

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
        label="主题"
        hint="所有窗口立即同步;xterm 颜色与 UI 同步切换"
      >
        <div className="settings-theme-grid">
          {THEMES.map((t) => (
            <label
              key={t.id}
              className={`settings-theme-card${theme === t.id ? ' selected' : ''}`}
              data-theme={t.id}
            >
              <input
                type="radio"
                name="theme"
                value={t.id}
                checked={theme === t.id}
                onChange={() =>
                  void updateSettings({ appearance: { theme: t.id } }, setError)
                }
              />
              <span className="settings-theme-swatch" aria-hidden="true">
                <span className="swatch-base" />
                <span className="swatch-iris" />
                <span className="swatch-pine" />
                <span className="swatch-gold" />
                <span className="swatch-love" />
              </span>
              <span className="settings-theme-name">{t.label}</span>
              <span className="settings-theme-tone">{t.tone}</span>
            </label>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label="窗口风格"
        hint="影响标题栏布局与窗口控制按钮位置(不影响主题配色)"
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

      <SettingRow label="终端字体" hint="系统已安装的等宽字体 + 推荐字体">
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

      <SettingRow label="终端字号" hint="范围 8 - 24">
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

      <SettingRow label="终端行高" hint="范围 1.0 - 2.0">
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

      <SettingRow label="UI 字体" hint="侧栏 / 按钮 / 标签等 UI 区域">
        <FontPicker
          value={uiFontFamily}
          fonts={uiFonts}
          onChange={(value) =>
            void updateSettings({ appearance: { uiFontFamily: value } }, setError)
          }
        />
      </SettingRow>

      <SettingRow label="UI 缩放" hint="范围 75% - 150%,影响整个 UI 字号">
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
        setError(`枚举可用 shell 失败:${msg}`);
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
      <h2 className="settings-panel-title">Shell 与启动</h2>

      <SettingRow label="默认 shell" hint="新终端启动时使用的 shell">
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
          <option value="">自动检测最优(pwsh &gt; powershell &gt; cmd)</option>
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName} — {s.executablePath}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label="新终端使用的 shell"
        hint='"默认 shell"或"上次用过的 shell"'
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
            使用默认 shell
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
            使用上次用过的 shell
          </label>
        </div>
      </SettingRow>

      <SettingRow label="启动模板" hint="新建终端时可选的模板;内置不可删,可改名">
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
  const state = useAppState();
  const templates = state.templates;
  const defaultId = state.defaultTemplateId;

  const handleSetDefault = (id: string): void => {
    setError(null);
    window.api
      .invoke(COMMAND_CHANNELS.TEMPLATE_SET_DEFAULT, { id })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleDelete = (id: string): void => {
    if (!confirm('确认删除这个自定义模板?该操作不可撤销。')) return;
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
          <span className="template-list-icon">{t.icon}</span>
          <span className="template-list-name">{t.name}</span>
          {t.isBuiltin && <span className="template-list-tag">内置</span>}
          {t.id === defaultId && <span className="template-list-tag default">默认</span>}
          <span className="template-list-cmd" title={t.command || '(纯 shell)'}>
            {t.command || '(纯 shell)'}
          </span>
          <div className="template-list-actions">
            {t.id !== defaultId && (
              <button
                type="button"
                className="settings-button"
                onClick={() => handleSetDefault(t.id)}
              >
                设为默认
              </button>
            )}
            <button
              type="button"
              className="settings-button"
              onClick={() => onEdit(t.id)}
            >
              编辑
            </button>
            {!t.isBuiltin && (
              <button
                type="button"
                className="settings-button danger"
                onClick={() => handleDelete(t.id)}
              >
                删除
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
        + 新建自定义模板
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
          throw new Error(`环境变量行格式错: "${line}" 应为 KEY=VALUE`);
        }
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1);
        if (!key) throw new Error(`环境变量名不能为空: "${line}"`);
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
          &lt; 返回
        </button>
        {isCreate ? '新建模板' : `编辑模板:${draft.name}`}
        {draft.isBuiltin && (
          <span className="template-list-tag" style={{ marginLeft: 8 }}>
            内置(可改 name/icon/command/args/env,不可删)
          </span>
        )}
      </h2>

      <SettingRow label="名称">
        <input
          type="text"
          className="settings-input"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="例如:My Claude"
        />
      </SettingRow>

      <SettingRow label="图标 (emoji)">
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

      <SettingRow label="命令" hint="留空表示启动纯 shell;不要写 shell 路径,Marina 会自动注入 shell">
        <input
          type="text"
          className="settings-input"
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          placeholder="例如:claude / codex / 留空"
        />
      </SettingRow>

      <SettingRow label="参数" hint="空格分隔(简单 shell quoting,有空格的参数请避免)">
        <input
          type="text"
          className="settings-input"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder="例如:--foo bar --baz"
        />
      </SettingRow>

      <SettingRow
        label="环境变量"
        hint="每行一个 KEY=VALUE。默认遮罩,点👁切显示(防被旁人看到 API key)"
      >
        <EnvTextarea value={envText} onChange={setEnvText} />
      </SettingRow>

      <SettingRow
        label="启动方式"
        hint='"先启动 shell"让命令退出后用户能继续看到 shell 提示符;"直接运行命令"启动更快'
      >
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-first"
              checked={draft.shellFirst}
              onChange={() => setDraft({ ...draft, shellFirst: true })}
            />
            先启动 shell 再运行命令
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="shell-first"
              checked={!draft.shellFirst}
              onChange={() => setDraft({ ...draft, shellFirst: false })}
            />
            直接运行命令
          </label>
        </div>
      </SettingRow>

      <SettingRow label="命令退出后">
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
            留在 shell(若启动方式为先 shell)
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
            关闭 session
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
            保留显示,等待用户手动关闭
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
            background: 'var(--iris, #f0f)',
            color: 'var(--base, #f0f)',
            borderColor: 'var(--iris, #f0f)',
          }}
        >
          {saving ? '保存中…' : isCreate ? '创建' : '保存'}
        </button>
        <button type="button" className="settings-button" onClick={onClose}>
          取消
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
  const state = useAppState();
  const b = state.settings.behavior;
  const startupBehavior = b?.startupBehavior ?? 'open-window';
  const autoStart = b?.autoStart ?? false;
  const confirmOnQuit = b?.confirmOnQuit ?? true;
  const selectOnCopy = b?.selectOnCopy ?? true;
  const terminalRightClick = b?.terminalRightClick ?? 'menu';

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">行为</h2>

      <SettingRow label="启动时行为" hint="配开机启动用">
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
            打开一个窗口
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
            仅启动到托盘
          </label>
        </div>
      </SettingRow>

      <SettingRow
        label="开机启动"
        hint="Windows 启动时自动启动 Marina(写 Run 注册表)"
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
          <span>开机启动</span>
        </label>
      </SettingRow>

      <SettingRow
        label="完全退出前确认"
        hint='托盘点"完全退出"且有 session 在跑时弹确认。关单窗口永远不弹'
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
          <span>启用</span>
        </label>
      </SettingRow>

      <SettingRow label="选中即复制" hint="终端选中文本自动复制(类 Linux)">
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
          <span>启用</span>
        </label>
      </SettingRow>

      <SettingRow label="终端右键行为" hint="弹菜单 或 直接粘贴">
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
            弹菜单
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
            直接粘贴
          </label>
        </div>
      </SettingRow>
    </section>
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
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);

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
        setError(`导入失败:${res.errorMessage ?? '未知错误'}`);
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
      <h2 className="settings-panel-title">数据</h2>

      <SettingRow label="数据目录" hint="所有 Marina 配置文件存放处">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="settings-info-text">%APPDATA%\Marina</span>
          <button type="button" className="settings-button" onClick={handleOpenDataDir}>
            在 Explorer 中打开
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label="导出设置"
        hint="把全部配置(收藏 / 最近 / 模板 / 设置)导出为 JSON 文件"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            className="settings-button"
            disabled={busy !== null}
            onClick={() => void handleExport()}
          >
            {busy === 'export' ? '导出中…' : '导出…'}
          </button>
          {lastExportPath && (
            <span className="settings-info-text" style={{ fontSize: 11 }}>
              已导出到: {lastExportPath}
            </span>
          )}
        </div>
      </SettingRow>

      <SettingRow
        label="导入设置"
        hint="选择导出文件,二次确认后整体替换并重启应用"
      >
        <button
          type="button"
          className="settings-button"
          disabled={busy !== null}
          onClick={() => void handleImport()}
        >
          {busy === 'import' ? '导入中…' : '导入…'}
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
  const state = useAppState();
  const sys = state.settings?.systemIntegration;
  const openIn = sys?.explorerOpenIn ?? 'new-window';

  const [status, setStatus] = useState<ExplorerIntegrationStatus | null>(null);
  const [busy, setBusy] = useState<'classic' | 'modern' | null>(null);
  const [psCommands, setPsCommands] = useState<GetPsCommandsResponse | null>(null);

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
    void window.api
      .invoke<undefined, GetPsCommandsResponse>(
        COMMAND_CHANNELS.EXPLORER_INTEGRATION_GET_PS_COMMANDS,
        undefined,
      )
      .then(setPsCommands)
      .catch(() => {
        /* PS 命令展示是可选功能,失败静默 */
      });
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
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const copyToClipboard = async (text: string, label: string): Promise<void> => {
    try {
      const ok = await window.api.clipboard.writeText(text);
      if (!ok) throw new Error('写入剪贴板失败');
      setError(`已复制 ${label} 到剪贴板`);
      // 1.5 秒后清掉这个"伪错误"提示
      setTimeout(() => setError(null), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="settings-panel">
      <h2 className="settings-panel-title">系统集成</h2>

      {/* —— Win11 新菜单卡片 —— */}
      <ExplorerIntegrationCard
        title="Win11 新菜单"
        subtitle="圆角右键菜单,无需展开「显示更多选项」;走 IExplorerCommand,需 MSIX 包 + 证书"
        status={status?.modern}
        unsupportedReason={status?.modernUnsupportedReason ?? null}
        busy={busy === 'modern'}
        onToggle={(next) => void handleSet('modern', next)}
        detail={
          status?.modern === 'enabled' && status.package ? (
            <div className="explorer-integration-meta">
              <div>
                <strong>包:</strong> {status.package.name} {status.package.version}
              </div>
              <div className="text-muted" style={{ wordBreak: 'break-all' }}>
                {status.package.installLocation}
              </div>
            </div>
          ) : null
        }
        certInfo={status?.cert ?? null}
        psInstallCommand={psCommands?.installModern ?? null}
        psUninstallCommand={psCommands?.uninstallModern ?? null}
        psLabelInstall="安装命令"
        psLabelUninstall="卸载命令"
        onCopy={(text, label) => void copyToClipboard(text, label)}
      />

      {/* —— 经典右键菜单卡片 —— */}
      <ExplorerIntegrationCard
        title="经典右键菜单"
        subtitle="HKCU 注册表项,藏在「显示更多选项」内;Win10 / Win11 通用,无 UAC、无证书"
        status={status?.classic}
        unsupportedReason={status?.classicUnsupportedReason ?? null}
        busy={busy === 'classic'}
        onToggle={(next) => void handleSet('classic', next)}
        detail={null}
        certInfo={null}
        psInstallCommand={psCommands?.installClassic ?? null}
        psUninstallCommand={psCommands?.uninstallClassic ?? null}
        psLabelInstall="注册命令"
        psLabelUninstall="移除命令"
        onCopy={(text, label) => void copyToClipboard(text, label)}
      />

      {/* —— 打开方式(纯偏好,保留在 settings.json) —— */}
      <SettingRow
        label="打开方式"
        hint="Marina 已在运行时,从 Explorer 触发的新会话开在哪里"
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
            新窗口打开
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
            在最近活动的窗口新开标签
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
  psInstallCommand: string | null;
  psUninstallCommand: string | null;
  psLabelInstall: string;
  psLabelUninstall: string;
  onCopy: (text: string, label: string) => void;
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
  psInstallCommand,
  psUninstallCommand,
  psLabelInstall,
  psLabelUninstall,
  onCopy,
}: ExplorerIntegrationCardProps): JSX.Element {
  const isUnsupported = status === 'unsupported';
  const isEnabled = status === 'enabled';
  const disabled = isUnsupported || busy || status === undefined;

  const statusLabel = (() => {
    if (status === undefined) return '查询中…';
    if (status === 'unsupported') return '不可用';
    if (status === 'enabled') return '已启用';
    return '未启用';
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
          <span>{busy ? '处理中…' : statusLabel}</span>
        </label>
      </div>

      {isUnsupported && unsupportedReason && (
        <div className="explorer-integration-unsupported">{unsupportedReason}</div>
      )}

      {detail}

      {certInfo && (
        <div className="explorer-integration-meta">
          <div>
            <strong>证书:</strong> {certInfo.subject}
          </div>
          <div className="text-muted">
            指纹 {certInfo.thumbprint.slice(0, 8)}…{certInfo.thumbprint.slice(-4)} · 至{' '}
            {new Date(certInfo.notAfter).toISOString().slice(0, 10)} · 已信任
          </div>
        </div>
      )}

      {(psInstallCommand || psUninstallCommand) && (
        <div className="explorer-integration-actions">
          {psInstallCommand && (
            <button
              type="button"
              className="settings-button"
              onClick={() => onCopy(psInstallCommand, psLabelInstall)}
            >
              复制 {psLabelInstall}
            </button>
          )}
          {psUninstallCommand && (
            <button
              type="button"
              className="settings-button"
              onClick={() => onCopy(psUninstallCommand, psLabelUninstall)}
            >
              复制 {psLabelUninstall}
            </button>
          )}
        </div>
      )}
    </div>
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
  const state = useAppState();
  const adv = state.settings.advanced;
  const logLevel = adv?.logLevel ?? 'INFO';

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
      <h2 className="settings-panel-title">高级</h2>

      <SettingRow label="日志级别" hint="DEBUG 会记录所有 IPC 与 PTY 字节(性能影响)">
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

      <SettingRow label="日志目录" hint="%APPDATA%\Marina\logs">
        <button type="button" className="settings-button" onClick={handleOpenLogs}>
          打开日志目录
        </button>
      </SettingRow>

      <SettingRow
        label="重置所有设置"
        hint="把所有设置回到出厂默认。收藏 / 模板 / 最近不受影响"
      >
        {!confirmingReset ? (
          <button
            type="button"
            className="settings-button danger"
            onClick={() => setConfirmingReset(true)}
          >
            重置…
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: 'var(--love, #f0f)', fontSize: 12 }}>
              确认重置?
            </span>
            <button
              type="button"
              className="settings-button danger"
              onClick={handleReset}
            >
              确认
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => setConfirmingReset(false)}
            >
              取消
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
  // build define 在 dev 模式可能未定义,做个兜底
  // (vite 实际上 dev 时也会做 string 替换,但为了万无一失)
  const commit =
    typeof __EASYTERM_BUILD_COMMIT__ !== 'undefined'
      ? __EASYTERM_BUILD_COMMIT__
      : 'dev';
  const builtAt =
    typeof __EASYTERM_BUILD_TIME__ !== 'undefined'
      ? __EASYTERM_BUILD_TIME__
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
      <h2 className="settings-panel-title">关于</h2>

      <SettingRow label="版本号">
        <span className="settings-info-text">v{appVersion}</span>
      </SettingRow>

      <SettingRow label="构建信息">
        <span className="settings-info-text">
          commit {commit} · {builtAt}
        </span>
      </SettingRow>

      <SettingRow label="检查更新" hint="V1 仅打开 GitHub Releases 页面;auto-updater 留 V1.1">
        <button
          type="button"
          className="settings-button"
          onClick={() => openExternal(GITHUB_RELEASES)}
        >
          打开 GitHub Releases
        </button>
      </SettingRow>

      <SettingRow label="GitHub 仓库">
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

      <SettingRow label="致谢" hint="Marina 站在这些项目的肩上">
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

  // value (来自 main 广播) 变化时同步内部 text — 只在不聚焦时同步,
  // 否则用户正在输入会被覆盖。简化:每次都同步,行为略糙但 V1 可接受。
  useEffect(() => {
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
      {formatPercent && <span style={{ color: 'var(--subtle, #f0f)' }}>%</span>}
    </span>
  );
}

/**
 * M1-I:模板编辑器环境变量输入框 — 默认遮罩(显示 ***),点眼睛切真实。
 * 模糊视觉用 CSS filter blur,真值始终在 input value 里,不影响保存。
 * 复制粘贴时浏览器拿真值;肉眼看不见。
 */
function EnvTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
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
        // 鼠标 hover 时短暂取消遮罩(可读但操作完恢复),user-friendly
        onMouseEnter={() => setRevealed(true)}
        onMouseLeave={() => setRevealed(false)}
        onFocus={() => setRevealed(true)}
        onBlur={() => setRevealed(false)}
      />
      <button
        type="button"
        className="settings-button"
        onClick={() => setRevealed((v) => !v)}
        title={revealed ? '遮罩内容' : '查看明文'}
        style={{ padding: '4px 8px' }}
      >
        {revealed ? '隐藏' : '显示'}
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
          placeholder="例如 'My Font', monospace"
        />
        <button
          type="button"
          className="settings-button"
          onClick={() => setIsCustom(false)}
        >
          切回下拉
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
      <optgroup label="推荐">
        {recommended.map((f) => (
          <option
            key={f.family}
            value={f.family}
            style={{ fontFamily: `"${f.family}", monospace` }}
          >
            {f.family}
            {f.installed ? '' : ' (未装)'}
          </option>
        ))}
      </optgroup>
      {others.length > 0 && (
        <optgroup label={`系统已安装 (${others.length})`}>
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
      <option value="__custom__">— 自定义 —</option>
    </select>
  );
}

function extractFirstFontFamily(cssFontFamily: string): string {
  // 取逗号前第一个 token,去引号
  const first = (cssFontFamily.split(',')[0] ?? '').trim();
  return first.replace(/^['"]|['"]$/g, '');
}
