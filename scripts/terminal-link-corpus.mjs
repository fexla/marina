#!/usr/bin/env node
/**
 * @file scripts/terminal-link-corpus.mjs
 * @purpose 终端链接可点击功能的人工测试语料(方案-终端可交互链接-20260912 的
 *   补充测试面)。向 stdout 输出一段覆盖四条检测通道的文本:
 *   A 裸 URL(WebLinksAddon)/ B 裸文件路径(STRICT 正则)/ C 裸 markdown []()
 *   / D OSC 8 显式超链接(任意程序通道)。
 *
 * @用法:必须在 **Marina 的终端 session**(普通 shell,非 pi 会话)里跑:
 *   node scripts/terminal-link-corpus.mjs
 *   在 marina 仓库根目录下跑,相对路径用例(B/C 节)才能解析成功。
 *
 * @为什么不能在别处跑:
 *   - pi 会话里跑:输出被 pi TUI 重新渲染,OSC 8 原始字节到不了 xterm buffer;
 *   - 命令面板 marina run:那是 Markdown 渲染面,不是 xterm。
 *
 * @每行开头的编号(A1/B2/...)对应测试指南(文件面板)里的预期表。
 *   预期表由生成指南时的 agent 维护;本脚本只负责输出语料,保持纯净——
 *   不在语料行内混任何提示文字,避免提示文本本身被链接检测误命中。
 *
 * @不要在这里做的事:
 *   - 不要往输出里加带斜杠/冒号/URL 形态的提示文字(会污染检测);
 *   - 不要输出破坏性 marina:run 命令(本语料只有 echo)。
 */

// OSC 8 超链接:`ESC ] 8 ; ; URI ST label ESC ] 8 ; ; ST`(ST = ESC \)。
// 与 pi/bridge 的输出形态一致(bridge 用 %20 编码 URI 里的空格;D3 用原始
// 空格形态,验证两种编码走到同一个 router)。
const ST = '\x1b\\';
function osc8(uri, label) {
  return `\x1b]8;;${uri}${ST}${label}\x1b]8;;${ST}`;
}

function section(title) {
  // 章节标题用暗色 + 全角分隔符,不含斜杠/冒号,不会被任何检测通道命中。
  process.stdout.write(`\n\x1b[2m── ${title} ──\x1b[0m\n`);
}

function line(text) {
  process.stdout.write(`${text}\n`);
}

process.stdout.write('\x1b[1m终端链接测试语料\x1b[0m\n');
process.stdout.write('每行编号对应测试指南的预期表。悬停看 tooltip,点击验证跳转。\n');
process.stdout.write('测折行:把终端窗口拉窄后重新跑一遍本脚本。\n');

// ── A 裸 URL(WebLinksAddon,仅 http/https)──────────────────────────
section('A 裸 URL 检测');

line('A1  https://example.com/');
line('A2  https://example.com/docs/getting-started?tab=api&lang=zh#anchor');
line('A3  https://example.com/path. Next sentence follows.');
line('A4  (see https://example.com/docs)');
line('A5  "https://example.com/quoted"');
line('A6  见https://example.com/cjk后续说明');
line('A7  http://localhost:5173/preview?x=1');
line('A8  http://127.0.0.1:8080/health');
line('A9  https://a.example.com/x 和 https://b.example.com/y');
line('A10  www.example.com/plain');
line('A11  ftp://files.example.com/pub');
line('A12  mailto:someone@example.com');
line(`A13  https://example.com/long/${'x'.repeat(160)}/end`);

// ── B 裸文件路径(STRICT 正则)───────────────────────────────────────
section('B 裸文件路径检测');

line('B1  src/main/session-manager.ts:42');
line('B2  src/renderer/components/TerminalView.tsx:1281:5');
line('B3  docs/方案-终端可交互链接-20260912.md');
line('B4  ~/projects/demo/src/index.ts:10');
line('B5  D:/data/projects/agent/marina/package.json');
line('B6  @src/shared/terminal-md-link-detector.ts:30');
line('B7  assets/logo@2x.png');
line('B8  package.json');
line('B9  D:\\data\\projects\\agent\\marina\\package.json');
line('B10  fixed in src/main/ipc.ts.');
line('B11  https://example.com/src/main/app.ts');
line(`B12  ${'verylongsegment/'.repeat(9)}deep-file.ts:120`);
line('B13  "src/main/session-manager.ts"');

// ── C 裸 markdown []()(md provider)─────────────────────────────────
section('C 裸 markdown 链接检测');

line('C1  [项目说明](README.md)');
line('C2  [方案文档](docs/方案-终端可交互链接-20260912.md)');
line('C3  [官网示例](https://example.com)');
line('C4  [发邮件](mailto:someone@example.com)');
line('C5  [打开配置](marina:show%20package.json)');
line('C6  [跳到第5行](marina:show%20package.json%20--line%205)');
line('C7  [跑一条无害命令](marina:run%20echo%20link-run-ok)');
line('C8  [页内锚点](#section)');
line('C9  ![图片形态](https://example.com/i.png)');
line('C10  [嵌套括号](https://example.com/A_(b))');
line('C11  参数 array[i](x) 形态演示');
line('C12  [带空格](<my file.md>)');
line('C13  [https://example.com/inner](https://example.com/inner)');
line(`C14  [${'很长的链接标签内容'.repeat(8)}](docs/方案-终端可交互链接-20260912.md)`);

// ── D OSC 8 显式超链接(程序直发通道)───────────────────────────────
section('D OSC8 显式超链接');

line(`D1  ${osc8('https://example.com/osc8', '外部链接(浏览器)')}`);
line(`D2  ${osc8('mailto:someone@example.com', '邮件链接')}`);
line(`D3  ${osc8('marina:show package.json --line 3', '打开 package.json 第3行')}`);
line(`D4  ${osc8('marina:run echo osc8-run-ok', '跑一条 echo 命令')}`);
line(`D5  ${osc8('ftp://files.example.com/pub', '非 http 与非 marina 的 scheme')}`);
line(`D6  相邻无分隔:${osc8('https://example.com/left', '左链')}${osc8('https://example.com/right', '右链')}`);
line(`D7  ${osc8('https://example.com/wrap-long-label', `${'长标签文字'.repeat(30)}(折行)`)}`);
line(`D8  ${osc8('https://example.com/cjk-emoji', '中文与 🎉 emoji 标签')}`);

process.stdout.write('\n(完)拉窄窗口重跑可测折行场景。\n');
