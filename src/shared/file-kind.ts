/**
 * @file src/shared/file-kind.ts
 * @purpose 按文件名判定文件在"终端侧边文件面板"里应渲染成哪种类型
 *   (text / markdown / image / unknown)。
 *
 * @关键设计:
 * - 纯函数,无副作用,不碰 fs —— main 与 renderer 都能用,也便于单测。
 *   真正的内容读取 / 类型回退在 main 端 FilePanelService + renderer FileViewer。
 * - 只看扩展名 + 少量"无扩展名但有约定俗成含义"的文件名(LICENSE / Dockerfile /
 *   .gitignore 等)。判定不出来一律 'unknown',面板显示"暂不支持预览"占位,
 *   绝不靠猜(把二进制当文本渲染会乱码 + 浪费 IPC)。
 * - 'web'(本地 HTML / 远程 URL)是未来能力,detectFileKind 本轮不会返回它;
 *   .html/.htm 当前归 'text'(源码形式展示),等 WebViewer 落地再改判。
 * - svg 归 'image':通过 <img src=dataUrl> 加载 svg 时浏览器不执行其中的
 *   脚本,安全;直接 innerHTML 才有 XSS 风险,我们不走那条路。
 *
 * @对应:src/shared/types.ts FileKind;src/main/file-panel-service.ts open_file;
 *   src/renderer/components/file-panel/FileViewer.tsx 分发。
 */
import type { FileKind } from './types';

/** Markdown 扩展名(渲染成富文本)。 */
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx', 'mdown', 'markdn']);

/**
 * 图片扩展名(读成 base64 dataUrl 喂给 <img>)。
 * svg 走 <img> 是安全的(见文件头注释)。
 */
const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'tiff',
  'tif',
]);

/**
 * 文本/源码/配置扩展名(按 UTF-8 读成字符串,<pre> 或 react-markdown 展示)。
 * 不求穷尽,覆盖常见开发文件即可;漏网的归 unknown 也只是显示占位,不致命。
 */
const TEXT_EXT = new Set([
  // 纯文本 / 日志 / 数据
  'txt',
  'log',
  'json',
  'json5',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'properties',
  'env',
  'csv',
  'tsv',
  'xml',
  'sql',
  // web / 标记(.html 本轮按源码文本展示,等 WebViewer 再改)
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  // JS / TS 系
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'vue',
  'svelte',
  'astro',
  // 系统语言
  'py',
  'pyi',
  'rb',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cxx',
  'hh',
  'java',
  'kt',
  'kts',
  'scala',
  'swift',
  'cs',
  'fs',
  'fsx',
  // 脚本 / shell
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'psd1',
  'bat',
  'cmd',
  'nu',
  // 其它常见
  'php',
  'pl',
  'pm',
  'lua',
  'r',
  'dart',
  'jl',
  'ex',
  'exs',
  'erl',
  'clj',
  'cljs',
  'edn',
  'elm',
  'hs',
  'graphql',
  'gql',
  'gradle',
  'proto',
  'thrift',
  'dockerfile',
  'tf',
  'tfvars',
  'nix',
  'el',
  'lisp',
  'scm',
]);

/**
 * 无(有意义)扩展名但约定俗成是文本的文件名。整体小写精确匹配。
 * 覆盖 LICENSE / Dockerfile / Makefile 这类无后缀经典文件,以及点开头的
 * 开发配置文件(.gitignore 等 —— 它们的 "扩展名" 其实是文件名一部分)。
 */
const TEXT_NO_EXT = new Set([
  'license',
  'licence',
  'copying',
  'readme',
  'changelog',
  'authors',
  'contributors',
  'notice',
  'dockerfile',
  'makefile',
  'cmakelists.txt',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.editorconfig',
  '.npmrc',
  '.yarnrc',
  '.nvmrc',
  '.ruby-version',
  '.python-version',
  '.env',
  '.eslintrc',
  '.prettierrc',
  '.babelrc',
  '.npmignore',
  '.dockerignore',
]);

/** v0.3.0:diff/patch/rej 文件归 'diff',由 DiffViewer 用 highlight.js
 * (diff 语言)做行级着色(add=绿底/del=红底/hunk=蓝/meta=淡灰)。
 * 与方案-diff高亮-20260719.md 方案 B 一致;词级/并排视图明确不做(§13.2)。 */
const DIFF_EXT = new Set(['diff', 'patch', 'rej']);

/**
 * 取文件名扩展名(小写,不含点)。
 *
 * 规则:
 * - 无点 → ''(走 TEXT_NO_EXT 兜底)
 * - 点在首位(`.gitignore`)→ 视为无扩展名(整体当文件名匹配 TEXT_NO_EXT)
 * - 点在末尾(`foo.`)→ ''
 * - 否则取最后一个点之后
 */
function extOf(lowerName: string): string {
  const i = lowerName.lastIndexOf('.');
  if (i <= 0 || i === lowerName.length - 1) return '';
  return lowerName.slice(i + 1);
}

/**
 * 按文件名判定渲染类型。大小写不敏感。无可靠依据时返回 'unknown'。
 *
 * @example
 *   detectFileKind('README.md')      // 'markdown'
 *   detectFileKind('photo.PNG')      // 'image'
 *   detectFileKind('Dockerfile')     // 'text'
 *   detectFileKind('app.exe')        // 'unknown'
 */
export function detectFileKind(fileName: string): FileKind {
  const lower = fileName.toLowerCase();
  if (TEXT_NO_EXT.has(lower)) return 'text';
  const ext = extOf(lower);
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  if (DIFF_EXT.has(ext)) return 'diff';
  return 'unknown';
}
