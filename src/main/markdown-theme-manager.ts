/**
 * @file src/main/markdown-theme-manager.ts
 * @purpose Typora 式 Markdown 面板主题:扫描 userData/markdown-themes/*.css,
 *   fs.watch 自动发现增删,把"加一个 markdown 风格"降维成"往目录丢一个 CSS"。
 *
 * @工作原理:
 * 用户在设置页选 markdown 渲染风格时,除了内置 auto/github-light/github-dark,
 * 下拉还会列出本目录下每个 .css 对应的主题。CSS 文件本身不经 file:// 加载
 * (CSP 禁),而是 main 端 readCss 读文本 → IPC → renderer 注入 <style>
 * (CSP 的 style-src 'unsafe-inline' 允许),零协议改动。
 *
 * @关键设计:
 * - 「文件即主题」:文件名(去 .css)即主题名 + 内部 id 来源。增删 .css 由
 *   fs.watch 即时发现,设置页下拉无需重启就更新。
 * - id sanitize:baseName → 小写 → 非 [a-z0-9] 转 - → trim。保证 id 稳定
 *   (同名文件恒等) 且安全 (防 ./. 之类;readCss 还会二次校验路径不穿越)。
 * - 作用域约定:用户 CSS 写 `.markdown-body` 选择器 (与 github-markdown-css /
 *   react-markdown 容器一致),README 说明,不自动加前缀 (保持简单)。
 * - 首次运行种入 README.md + sepia.css:让用户开箱见到效果 + 有模板可抄。
 *   目录非空时不种入 (尊重已自定义的用户,不污染)。
 *
 * @对应:src/shared/protocol.ts MD_THEME_* channel;src/main/ipc.ts
 *   registerMdThemeHandlers + wireEventBroadcasts 的 listUpdated 订阅;
 *   src/renderer MdThemeInjector 注入 <style> + SettingsView 动态下拉。
 */
import { EventEmitter } from 'node:events';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { app } from 'electron';
import type { MdTheme } from '@shared/types';
import { normalizePath } from './path-manager';
import { logger } from './logger';

const MODULE = 'MarkdownThemeManager';
/** fs.watch 防抖:编辑器连发多个 change / rename,只触发一次重扫。 */
const WATCH_DEBOUNCE_MS = 200;
const CSS_EXT = '.css';

/** 首次种入:写法说明 + 一个开箱即用的暖色护眼示例。 */
const PRESET_README = `# Marina Markdown 主题

把 \`.css\` 文件放进这个目录，它就会出现在「设置 → 外观 → Markdown 渲染风格」下拉里。

## 写法

CSS 选择器以 \`.markdown-body\` 为根（与面板渲染容器一致）：

\`\`\`css
.markdown-body {
  background: #fdf6e3;
  color: #433816;
}
.markdown-body h1 { border-bottom: 1px solid #d8c9a0; }
.markdown-body code { background: #efe5cf; }
\`\`\`

## 规则

- 文件名（去 .css）即主题名，也是下拉里显示的名字。
- 增删 .css 立即生效，无需重启。
- 文件名里的非 [a-z0-9] 字符在内部 id 里会被替换为 \`-\`。
- 改完 CSS 后，在设置里切走再切回该主题即可看到最新样式。
`;

const PRESET_SEPIA = `/* Sepia —— 暖色护眼 Markdown 主题示例。
 * 背景米黄、文字深棕，长时间阅读友好。可直接改或当模板抄。
 * 同时覆盖了 github-markdown-css 的核心变量，让表格/代码块也搭。 */
.markdown-body {
  color-scheme: light;
  background-color: #f8f1e0;
  color: #4a3f2f;
  --bgColor-default: #f8f1e0;
  --bgColor-muted: #efe5cf;
  --bgColor-neutral-muted: #b8a88826;
  --borderColor-default: #d8c9a0;
  --fgColor-default: #4a3f2f;
  --fgColor-muted: #7a6a52;
  --fgColor-accent: #9a6b3f;
}
.markdown-body a {
  color: #9a6b3f;
}
.markdown-body code,
.markdown-body pre {
  background: #efe5cf;
}
.markdown-body blockquote {
  color: #6a5d44;
  border-left-color: #c9b88a;
}
.markdown-body table tr:nth-child(2n) {
  background-color: #efe5cf;
}
`;

/**
 * Markdown 主题管理器。EventEmitter(沿用 file-panel-service 模式):
 * emit 'listUpdated' = MdTheme[] (增删 .css 触发)。
 */
export class MarkdownThemeManager extends EventEmitter {
  private watcher: FSWatcher | null = null;
  /** 防抖 timer;fs.watch 在保存时连发多事件,合并成一次重扫。 */
  private rescanTimer: NodeJS.Timeout | null = null;
  /** 缓存上次 list,避免无变化时也 emit (减少 renderer 抖动)。 */
  private cached: MdTheme[] = [];

