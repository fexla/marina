/**
 * @file src/renderer/components/file-panel/markdown-url-transform.ts
 * @purpose react-markdown 的 URL 消毒适配层:放行 Windows 盘符绝对路径与
 *   marina: 动作链接,其余 URL 沿用上游 defaultUrlTransform 的安全行为。
 *
 * @关键设计:
 * - 上游 defaultUrlTransform 把「第一个 : 出现在任何 / ? # 之前」的 URL 当协议名;
 *   `C:\Users\...` 的 "C:" 命中该判定且不在 ^(https?|ircs?|mailto|xmpp)$ 白名单,
 *   整条 href 被剥成空串 → MdLink 的 `if (!href) return` 让点击永远无反应
 *   (2026-08-23 用户报告 D:\ 与 C:\ 路径均不可点;复现证据见本目录测试文件头)。
 *   v0.3.3 ADR-035 起 `marina:show a.md` 同理 —— marina 不在白名单,也要放行。
 * - micromark 解析层会把链接目标里的反斜杠/空格百分号编码:本函数收到的实际是
 *   "C:%5CUsers%5C..." / "marina:show%20a.md" 等形态,均原样透传给下游
 *   (main 端统一 decode)。
 * - 放行是安全的:Marina 的 <a> 点击永远 preventDefault 后走自己的分流
 *   (外链 openExternal / #anchor / 本地 FILE_PANEL_OPEN_PATH / marina: 动作链接),
 *   href 值不会变成 webContents 导航;javascript:/data: 等危险协议仍被上游剥空
 *   (marinax: 这类伪前缀不会误命中,见 isMarinaActionHref)。
 * - main 端 openFileFromMarkdown 对 src 先 decodeURIComponent 再 resolve,
 *   绝对路径直接覆盖 md 目录基准 —— 无需 main 侧配合改动。
 *
 * @对应文档: src/shared/url-scheme.ts isWindowsDrivePath / isMarinaActionHref;
 *   src/shared/marina-link.ts(动作链接解析);软件定义书 ADR-035。
 *
 * @不要在这里做的事:
 * - 不放行 file:// 协议(main 未处理它,点了会按本地路径解析失败,保持剥空)。
 * - 不解析 marina: 的参数(渲染层只认前缀;解析在 main 端,防伪造与职责漂移)。
 * - 不引入 React 组件链 —— 本文件必须保持可被 node 环境单测的纯函数。
 */
import { defaultUrlTransform } from 'react-markdown';
import { isMarinaActionHref, isWindowsDrivePath } from '@shared/url-scheme';

/**
 * react-markdown urlTransform 属性的实现:
 * Windows 盘符绝对路径与 marina: 动作链接原样放行,其余 URL 走上游默认消毒。
 */
export function marinaUrlTransform(url: string): string {
  if (isWindowsDrivePath(url)) return url;
  if (isMarinaActionHref(url)) return url;
  return defaultUrlTransform(url);
}
