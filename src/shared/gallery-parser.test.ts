/**
 * @file src/shared/gallery-parser.test.ts
 * @purpose 单测 parseGalleryCode:本地/网络/空行/注释/混合/边界。
 */
import { describe, it, expect } from 'vitest';
import { parseGalleryCode } from './gallery-parser';

describe('parseGalleryCode', () => {
  it('空字符串返回空数组', () => {
    expect(parseGalleryCode('')).toEqual([]);
  });

  it('纯空白行 / 注释行被忽略', () => {
    expect(parseGalleryCode('\n  \n# 注释\n  # 缩进注释\n')).toEqual([]);
  });

  it('解析本地图(相对路径)', () => {
    expect(parseGalleryCode('./img.png\nscreenshots/01.png')).toEqual([
      { src: './img.png', kind: 'local' },
      { src: 'screenshots/01.png', kind: 'local' },
    ]);
  });

  it('解析绝对路径为 local', () => {
    expect(parseGalleryCode('C:\\proj\\a.png')).toEqual([
      { src: 'C:\\proj\\a.png', kind: 'local' },
    ]);
  });

  it('解析网络 URL(http/https)为 network', () => {
    expect(parseGalleryCode('https://a.com/x.png\nhttp://b.com/y.jpg')).toEqual([
      { src: 'https://a.com/x.png', kind: 'network' },
      { src: 'http://b.com/y.jpg', kind: 'network' },
    ]);
  });

  it('无协议的 //a.jpg 视为 local(非 http(s))', () => {
    expect(parseGalleryCode('//share/a.jpg')).toEqual([{ src: '//share/a.jpg', kind: 'local' }]);
  });

  it('每行 trim 前后空白', () => {
    expect(parseGalleryCode('   ./a.png   \n\t./b.png\t')).toEqual([
      { src: './a.png', kind: 'local' },
      { src: './b.png', kind: 'local' },
    ]);
  });

  it('混合:本地 + 网络 + 注释 + 空行,保持顺序', () => {
    const code = [
      '# 第一组',
      './local1.png',
      '',
      'https://net1.com/a.jpg',
      '  # 中间注释',
      './local2.png',
      'https://net2.com/b.webp',
    ].join('\n');
    expect(parseGalleryCode(code)).toEqual([
      { src: './local1.png', kind: 'local' },
      { src: 'https://net1.com/a.jpg', kind: 'network' },
      { src: './local2.png', kind: 'local' },
      { src: 'https://net2.com/b.webp', kind: 'network' },
    ]);
  });

  it('CRLF 换行也正确分割', () => {
    expect(parseGalleryCode('./a.png\r\n./b.png\r\n')).toEqual([
      { src: './a.png', kind: 'local' },
      { src: './b.png', kind: 'local' },
    ]);
  });

  it('data:/blob: URI 归 local(交给 main 拒,符合 gallery 无运行时生成的语义)', () => {
    expect(parseGalleryCode('data:image/png;base64,AAA')).toEqual([
      { src: 'data:image/png;base64,AAA', kind: 'local' },
    ]);
  });
});
