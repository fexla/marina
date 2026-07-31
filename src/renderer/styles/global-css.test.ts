/**
 * @file global-css.test.ts
 * @purpose 样式契约守卫(静态扫描 global.css,非 UI 行为测试 —— 不算 renderer
 *   UI 测试,是对「透明外壳组件不得使用主题 bg token」这条约定的机器检查)。
 *
 * 背景(为什么要这种测试):
 *   2026-08-01 实测翻车:Markdown 代码块的按钮 hover 用了
 *   `var(--color-bg-hover)`,在深色主题下渲染成黑块。根因是主题的 bg token
 *   都是按「应用主背景」调色的,而代码块外壳是透明的、底下垫什么背景随面板
 *   和主题未知 —— 用主背景 token 必然出错。修复方案定为:透明外壳组件的
 *   hover/选中反馈一律用 `color-mix(in srgb, currentColor N%, transparent)`,
 *   currentColor 与任何背景都可读,永不变黑。
 *
 * 本测试把这条约定变成 CI 红线:
 *   - 凡选择器含 .md-code-block 的规则,body 里不得出现 var(--color-bg-*)
 *     (透明外壳类组件的通用禁令;以后新增的透明外壳组件把选择器加进本文件)。
 *   - .md-code-block-btn:hover 必须用 currentColor 派生反馈色,防止被改回
 *     var(--color-bg-hover) 之类的主背景 token。
 *
 * 实现注记:不做完整 CSS 解析,只做「注释剥离 + 规则块切分」的轻量扫描。
 * 够用即可,过拟合会让测试本身成为维护负担。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const GLOBAL_CSS = resolve(__dirname, 'global.css');

/** 剥离 CSS 块注释(注释里可能提到 token 名,不参与契约检查)。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 按顶层大括号切出 { selector, body } 规则块。@media 内联块会被并入外层 body,但
 * 对选择器匹配无影响(media 内的选择器文本仍在,检测依然生效)。 */
function extractRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const selector = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    let close = -1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      if (depth === 0) {
        close = j;
        break;
      }
      j++;
    }
    if (close === -1) break;
    rules.push({ selector, body: css.slice(open + 1, close) });
    i = close + 1;
  }
  return rules;
}

describe('global.css 样式契约', () => {
  const css = stripComments(readFileSync(GLOBAL_CSS, 'utf8'));
  const rules = extractRules(css);

  it('文件存在且可解析(防止路径失效后测试空转)', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(rules.length).toBeGreaterThan(100);
  });

  it('.md-code-block 透明外壳规则禁用 var(--color-bg-*) token 作背景', () => {
    // 透明外壳组件:代码块。主题 bg token 按应用主背景调色,垫在未知背景上
    // 会出错(2026-08-01 实测黑块)。反馈色必须走 currentColor 派生。
    const offenders = rules
      .filter((r) => r.selector.includes('.md-code-block'))
      .filter((r) => /var\(\s*--color-bg-/.test(r.body))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it('.md-code-block-btn:hover 反馈色必须由 currentColor 派生', () => {
    const hover = rules.find((r) =>
      r.selector.includes('.md-code-block-btn:hover'),
    );
    expect(hover, '未找到 .md-code-block-btn:hover 规则').toBeDefined();
    expect(hover!.body).toMatch(/color-mix\(\s*in srgb,\s*currentColor/);
    expect(hover!.body).not.toMatch(/var\(\s*--color-bg-/);
  });
});
