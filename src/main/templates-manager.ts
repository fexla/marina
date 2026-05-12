/**
 * @file src/main/templates-manager.ts
 * @purpose 维护启动模板列表 (内置 + 自定义) 与默认模板。
 *   templates.json 持久化,与 SettingsManager 类似的 deep-merge / atomic write。
 *
 * @关键设计:
 * - 4 个内置模板永远存在 (id 固定为 'shell' / 'claude-code' / 'codex' /
 *   'opencode')。即使持久化文件残缺也会被 ensureBuiltins 补齐
 * - 自定义模板用 UUID,与内置同列存储;CRUD 接口 V1 不暴露给 renderer
 *   (CP-4 模板编辑子页面才接入),CP-3 只用 read 路径 + 内置默认值
 * - 默认模板 id 必须存在于 templates 列表中;不存在时回退到 'shell'
 * - 持久化失败不阻塞读路径:initialize 失败时用纯内置默认值继续运行
 *
 * @对应文档章节: 软件定义书.md 5.1.3、6.6.3、11.1 (templates.json)
 *
 * @AGENTS.md 5.3 必测: 持久化往返、损坏恢复、版本迁移、内置模板补齐。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Template, TemplatesFile } from '@shared/types';
import type { JsonStore } from './persistence';

/**
 * 4 个内置模板。
 *
 * - shell:启动用户默认 shell,无 command;新建终端的兜底
 * - claude-code:启动 Anthropic Claude Code CLI (`claude`)
 * - codex:启动 OpenAI Codex CLI (`codex`)
 * - opencode:启动 OpenCode CLI (`opencode`)
 *
 * 命令找不到时由 shell 自然报错 (PowerShell: "不是 cmdlet";cmd: "不是内
 * 部或外部命令"),不弹对话框 (软件定义书 ADR-005 的最小化干扰)。
 *
 * shellFirst=true 表示先启动 shell 再 exec command,这样即使 command 退出
 * 用户也能留在 shell 看到 exit message。postExitAction 控制 command 退出
 * 后的行为。
 */
export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'shell',
    name: 'Shell',
    icon: '🐚',
    isBuiltin: true,
    command: '', // 空表示纯 shell,SessionManager 看到空就只 spawn shell
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'close_session',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '🤖',
    isBuiltin: true,
    command: 'claude',
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'keep_shell',
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: '⚡',
    isBuiltin: true,
    command: 'codex',
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'keep_shell',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: '📦',
    isBuiltin: true,
    command: 'opencode',
    args: [],
    env: {},
    shellFirst: true,
    postExitAction: 'keep_shell',
  },
];

const DEFAULT_TEMPLATE_ID = 'shell';

const DEFAULT_FILE: TemplatesFile = {
  version: 1,
  defaultTemplateId: DEFAULT_TEMPLATE_ID,
  templates: BUILTIN_TEMPLATES.map((t) => ({ ...t, args: [...t.args], env: { ...t.env } })),
};

export class TemplatesManagerError extends Error {
  constructor(
    public readonly code: 'TemplateNotFound' | 'InvalidTemplate' | 'CannotDeleteBuiltin',
    message: string,
  ) {
    super(`[TemplatesManager] ${code}: ${message}`);
    this.name = 'TemplatesManagerError';
  }
}

export interface TemplatesManagerEvents {
  templatesUpdated: (payload: {
    templates: Template[];
    defaultTemplateId: string;
  }) => void;
}

export class TemplatesManager extends EventEmitter {
  private templates: Template[] = [];
  private defaultTemplateId: string = DEFAULT_TEMPLATE_ID;

  constructor(private readonly store: JsonStore<TemplatesFile>) {
    super();
  }

  /**
   * 启动时调一次。从 store 加载,补齐缺失的内置模板,校验 defaultTemplateId
   * 是否仍然有效。损坏 / 缺失全部走默认。
   */
  async initialize(): Promise<'main' | 'bak' | 'default'> {
    const result = await this.store.load(DEFAULT_FILE);
    const { templates, defaultId, mutated } = mergeBuiltins(
      result.value.templates ?? [],
      result.value.defaultTemplateId ?? DEFAULT_TEMPLATE_ID,
    );
    this.templates = templates;
    this.defaultTemplateId = defaultId;
    // 如果合并过程中改了内容 (例如旧文件缺新内置模板),回写一次
    if (mutated) this.persist();
    return result.source;
  }

  /**
   * 列出所有模板的浅拷贝。
   */
  list(): Template[] {
    return this.templates.map(cloneTemplate);
  }

  /**
   * 根据 id 取模板。返回深拷贝避免外部修改污染内部状态。
   */
  get(id: string): Template | null {
    const t = this.templates.find((x) => x.id === id);
    return t ? cloneTemplate(t) : null;
  }

  getDefaultTemplateId(): string {
    return this.defaultTemplateId;
  }

