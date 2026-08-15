/**
 * @file markdown-heading.ts
 * @purpose 提供 Markdown 标题的稳定 DOM identity 与外部“按可见标题跳转”解析规则。
 *
 * @关键设计:
 * - 外部调用方只需要知道文档里看得见的标题文字，不需要复刻 GitHub slug 算法。
 * - DOM id 保留 Unicode 字母/数字，并为重复标题追加稳定序号，供目录和 #anchor 共用。
 * - 可见文字先做 NFC，再折叠空白并忽略大小写；同名标题按文档顺序取第一个。
 *
 * @对应功能:Markdown 左侧目录、折叠章节、`marina show --heading`。
 *
 * @不要在这里做的事:
 * - 不解析 Markdown AST；解析属于 renderer 的 react-markdown remark seam。
 * - 不保存导航请求；请求是一次性 view intent，不是文件或 workspace 状态。
 */

export interface MarkdownHeadingIdentity {
  id: string;
  text: string;
}

/** GitHub 风格 slug 的项目内最小实现；中文等 Unicode 字母保持原样。 */
export function markdownHeadingSlug(text: string): string {
  return text
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 创建单文档作用域的标题 ID 分配器。
 *
 * 每个 Markdown parse 必须新建一次；返回值会记住已分配 id，重复标题依次得到
 * `title`、`title-1`、`title-2`。纯标点/空标题回退到 `section`。
 */
export function createMarkdownHeadingIdFactory(): (text: string) => string {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  return (text: string): string => {
    const base = markdownHeadingSlug(text) || 'section';
    if (!used.has(base)) {
      used.add(base);
      nextSuffix.set(base, 1);
      return base;
    }

    let suffix = nextSuffix.get(base) ?? 1;
    let candidate = `${base}-${suffix}`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    nextSuffix.set(base, suffix + 1);
    used.add(candidate);
    return candidate;
  };
}

/** 标题文字用于外部接口匹配时的规范化：NFC、trim、折叠空白、忽略大小写。 */
export function normalizeMarkdownHeadingText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * 把 `--heading` 的可见文字解析成文档内稳定 id。
 *
 * 同名标题刻意取文档顺序中的第一个：接口保持一个字符串参数，不把 renderer 的
 * slug/ordinal 复杂度泄漏给普通 agent 调用方。标题应尽量使用有辨识度的名称。
 */
export function resolveMarkdownHeadingTarget(
  headings: readonly MarkdownHeadingIdentity[],
  target: string,
): string | null {
  const wanted = normalizeMarkdownHeadingText(target);
  if (!wanted) return null;
  return (
    headings.find((heading) => normalizeMarkdownHeadingText(heading.text) === wanted)?.id ?? null
  );
}
