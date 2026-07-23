/**
 * @file font-stack.ts
 * @purpose 终端字体栈的唯一真相源 —— 把「用户主字体 → 用户自定义回退 →
 *   内置 Nerd Font 符号 → 通用 monospace」拼成一条 xterm.js 能直接用的
 *   CSS font-family 字符串。
 *
 * @背景 / 为什么需要它:
 *   很多 CLI 工具(powerlevel10k / starship / lsd / exa / gitstatus 等)会在
 *   输出里塞 Nerd Font 图标(U+E000–U+F8FF 私用区 + powerline 箭头等)。如果
 *   用户选的终端字体不含这些字形,就会渲染成豆腐块(乱码)。
 *   解决办法是给 xterm 的 fontFamily 配一条 fallback 链:主字体缺字形时,
 *   浏览器 / xterm 的 canvas / webgl 渲染器会沿链向下找下一个含该 codepoint
 *   的字体。这是所有现代终端(Windows Terminal / WezTerm / Kitty / iTerm2)
 *   的标准做法,不是冷门方案。
 *
 *   Marina 把「内置 Symbols Nerd Font Mono」(打包进 assets/fonts,通过
 *   global.css 的 @font-face 注册)常驻追加在链尾、通用 monospace 之前,
 *   让用户零配置就能看到 Nerd Font 图标;另在设置里暴露一个「回退字体」
 *   输入框给高级用户自定义(例如换上自己装的完整 Nerd Font,或加 emoji 字体)。
 *
 * @关键不变量(实现必须保证,有测试守护):
 *   1. 内置 Nerd Font 一定排在通用 `monospace` 关键字「之前」。
 *      理由:CSS font-family 回退是逐 codepoint 查的,但通用关键字(monospace)
 *      会解析到某个系统等宽字体,而系统等宽字体通常含基础 ASCII 但不含 Nerd
 *      Font PUA 字形 —— 把内置符号字体放在它前面,才能保证图标先命中符号字体
 *      而不是被通用 monospace 的缺字 / fallback 字形截胡。
 *      因此本函数会剥掉主字体链末尾可能出现的裸 `monospace`,统一在最后补一个。
 *   2. 用户自定义回退夹在「主字体」和「内置符号字体」之间 —— 这样用户自己
 *      指定的字体优先级高于内置(用户想覆盖时能覆盖),但又低于主字体(不抢
 *      主字体的常规字形)。
 *
 * @对应文档章节: 软件定义书.md 5.1.9 节(字体)
 */

/**
 * 内置兜底符号字体的 CSS family 名。
 *
 * 必须与 src/renderer/styles/global.css 里 @font-face 声明的 font-family
 * 完全一致(大小写敏感)。改这里要同步改 CSS,反之亦然 —— 两处都用这个名字,
 * 是因为 CSS 拿不到 TS 常量,只能各自写字面值,靠名字对齐。
 *
 * 选 `...Mono` 变体(不是 `Symbols Nerd Font`):只有 Mono 变体保证图标是
 * 单格宽度,能对齐终端网格;非 Mono 的图标会撑宽单元格,破坏 xterm 布局。
 */
export const BUILTIN_FALLBACK_FONT = 'Symbols Nerd Font Mono';

/**
 * 终端主字体的默认 CSS font-family 链(用户未设置时用)。
 *
 * 注意:这里「故意」不带尾部的裸 `monospace` 关键字 —— buildTerminalFontStack
 * 会在最后统一补上,避免它在内置符号字体之前截胡 PUA 字形(见上方不变量 1)。
 * 历史值(变更前)末尾有 monospace,老用户的 settings.json 里可能仍带它,
 * buildTerminalFontStack 的 strip 逻辑会兜住这种存量值。
 */
export const DEFAULT_TERMINAL_FONT =
  "'Cascadia Mono', 'JetBrains Mono', 'Consolas', 'LXGW WenKai Mono'";

/**
 * 剥掉一段 CSS font-family 链末尾的裸 `monospace` / `monospace` 关键字
 * (含可选引号与前后逗号空格),让调用方能在链尾统一重新补一个。
 *
 * 只处理「末尾」的通用关键字 —— 链中间出现的 monospace 不动(那通常是用户
 * 故意夹在中间的)。大小写不敏感。
 */
function stripTrailingGeneric(stack: string): string {
  // 形如  ... , monospace   或   ... , 'monospace'   或   monospace(整段就这一个)
  return stack
    .trim()
    .replace(/,\s*['"]?monospace['"]?\s*$/i, '')
    .replace(/^['"]?monospace['"]?$/i, '')
    .trim();
}

/**
 * 构建最终喂给 xterm.js 的 font-family 字符串。
 *
 * 优先级(从高到低,逐 codepoint 回退):
 *   用户主字体链  →  用户自定义回退(可空)  →  内置 Symbols Nerd Font Mono  →  monospace
 *
 * @param userFont      settings.appearance.terminalFontFamily(本身可能就是一条
 *                      多 family 的 CSS 链,如 `'Cascadia Mono', Consolas`)。
 *                      空 / undefined 时回退到 DEFAULT_TERMINAL_FONT。
 * @param userFallback  settings.appearance.terminalFallbackFont(B 功能,高级用户
 *                      自定义回退,如 `'JetBrainsMono Nerd Font', 'Noto Color Emoji'`)。
 *                      空 / undefined 时不插入这一段,只用内置兜底。
 * @returns 形如 `'Cascadia Mono', Consolas, 'Symbols Nerd Font Mono', monospace` 的字符串
 *
 * @副作用:无(纯函数)。
 *
 * @常见问题排查:
 * - 若图标仍是方块 → 检查 global.css 的 @font-face 是否正确加载了 woff2(浏览器
 *   devtools Network / Application > Fonts),以及 family 名是否与本文件常量一致。
 * - 若普通 ASCII 也变样 → 多半是用户把主字体写错;本函数不校验拼写。
 */
export function buildTerminalFontStack(
  userFont: string | undefined,
  userFallback: string | undefined,
): string {
  // 1. 主字体链:用户值优先,否则默认链;剥掉尾部裸 monospace(见不变量 1)。
  const primary = stripTrailingGeneric(
    userFont && userFont.trim() ? userFont : DEFAULT_TERMINAL_FONT,
  );

  // 2. 用户自定义回退:非空才插(保留用户原样写法,可能含自己的引号 / 多 family)。
  const fallbackPart = userFallback && userFallback.trim() ? userFallback.trim() : '';

  // 3. 内置符号字体 + 通用兜底,永远在最后。
  const tail = `'${BUILTIN_FALLBACK_FONT}', monospace`;

  return [primary, fallbackPart, tail].filter(Boolean).join(', ');
}