  /**
   * 解析 templateId,缺失/无效一律回退到默认模板。
   * SessionManager 创建 session 时调用,确保永远拿到一个可用模板。
   */
  resolve(templateId: string | undefined | null): Template {
    if (templateId) {
      const found = this.get(templateId);
      if (found) return found;
    }
    const def = this.get(this.defaultTemplateId);
    if (def) return def;
    // 内置模板列表保底必有 'shell' (mergeBuiltins 保证),不会到这里
    return cloneTemplate(BUILTIN_TEMPLATES[0]!);
  }

  /**
   * 设置默认模板 id。仅用于 settings UI / IPC,内部不调用。
   * 不存在的 id throw。
   */
  setDefault(templateId: string): void {
    if (!this.templates.find((t) => t.id === templateId)) {
      throw new TemplatesManagerError(
        'TemplateNotFound',
        `templateId="${templateId}" 不存在,无法设为默认`,
      );
    }
    if (this.defaultTemplateId === templateId) return;
    this.defaultTemplateId = templateId;
    this.persist();
    this.emitUpdated();
  }

  /**
   * 新增自定义模板。返回新模板的深拷贝。
   *
   * @throws InvalidTemplate name/icon 缺失或格式错
   */
  add(input: Omit<Template, 'id' | 'isBuiltin'> & { id?: string }): Template {
    validateTemplateInput(input);
    const newId = input.id?.trim() || generateUuid();
    if (this.templates.find((t) => t.id === newId)) {
      throw new TemplatesManagerError(
        'InvalidTemplate',
        `id="${newId}" 已存在,无法新增`,
      );
    }
    const t: Template = {
      id: newId,
      name: input.name,
      icon: input.icon,
      isBuiltin: false,
      command: input.command,
      args: [...input.args],
      env: { ...input.env },
      shellFirst: input.shellFirst,
      postExitAction: input.postExitAction,
    };
    this.templates.push(t);
    this.persist();
    this.emitUpdated();
    return cloneTemplate(t);
  }

  /**
   * 更新模板。内置模板允许改 name / icon / command / args / env / shellFirst /
   * postExitAction (但 isBuiltin / id 不可改);自定义模板字段全部可改。
   *
   * @throws TemplateNotFound id 不存在
   * @throws InvalidTemplate 字段值非法
   */
  update(
    id: string,
    partial: Partial<Omit<Template, 'id' | 'isBuiltin'>>,
  ): Template {
    const idx = this.templates.findIndex((t) => t.id === id);
    if (idx === -1) {
      throw new TemplatesManagerError(
        'TemplateNotFound',
        `id="${id}" 不存在,无法更新`,
      );
    }
    const current = this.templates[idx]!;
    const merged: Template = {
      ...current,
      ...partial,
      // 强制保留 id / isBuiltin
      id: current.id,
      isBuiltin: current.isBuiltin,
      // 数组 / 对象做浅拷贝防止外部 mutate 内部状态
      args: partial.args ? [...partial.args] : [...current.args],
      env: partial.env ? { ...partial.env } : { ...current.env },
    };
    validateTemplateInput(merged);
    this.templates[idx] = merged;
    this.persist();
    this.emitUpdated();
    return cloneTemplate(merged);
  }

  /**
   * 删除自定义模板。内置模板不可删,throw CannotDeleteBuiltin。
   * 删除时若它是 defaultTemplateId,自动回退到 'shell'。
   */
  delete(id: string): void {
    const idx = this.templates.findIndex((t) => t.id === id);
    if (idx === -1) {
      throw new TemplatesManagerError(
        'TemplateNotFound',
        `id="${id}" 不存在,无法删除`,
      );
    }
    const t = this.templates[idx]!;
    if (t.isBuiltin) {
      throw new TemplatesManagerError(
        'CannotDeleteBuiltin',
        `id="${id}" 是内置模板,不可删除`,
      );
    }
    this.templates.splice(idx, 1);
    if (this.defaultTemplateId === id) {
      this.defaultTemplateId = DEFAULT_TEMPLATE_ID;
    }
    this.persist();
    this.emitUpdated();
  }

  /**
   * 应用退出前 flush。
   */
  async flush(): Promise<void> {
    await this.store.flush();
  }

