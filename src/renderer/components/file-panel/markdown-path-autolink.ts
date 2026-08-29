/**
 * @file src/renderer/components/file-panel/markdown-path-autolink.ts
 * @purpose remark 插件:把正文里的裸 Windows 盘符绝对路径自动变成可点链接,
 *   点击行为与手写 [x](D:\a\b.png) 完全一致(面板只读打开)。
 *
 * @关键设计:
 * - 背景(2026-08 用户报告):AI 写的文档里路径常以裸文本出现
 *   ("read D:\...\v20_f3.png"),Markdown 不会自动识别,用户只能复制后手动打开。
 *   盘符形式(字母 + : + / 或 \)无歧义、零解析依赖,是唯一值得自动化的形态;
 *   相对路径/UNC(解析层已丢一个反斜杠,见下)/含空格路径不猜 —— 让作者用
 *   显式链接语法写,猜错比不猜更伤信任。
 * - 只改 AST(文本节点 → text/link 序列),点击分流完全复用 MdLink seam:
 *   命令面板输出(无 fileContext)里同样渲染成链接但点击不动作,与手写本地
 *   链接在该来源的行为一致,不新增第二条行为路径。
 * - 跳过 link/linkReference/heading 子树:链接 label 里不二次嵌套 link
 *   (嵌套 link 是非法 mdast);标题/summary 内不自动链接(点击会与 details
 *   折叠 toggle 抢事件,且标题文本参与目录/锚点 id 生成)。code/inlineCode/
 *   html 是叶子节点(只有 value 没有 children),天然不会被访问到。
 * - 前导边界限定为行首/空白/常见开括号引号:防止 https://e.com/D:/x 这类
 *   URL 中段被切出来(/ 不是边界,匹配不上)。
 * - 尾部标点剥离:路径后紧跟的 ,。;:) 等收尾符留在链接外文本里,避免链接
 *   目标带上句子标点(GitHub URL autolink 同款取舍;Windows 文件名不允许以
 *   这些字符结尾,误伤面为零)。
 * - 无命中时保持 children 数组身份不变 —— 不制造新数组,React 渲染层零扰动。
 *
 * @对应功能:Markdown 面板本地文件链接(v0.3.3 Feature B;2026-08-23 盘符
 *   href 消毒修复;本插件是裸文本形态的补齐)。
 *
 * @不要在这里做的事:
 * - 不做 fs 校验/存在性探测(渲染层无 fs;点击后 main 端 resolveAndStat 兜底,
 *   不存在就是一条 toast,不影响其它内容)。
 * - 不猜测相对路径的基准目录(渲染层没有 cwd 真值;显式链接才交给 main resolve)。
 */
interface MarkdownAstNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
}

/** 不向下递归的容器类型:其子树里的文本保持原样(理由见文件头)。 */
const SKIP_SUBTREE = new Set(['link', 'linkReference', 'heading']);

/**
 * 盘符绝对路径 + 前导边界捕获。
 * 边界 = 行首(^,空串)或单个 空白/([<{"'/中文开引号 之一;
 * 路径体 = 字母盘符 + : + /或\ + 至少一个非空白字符([^\s]+ 由调用方再收口)。
 */
const BARE_PATH_RE = /(^|[\s([<{"'‘“「【《])([A-Za-z]:[\\/][^\s]+)/g;

/**
 * 句尾常见收尾标点:留在链接外。Windows 文件名不允许以其中任何字符结尾,
 * 所以把「路径末尾的标点」判定为句子标点是安全启发。
 */
const TRAILING_PUNCT = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '}',
  '>',
  '"',
  "'",
  '’',
  '”',
  '，',
  '。',
  '；',
  '：',
  '！',
  '？',
  '、',
  '）',
  '】',
  '》',
  '」',
  '』',
]);

/** react-markdown remark plugin:每次 parse 对一棵完整文档树做一次变换。 */
export function remarkMarinaPathAutolink(): (tree: unknown) => void {
  return (tree: unknown): void => {
    if (isContainer(tree)) transformSubtree(tree);
  };
}

/** 深度优先改写:先重写本层 text 子节点,再递归进未被跳过的容器子节点。 */
function transformSubtree(node: MarkdownAstNode): void {
  if (SKIP_SUBTREE.has(node.type)) return;
  const children = node.children;
  if (!children) return;

  let changed = false;
  const next: MarkdownAstNode[] = [];
  for (const child of children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const segments = splitBarePaths(child.value);
      if (segments) {
        changed = true;
        next.push(...segments);
        continue;
      }
    }
    next.push(child);
  }
  if (changed) node.children = next;
  for (const child of changed ? next : children) transformSubtree(child);
}

/**
 * 把一段文本按裸路径切开。无任何命中返回 null(调用方保留原节点,数组身份不变);
 * 有命中返回 text/link 交替序列,拼接后与原文完全等值。
 */
function splitBarePaths(value: string): MarkdownAstNode[] | null {
  BARE_PATH_RE.lastIndex = 0;
  const segments: MarkdownAstNode[] = [];
  let cursor = 0;
  for (let match = BARE_PATH_RE.exec(value); match !== null; match = BARE_PATH_RE.exec(value)) {
    const boundary = match[1] ?? '';
    const rawPath = match[2] ?? '';
    // 剥尾部句读;end > 3 保证至少留下 "D:\x"(盘符+冒号+分隔符+1 字符)。
    let end = rawPath.length;
    while (end > 3 && TRAILING_PUNCT.has(rawPath.charAt(end - 1))) end--;
    if (end <= 3) continue; // 剥完只剩盘符壳(如 "D:\."),不当路径
    const path = rawPath.slice(0, end);
    const pathStart = match.index + boundary.length;
    const before = value.slice(cursor, pathStart);
    if (before.length > 0) segments.push({ type: 'text', value: before });
    segments.push({ type: 'link', url: path, children: [{ type: 'text', value: path }] });
    cursor = pathStart + path.length;
  }
  if (segments.length === 0) return null;
  if (cursor < value.length) segments.push({ type: 'text', value: value.slice(cursor) });
  return segments;
}

function isContainer(value: unknown): value is MarkdownAstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as MarkdownAstNode).children)
  );
}
