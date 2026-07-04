/**
 * @file src/shared/file-kind.test.ts
 * @purpose 验证 detectFileKind 的扩展名 / 无扩展名 / 边界判定。
 */
import { describe, expect, it } from 'vitest';
import { detectFileKind } from './file-kind';

describe('detectFileKind', () => {
  it('markdown 扩展名', () => {
    expect(detectFileKind('README.md')).toBe('markdown');
    expect(detectFileKind('notes.markdown')).toBe('markdown');
    expect(detectFileKind('doc.mdx')).toBe('markdown');
  });

  it('图片扩展名(大小写不敏感)', () => {
    expect(detectFileKind('photo.png')).toBe('image');
    expect(detectFileKind('photo.PNG')).toBe('image');
    expect(detectFileKind('pic.JPEG')).toBe('image');
    expect(detectFileKind('logo.svg')).toBe('image');
    expect(detectFileKind('anim.webp')).toBe('image');
  });

  it('文本/源码扩展名', () => {
    expect(detectFileKind('main.ts')).toBe('text');
    expect(detectFileKind('app.tsx')).toBe('text');
    expect(detectFileKind('index.js')).toBe('text');
    expect(detectFileKind('conf.json')).toBe('text');
    expect(detectFileKind('deploy.yaml')).toBe('text');
    expect(detectFileKind('setup.ps1')).toBe('text');
    expect(detectFileKind('run.sh')).toBe('text');
    expect(detectFileKind('index.html')).toBe('text');
    expect(detectFileKind('data.csv')).toBe('text');
  });

  it('无扩展名但有约定俗成文本含义', () => {
    expect(detectFileKind('LICENSE')).toBe('text');
    expect(detectFileKind('license')).toBe('text');
    expect(detectFileKind('Dockerfile')).toBe('text');
    expect(detectFileKind('Makefile')).toBe('text');
    expect(detectFileKind('.gitignore')).toBe('text');
    expect(detectFileKind('.env')).toBe('text');
    expect(detectFileKind('.editorconfig')).toBe('text');
  });

  it('二进制 / 未知扩展名归 unknown', () => {
    expect(detectFileKind('app.exe')).toBe('unknown');
    expect(detectFileKind('archive.zip')).toBe('unknown');
    expect(detectFileKind('movie.mp4')).toBe('unknown');
    expect(detectFileKind('data.bin')).toBe('unknown');
  });

  it('边界:无后缀的陌生文件名 → unknown(不靠猜)', () => {
    expect(detectFileKind('foobar')).toBe('unknown');
    expect(detectFileKind('')).toBe('unknown');
  });

  it('边界:点在末尾 / 仅点前缀', () => {
    expect(detectFileKind('foo.')).toBe('unknown');
    expect(detectFileKind('.gitignore')).toBe('text'); // 命中 TEXT_NO_EXT
    expect(detectFileKind('.unknownrc')).toBe('unknown'); // 未列入白名单
  });

  it('多段文件名取最后一段扩展名', () => {
    expect(detectFileKind('package-lock.json')).toBe('text');
    expect(detectFileKind('archive.tar.gz')).toBe('unknown'); // gz 不在文本表
    expect(detectFileKind('src/app.component.ts')).toBe('text');
  });
});
