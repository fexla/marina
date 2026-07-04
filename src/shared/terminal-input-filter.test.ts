/**
 * @file terminal-input-filter.test.ts
 * @purpose 护栏测试:终端 DA 自动响应不能被误当作用户输入送进 shell。
 */
import { describe, expect, it } from 'vitest';
import { isDeviceAttributesResponse } from './terminal-input-filter';

describe('isDeviceAttributesResponse', () => {
  it('识别 primary + secondary DA 响应组合', () => {
    expect(
      isDeviceAttributesResponse(
        '\x1b[?61;6;7;21;22;23;24;28;32;42c\x1b[>0;10;1c',
      ),
    ).toBe(true);
  });

  it('识别单条 8-bit CSI DA 响应', () => {
    expect(isDeviceAttributesResponse('\x9b>0;10;1c')).toBe(true);
  });

  it('不误杀普通 ESC、箭头键或 bracketed paste', () => {
    expect(isDeviceAttributesResponse('\x1b')).toBe(false);
    expect(isDeviceAttributesResponse('\x1b[A')).toBe(false);
    expect(isDeviceAttributesResponse('\x1b[200~hello\x1b[201~')).toBe(false);
  });

  it('混入用户文本时不匹配', () => {
    expect(isDeviceAttributesResponse('\x1b[>0;10;1cls')).toBe(false);
    expect(isDeviceAttributesResponse('61;6;7c')).toBe(false);
  });
});
