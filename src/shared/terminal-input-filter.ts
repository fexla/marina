/**
 * @file terminal-input-filter.ts
 * @purpose 识别不应被当作用户键盘输入写回 PTY 的终端自动响应。
 *
 * @关键设计:
 * - xterm.onData 不只包含用户键盘输入,也包含 xterm 对远端终端查询的自动响应。
 * - SSH 登录 shell 启动期若无人读取这些响应,它们会落到 prompt 里并被 bash
 *   拆成 `61;6;...` 这类命令执行。
 * - 这里只识别"整段都是 DA / Secondary DA 响应"的输入,调用方再决定是否在
 *   特定生命周期窗口内丢弃。
 *
 * @对应文档章节:软件定义书.md 5.1.4 终端体验;ipc-protocol.md 第 8 节。
 */

/**
 * 判断一段 xterm.onData 输出是否完全由终端 Device Attributes 响应组成。
 *
 * 常见形态:
 * - Primary DA response:   ESC [ ? 61 ; 6 ; ... c
 * - Secondary DA response: ESC [ > 0 ; 10 ; 1 c
 *
 * 这些字节是终端模拟器回答远端 `CSI c` / `CSI > c` 查询时生成的,不是用户
 * 输入。函数故意不匹配普通 ESC / 箭头键 / bracketed paste marker,避免误杀
 * 正常交互。
 */
export function isDeviceAttributesResponse(data: string): boolean {
  if (data.length === 0) return false;

  let i = 0;
  let matchedAny = false;
  while (i < data.length) {
    if (data[i] === '\x1b' && data[i + 1] === '[') {
      i += 2;
    } else if (data[i] === '\x9b') {
      // 8-bit CSI form. xterm 通常发 ESC[,但解析它成本很低。
      i += 1;
    } else {
      return false;
    }

    const marker = data[i];
    if (marker !== '?' && marker !== '>') return false;
    i += 1;

    const paramsStart = i;
    while (i < data.length && /[0-9;]/.test(data[i]!)) i += 1;
    if (i === paramsStart) return false;
    if (data[i] !== 'c') return false;

    i += 1;
    matchedAny = true;
  }

  return matchedAny;
}
