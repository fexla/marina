/**
 * @file src/shared/file-icon.test.ts
 * @purpose 验证 fileIconFor 的分类、优先级(锁文件 > 扩展名)、大小写不敏感、兜底。
 */
import { describe, expect, it } from 'vitest';
import { fileIconFor } from './file-icon';

describe('fileIconFor', () => {
  it('文档类 → fileText', () => {
    expect(fileIconFor('readme.md')).toBe('fileText');
    expect(fileIconFor('notes.markdown')).toBe('fileText');
    expect(fileIconFor('doc.mdx')).toBe('fileText');
    expect(fileIconFor('plain.txt')).toBe('fileText');
    expect(fileIconFor('paper.pdf')).toBe('fileText');
  });

  it('代码类 → fileCode', () => {
    expect(fileIconFor('main.ts')).toBe('fileCode');
    expect(fileIconFor('app.tsx')).toBe('fileCode');
    expect(fileIconFor('index.js')).toBe('fileCode');
    expect(fileIconFor('server.py')).toBe('fileCode');
    expect(fileIconFor('main.go')).toBe('fileCode');
    expect(fileIconFor('lib.rs')).toBe('fileCode');
    expect(fileIconFor('App.vue')).toBe('fileCode');
  });

  it('配置/数据类 → fileCog', () => {
    expect(fileIconFor('package.json')).toBe('fileCog');
    expect(fileIconFor('app.yaml')).toBe('fileCog');
    expect(fileIconFor('data.csv')).toBe('fileCog');
    expect(fileIconFor('config.toml')).toBe('fileCog');
    expect(fileIconFor('data.xml')).toBe('fileCog');
    expect(fileIconFor('schema.sql')).toBe('fileCog');
  });

  it('资产/工程类(Unity) → fileBox', () => {
    expect(fileIconFor('Player.prefab')).toBe('fileBox');
    expect(fileIconFor('texture.asset')).toBe('fileBox');
    expect(fileIconFor('Hero.meta')).toBe('fileBox');
    expect(fileIconFor('Level.unity')).toBe('fileBox');
  });

  it('可执行/脚本类 → cpu', () => {
    expect(fileIconFor('setup.exe')).toBe('cpu');
    expect(fileIconFor('run.bat')).toBe('cpu');
    expect(fileIconFor('deploy.sh')).toBe('cpu');
    expect(fileIconFor('build.ps1')).toBe('cpu');
    expect(fileIconFor('app.msi')).toBe('cpu');
  });

  it('图片类 → fileImage', () => {
    expect(fileIconFor('photo.png')).toBe('fileImage');
    expect(fileIconFor('photo.PNG')).toBe('fileImage');
    expect(fileIconFor('logo.svg')).toBe('fileImage');
    expect(fileIconFor('anim.webp')).toBe('fileImage');
  });

  it('压缩类 → fileArchive', () => {
    expect(fileIconFor('archive.zip')).toBe('fileArchive');
    expect(fileIconFor('backup.tar.gz')).toBe('fileArchive');
    expect(fileIconFor('data.7z')).toBe('fileArchive');
  });

  it('锁文件 → fileLock(优先于扩展名)', () => {
    // package-lock.json 扩展名是 json,但应归锁文件(优先)
    expect(fileIconFor('package-lock.json')).toBe('fileLock');
    expect(fileIconFor('yarn.lock')).toBe('fileLock');
    expect(fileIconFor('pnpm-lock.yaml')).toBe('fileLock');
    expect(fileIconFor('Cargo.lock')).toBe('fileLock');
    // .env 完整名(无常规扩展名)
    expect(fileIconFor('.env')).toBe('fileLock');
    expect(fileIconFor('.env.local')).toBe('fileLock');
  });

  it('大小写不敏感', () => {
    expect(fileIconFor('MAIN.TS')).toBe('fileCode');
    expect(fileIconFor('Package.JSON')).toBe('fileCog');
    expect(fileIconFor('PACKAGE-LOCK.JSON')).toBe('fileLock');
    expect(fileIconFor('IMAGE.JPEG')).toBe('fileImage');
  });

  it('未知扩展名 / 无扩展名 → file(默认)', () => {
    expect(fileIconFor('unknown.xyz')).toBe('file');
    expect(fileIconFor('binary')).toBe('file');
    expect(fileIconFor('Makefile')).toBe('file');
  });

  it('带点的边界文件名', () => {
    // 点在首位 → 无扩展名 → 默认(除非命中 LOCK_FILES)
    expect(fileIconFor('.gitignore')).toBe('file');
    // 点在末尾 → 无扩展名 → 默认
    expect(fileIconFor('foo.')).toBe('file');
    // 多扩展名取最后一个
    expect(fileIconFor('archive.tar.gz')).toBe('fileArchive');
    expect(fileIconFor('component.test.tsx')).toBe('fileCode');
  });
});