  /**
   * CP-4 勘误 #12:整体替换全部模板 + defaultTemplateId (设置导入用)。
   * 走 mergeBuiltins 保证内置模板齐全 + defaultId 合法,然后 persist + emit,
   * 让所有窗口立即看到新数据 — 避免 app.relaunch 在 dev 模式失效的坑。
   */
  replaceAll(input: { defaultTemplateId: string; templates: Template[] }): void {
    const { templates, defaultId } = mergeBuiltins(
      input.templates,
      input.defaultTemplateId || DEFAULT_TEMPLATE_ID,
    );
    this.templates = templates;
    this.defaultTemplateId = defaultId;
    this.persist();
    this.emitUpdated();
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部
  // ──────────────────────────────────────────────────────────────────

  private persist(): void {
    this.store.set({
      version: 1,
      defaultTemplateId: this.defaultTemplateId,
      templates: this.templates.map(cloneTemplate),
    });
  }

  private emitUpdated(): void {
    this.emit('templatesUpdated', {
      templates: this.list(),
      defaultTemplateId: this.defaultTemplateId,
    });
  }
}

/**
 * 合并持久化文件中的 templates 与 BUILTIN_TEMPLATES。
 *
 * 规则:
 * - 内置模板 id 在 BUILTIN_TEMPLATES 出现的,以**用户文件版本**为准 (允许用
 *   户改名/改图标/改默认参数,软件定义书 6.6.3),但保持 isBuiltin=true
 * - 内置模板缺失的从 BUILTIN_TEMPLATES 补齐 (升级时新增的内置模板)
 * - 自定义模板 (isBuiltin=false 且 id 不在 BUILTIN_TEMPLATES) 全部保留
 * - 顺序:先 BUILTIN_TEMPLATES 顺序的内置模板,再自定义模板按文件原顺序
 * - defaultTemplateId 不在 final templates 列表中 → 回退到 'shell'
 *
 * 返回 mutated=true 表示合并产生了变化,调用方应该回写持久化。
 */
export function mergeBuiltins(
  fileTemplates: Template[],
  fileDefaultId: string,
): { templates: Template[]; defaultId: string; mutated: boolean } {
  const result: Template[] = [];
  const fileById = new Map(fileTemplates.map((t) => [t.id, t]));
  let mutated = false;

  for (const builtin of BUILTIN_TEMPLATES) {
    const userVersion = fileById.get(builtin.id);
    if (userVersion) {
      // 强制 isBuiltin=true,防止用户/损坏文件把内置模板降级为可删除
      const corrected: Template = {
        ...userVersion,
        isBuiltin: true,
        // 保险起见 args/env 至少是空数组/对象
        args: Array.isArray(userVersion.args) ? userVersion.args : [],
        env: userVersion.env && typeof userVersion.env === 'object' ? userVersion.env : {},
      };
      if (corrected.isBuiltin !== userVersion.isBuiltin) mutated = true;
      result.push(corrected);
    } else {
      // 用户文件没有此内置 (升级新增) → 用 BUILTIN 默认
      result.push(cloneTemplate(builtin));
      mutated = true;
    }
  }

  const builtinIds = new Set(BUILTIN_TEMPLATES.map((t) => t.id));
  for (const t of fileTemplates) {
    if (!builtinIds.has(t.id)) {
      // 自定义模板:保留,但强制 isBuiltin=false
      const corrected: Template = {
        ...t,
        isBuiltin: false,
        args: Array.isArray(t.args) ? t.args : [],
        env: t.env && typeof t.env === 'object' ? t.env : {},
      };
      if (corrected.isBuiltin !== t.isBuiltin) mutated = true;
      result.push(corrected);
    }
  }

  // defaultId 校验
  let defaultId = fileDefaultId;
  if (!result.find((t) => t.id === defaultId)) {
    defaultId = DEFAULT_TEMPLATE_ID;
    mutated = true;
  }

  return { templates: result, defaultId, mutated };
}

function cloneTemplate(t: Template): Template {
  return {
    ...t,
    args: [...t.args],
    env: { ...t.env },
  };
}

/**
 * 校验 template 输入。校验失败抛 InvalidTemplate。
 * 用于 add / update,对内置 / 自定义都生效 (内置 update 时也要校验)。
 */
function validateTemplateInput(t: {
  name: string;
  icon: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  shellFirst: boolean;
  postExitAction: string;
}): void {
  if (typeof t.name !== 'string' || !t.name.trim()) {
    throw new TemplatesManagerError(
      'InvalidTemplate',
      `name 必须是非空字符串,实际: ${JSON.stringify(t.name)}`,
    );
  }
  if (typeof t.icon !== 'string') {
    throw new TemplatesManagerError(
      'InvalidTemplate',
      `icon 必须是字符串,实际: ${typeof t.icon}`,
    );
  }
  if (typeof t.command !== 'string') {
    throw new TemplatesManagerError(
      'InvalidTemplate',
      `command 必须是字符串(空字符串表示纯 shell),实际: ${typeof t.command}`,
    );
  }
  if (!Array.isArray(t.args) || t.args.some((a) => typeof a !== 'string')) {
    throw new TemplatesManagerError(
      'InvalidTemplate',
      `args 必须是字符串数组`,
    );
  }
  if (
    typeof t.env !== 'object' ||
    t.env === null ||
    Array.isArray(t.env) ||
    Object.values(t.env).some((v) => typeof v !== 'string')
  ) {
    throw new TemplatesManagerError(
      'InvalidTemplate',
      `env 必须是 string→string 的对象`,
    );
  }
  if (typeof t.shellFirst !== 'boolean') {
    throw new TemplatesManagerError(
      'InvalidTemplate',
      `shellFirst 必须是布尔`,
    );
  }
  if (!['close_session', 'keep_shell', 'hold'].includes(t.postExitAction)) {
    throw new TemplatesManagerError(
      'InvalidTemplate',
      `postExitAction 必须是 close_session / keep_shell / hold 之一,实际: ${t.postExitAction}`,
    );
  }
}

function generateUuid(): string {
  // 内置 crypto.randomUUID,不依赖 npm uuid 包
  return randomUUID();
}