  constructor() {
    super();
  }

  /**
   * 主题目录绝对路径(list / readCss / open-dir 用)。懒求值 getter —— 构造期
   * 不调 app.getPath,让 new MarkdownThemeManager() 在非 Electron 环境(单测)
   * 也不崩;且避免 app 尚未 ready 的理论时序问题。
   */
  private get dir(): string {
    return join(app.getPath('userData'), 'markdown-themes');
  }

  /** 主题目录绝对路径(ipc 的 open-dir handler 用)。 */
  getDir(): string {
    return this.dir;
  }

  /**
   * 首次运行:建目录 + 空目录种入 README.md / sepia.css。
   * 目录非空时不种入 —— 尊重已自定义的用户,避免往他们目录塞文件。
   */
  async ensureFirstRun(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch (err) {
      logger.warn(MODULE, `mkdir failed: ${err instanceof Error ? err.message : String(err)}`);
      return; // mkdir 失败不致命,list() 会按"无主题"降级
    }
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      entries = [];
    }
    if (entries.length > 0) return; // 已有内容,不种入
    try {
      await fs.writeFile(join(this.dir, 'README.md'), PRESET_README, 'utf8');
      await fs.writeFile(join(this.dir, 'sepia.css'), PRESET_SEPIA, 'utf8');
      logger.info(MODULE, 'seeded README.md + sepia.css (first run)');
    } catch (err) {
      logger.warn(
        MODULE,
        `seed presets failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 扫目录 .css → 主题列表(按 name 排序,稳定)。readDir 失败返回 []。
   */
  async list(): Promise<MdTheme[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const themes: MdTheme[] = entries
      .filter((f) => f.toLowerCase().endsWith(CSS_EXT))
      .map((fileName) => {
        const name = fileName.slice(0, -CSS_EXT.length);
        return { id: `custom:${sanitizeThemeId(name)}`, name, fileName };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return themes;
  }

  /**
   * 读某主题 CSS 文本(UTF-8)。fileName 必须是 list 给出的磁盘文件名,
   * 调用方(ipc)按 id 反查得来。二次校验:normalize 后路径必须仍在主题目录下,
   * 防 fileName 里有 ../ 穿越(虽然 readdir 不会返回路径,但防御性编程)。
   * @throws 文件不存在 / 读失败 / 路径穿越
   */
  async readCss(fileName: string): Promise<string> {
    const abs = normalizePath(join(this.dir, fileName));
    // 加分隔符边界:裸 startsWith(this.dir) 会放过兄弟目录 'markdown-themes-evil'
    // (前缀同是 '...markdown-themes')。+ sep 后必须 '...markdown-themes\' 才算命中。
    // 今天 fileName 来自 readdir(basename)不可触发,但校验本身要对,防未来调用方。
    if (!abs.startsWith(this.dir + sep)) {
      throw new Error(`theme path escapes dir: ${fileName}`);
    }
    return fs.readFile(abs, 'utf8');
  }

  /**
   * 启动 fs.watch。增删/改名 .css → 防抖 → 重 list → 与缓存比,有变化才
   * emit 'listUpdated'。某些 FS 不支持 watch(网络盘等)→ 降级,不自动发现,
   * 其余功能(list/readCss/getDir)不受影响。
   */
  startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dir, () => this.scheduleRescan());
      this.watcher.on('error', (err) => {
        logger.warn(MODULE, `watch error: ${err.message}`);
        this.stopWatch();
      });
    } catch (err) {
      logger.warn(MODULE, `watch unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 应用退出 / 测试清理用。 */
  stopWatch(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore — 关闭幂等 */
      }
      this.watcher = null;
    }
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.rescan();
    }, WATCH_DEBOUNCE_MS);
  }

  private async rescan(): Promise<void> {
    const fresh = await this.list();
    if (sameList(this.cached, fresh)) return; // 内容未变(如只改了 README)不广播
    this.cached = fresh;
    this.emit('listUpdated', fresh);
  }
}

/**
 * baseName → 稳定安全的内部 id 片段。
 * sepia.css 的 name "sepia" → "sepia" → id "custom:sepia"。
 * "My Cool Theme.css" → "my-cool-theme"。
 */
function sanitizeThemeId(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'theme';
}

/** 按 id+name+fileName 三元组比对(顺序敏感:list 已排序)。 */
function sameList(a: MdTheme[], b: MdTheme[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || a[i]!.name !== b[i]!.name || a[i]!.fileName !== b[i]!.fileName) {
      return false;
    }
  }
  return true;
}
