/**
 * @file open-panel-view.test.ts
 * @purpose 守护 ADR-037「已打开」面板内文件/命令两侧视图的解析兜底:
 *   无记录默认文件侧;记录的一侧被清空时回退另一侧(否则关掉最后一个文件
 *   会停在永远空着的文件侧,看不到仍存在的命令输出)。FilePanel 与
 *   LayoutHost(SearchBar gate)共用这一份判定,行为漂移会直接表现为
 *   "渲染的视图与搜索导航器不一致",这里把语义钉死。
 */
import { describe, expect, it } from 'vitest';
import { resolveOpenPanelView } from './open-panel-view';

describe('resolveOpenPanelView', () => {
  it('无记录默认文件侧(两侧全空时也回文件侧空态文案)', () => {
    expect(resolveOpenPanelView(undefined, 0, 0)).toBe('file');
    expect(resolveOpenPanelView(undefined, 2, 0)).toBe('file');
  });

  it('记录的一侧仍有效时按记录返回', () => {
    expect(resolveOpenPanelView('file', 1, 3)).toBe('file');
    expect(resolveOpenPanelView('command', 2, 1)).toBe('command');
  });

  it('记录的文件侧被清空 → 回退命令侧(文件关光后仍能看到命令输出)', () => {
    expect(resolveOpenPanelView('file', 0, 2)).toBe('command');
  });

  it('记录的命令侧被清空 → 回退文件侧', () => {
    expect(resolveOpenPanelView('command', 2, 0)).toBe('file');
  });

  it('两侧都空时按记录原样返回(各自渲染空态,不抖动)', () => {
    expect(resolveOpenPanelView('command', 0, 0)).toBe('command');
    expect(resolveOpenPanelView('file', 0, 0)).toBe('file');
  });
});
