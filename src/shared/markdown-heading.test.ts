/**
 * @file markdown-heading.test.ts
 * @purpose 锁定 Markdown 标题 ID 与外部 `--heading` 目标解析的机器契约。
 *
 * @关键设计:
 * - 调用方只传可见标题文字，不需要复刻 renderer 的 slug 规则。
 * - 重复标题拥有稳定且唯一的 DOM id；外部文字跳转按文档顺序命中第一个。
 * - 中文等 Unicode 字母必须保留，保证 agent 生成的中文报告可直接跳转。
 */
import { describe, expect, it } from 'vitest';
import { createMarkdownHeadingIdFactory, resolveMarkdownHeadingTarget } from './markdown-heading';

describe('Markdown heading identity', () => {
  it('保留 Unicode、折叠空白并为重复标题生成稳定后缀', () => {
    const nextId = createMarkdownHeadingIdFactory();

    expect(nextId(' 安装 / 配置 ')).toBe('安装-配置');
    expect(nextId('安装 / 配置')).toBe('安装-配置-1');
    expect(nextId('!!!')).toBe('section');
    expect(nextId('???')).toBe('section-1');
  });

  it('按规范化后的可见文字解析，并对同名标题稳定取第一个', () => {
    const headings = [
      { id: 'overview', text: 'Overview' },
      { id: 'details', text: '详细 说明' },
      { id: 'overview-1', text: 'Overview' },
    ];

    expect(resolveMarkdownHeadingTarget(headings, ' overview ')).toBe('overview');
    expect(resolveMarkdownHeadingTarget(headings, '详细\n说明')).toBe('details');
    expect(resolveMarkdownHeadingTarget(headings, 'missing')).toBeNull();
  });

  it('把 NFC/NFD 等价文字规范成同一 identity 与可见目标', () => {
    const nextId = createMarkdownHeadingIdFactory();
    const decomposed = 'Cafe\u0301';

    expect(nextId('Café')).toBe('café');
    expect(nextId(decomposed)).toBe('café-1');
    expect(resolveMarkdownHeadingTarget([{ id: 'cafe', text: decomposed }], 'CAFÉ')).toBe('cafe');
  });

  it('拒绝空白目标，避免把无效请求误跳到第一个空标题', () => {
    expect(resolveMarkdownHeadingTarget([{ id: 'section', text: '' }], '   ')).toBeNull();
  });
});
