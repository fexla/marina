/**
 * @file src/shared/file-icon.ts
 * @purpose 按文件名(扩展名 + 少数完整名)选出文件条目应显示的图标 key。
 *   供 file-tree / git / file-panel 三面板的 FileListRow icon prop 使用,
 *   让文件条目图标按类型区分(代码 / 配置 / 图片 / ...),不再是清一色的 File。
 *
 * @关键设计:
 * - 返回 **FileIconKey**(字面量联合),与 `src/renderer/components/icons.tsx` 里
 *   注册的 IconName 同名对应(fileText / fileCode / fileCog / ...)。FileIconKey ⊆
 *   IconName,调用方可直接赋给 FileListRow 的 icon prop,无需 as 转换。
 *   **约束**:新增 FileIconKey 时必须同步在 icons.tsx 注册同名 lucide 图标,否则
 *   运行时 Icon 组件拿到 undefined 会崩 —— 由 file-icon.test.ts 断言 key 集合守护。
 * - 纯函数,无副作用,不碰 fs —— main 与 renderer 都能用,便于单测。
 * - 分类独立于 file-kind.ts:那个判的是「渲染类型」(text/markdown/image/...),
 *   用于选 FileViewer 组件;本文件判的是「图标类别」(代码/配置/资产/...),用于
 *   选 icon。两者语义不同(如 .ts 在 file-kind 是 text,在这里是 code),各自独立
 *   维护扩展名集合,不复用以免耦合。
 * - 锁文件优先于扩展名:package-lock.json 扩展名是 json,但语义上是锁文件,
 *   应显示锁图标。故先按完整文件名匹配 LOCK_FILES,再按扩展名分类。
 *
 * @对应文档章节: docs/方案-面板UI状态与缩进统一-20260721.md §3.1;ADR-019。
 */
/**
 * 文件图标 key 联合。每个字面量必须在 icons.tsx 的 Icons 表里注册同名 lucide 组件。
 * 字面量名即 icons.tsx 的 key(如 'fileCode' → Icons.fileCode = FileCode)。
 */
export type FileIconKey =
  | 'file' // 默认(未命中任何分类)
  | 'fileText' // 文档:txt / md / pdf / ...
  | 'fileCode' // 代码:ts / py / go / ...
  | 'fileCog' // 配置:json / yaml / csv / ...
  | 'fileBox' // 资产/工程(Unity 等):meta / asset / prefab / ...
  | 'cpu' // 可执行:exe / sh / msi / ...
  | 'fileImage' // 图片:png / jpg / svg / ...
  | 'fileArchive' // 压缩:zip / tar / gz / ...
  | 'fileLock'; // 锁文件:package-lock.json / yarn.lock / .env

/** 文档类(富文本 / 纯文本 / 文档格式)。 */
const DOC_EXT = new Set(['txt', 'md', 'markdown', 'mdx', 'mdown', 'markdn', 'rtf', 'pdf', 'doc', 'docx', 'pages']);

/** 代码类(编程语言源码)。覆盖常见开发语言,漏网归默认 file 无害。 */
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyi', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hh',
  'java', 'kt', 'kts', 'scala', 'swift', 'cs', 'fs', 'fsx',
  'vue', 'svelte', 'astro', 'php', 'pl', 'pm', 'lua', 'r', 'dart', 'jl',
  'ex', 'exs', 'erl', 'clj', 'cljs', 'elm', 'hs', 'graphql', 'gql',
  'proto', 'thrift', 'el', 'lisp', 'scm', 'gradle',
]);

/** 配置/数据类(structured data / 工程配置)。 */
const CONFIG_EXT = new Set([
  'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config',
  'properties', 'env', 'xml', 'csv', 'tsv', 'sql', 'tf', 'tfvars', 'nix', 'edn',
]);

/** 资产/工程类(Unity / 游戏引擎资产文件)。 */
const ASSET_EXT = new Set([
  'meta', 'asset', 'prefab', 'unity', 'scene', 'mat', 'anim', 'controller',
  'shader', 'cginc', 'hlsl', 'bundle', 'assets', 'controller',
]);

/** 可执行/脚本类(可直接运行或安装的文件)。 */
const EXEC_EXT = new Set([
  'exe', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh', 'fish', 'nu',
  'msi', 'app', 'deb', 'rpm', 'dmg', 'appimage', 'run', 'bin', 'command',
]);

/** 压缩/归档类。 */
const ARCHIVE_EXT = new Set([
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'lz', 'zst', 'iso', 'jar', 'war', 'whl',
]);

/** 图片类(位图 / 矢量)。 */
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff', 'tif',
]);

/**
 * 锁文件 / 敏感环境文件(完整名匹配,大小写不敏感)。优先级高于扩展名。
 *
 * 这些文件语义上是「锁定的依赖快照」或「环境密钥」,用锁图标更醒目,也能提醒
 * 用户「这是自动生成 / 含敏感信息,通常不手改」。package-lock.json 虽扩展名是
 * json,但归此类(优先级在 CONFIG_EXT 之前)。
 */
const LOCK_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'mix.lock',
  'poetry.lock',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
]);

/**
 * 取文件名扩展名(小写,不含点)。与 file-kind.ts 的 extOf 同语义,独立实现避免跨模块耦合。
 *
 * 规则:无点 / 点在首位(`.gitignore`) / 点在末尾(`foo.`) → ''(无扩展名);
 * 否则取最后一个点之后。
 */
function extOf(lowerName: string): string {
  const i = lowerName.lastIndexOf('.');
  if (i <= 0 || i === lowerName.length - 1) return '';
  return lowerName.slice(i + 1);
}

/**
 * 按文件名选出图标 key。大小写不敏感。未命中任何分类返回 'file'(默认)。
 *
 * 判定顺序(前者优先):
 * 1. 锁文件(完整名)→ fileLock
 * 2. 扩展名 ∈ 各类集合 → 对应图标
 * 3. 兜底 → file
 *
 * @example
 *   fileIconFor('main.ts')               // 'fileCode'
 *   fileIconFor('package.json')          // 'fileCog'
 *   fileIconFor('package-lock.json')     // 'fileLock'(优先于 json)
 *   fileIconFor('Hero.prefab')           // 'fileBox'
 *   fileIconFor('setup.exe')             // 'cpu'
 *   fileIconFor('unknown.xyz')           // 'file'
 */
export function fileIconFor(fileName: string): FileIconKey {
  const lower = fileName.toLowerCase();
  if (LOCK_FILES.has(lower)) return 'fileLock';
  const ext = extOf(lower);
  if (DOC_EXT.has(ext)) return 'fileText';
  if (CODE_EXT.has(ext)) return 'fileCode';
  if (CONFIG_EXT.has(ext)) return 'fileCog';
  if (ASSET_EXT.has(ext)) return 'fileBox';
  if (EXEC_EXT.has(ext)) return 'cpu';
  if (IMAGE_EXT.has(ext)) return 'fileImage';
  if (ARCHIVE_EXT.has(ext)) return 'fileArchive';
  return 'file';
}
