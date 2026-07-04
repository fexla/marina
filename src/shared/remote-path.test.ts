/**
 * @file src/shared/remote-path.test.ts
 * @purpose 覆盖远程路径规范化工具,防止 PathManager 与 SshProfileManager
 *   再次各自复制一份不一致的 normalizeRemotePath 逻辑。
 *
 * @关键设计:
 * - 只测试纯字符串转换,不连接远端、不访问本地文件系统
 * - 空输入、slash 折叠、尾部分隔符是两个调用方共同依赖的契约
 *
 * @对应文档章节: 软件定义书.md 第 5.1.1、11.1 节
 */
import { describe, expect, it } from 'vitest';
import { normalizeRemotePath } from './remote-path';

describe('normalizeRemotePath', () => {
  it('空白输入回退到远程 home 简写', () => {
    expect(normalizeRemotePath('')).toBe('~');
    expect(normalizeRemotePath('   ')).toBe('~');
  });

  it('统一 slash 并折叠重复分隔符', () => {
    expect(normalizeRemotePath('\\home\\me//repo///')).toBe('/home/me/repo');
  });

  it('保留根路径与 home 简写', () => {
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('~/')).toBe('~');
  });
});
