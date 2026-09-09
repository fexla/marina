/**
 * @file src/renderer/components/file-panel/md-src-base.ts
 * @purpose Markdown 文档里相对路径引用(本地链接/图片/gallery)的来源基准构造器
 *   (v0.3.3 ADR-036)。
 *
 * @背景:正文模块 MarkdownDocument 有两种来源 ——「已打开」面板的真实文件
 *   (fileContext.path,成员校验 + md 目录基准)与命令面板输出(无文档路径,
 *   以指令运行时 cwd = CommandEntry.runCwd 为基准,main 端真值)。两者的
 *   IPC payload(FILE_PANEL_OPEN_PATH / READ_IMAGE / GALLERY_*)都要求
 *   mdPath 与 commandKey **恰好给其一**;本文件把"构造这两个字段"收口,
 *   MdLink / MdImage / GalleryViewer / imageActions 不再各写一份条件展开
 *   (三处各写一份正是本批之前"新功能接不上第二来源"的病灶之一)。
 *
 * @不要在这里做的事:
 * - 不解析路径(那是 main 端 file-panel-service 的职责,renderer 永不猜基准值)。
 * - 不 import React(纯函数,保持可被任意模块零成本引用)。
 */

/** 一个文档来源的路径基准:文件来源 mdPath / 命令来源 commandKey,恰好一个。 */
export interface MdSrcBase {
  /** 「已打开」面板来源:main 已规范化并纳入成员集合的 md 绝对路径。 */
  mdPath?: string;
  /** 命令面板输出来源:该输出所属指令的 key(main 用它查 runCwd 真值)。 */
  commandKey?: string;
}

/** true = 该来源具备相对路径解析能力(文件或命令其一)。 */
export function hasMdSrcBase(base: MdSrcBase | undefined): boolean {
  if (!base) return false;
  return base.mdPath !== undefined || base.commandKey !== undefined;
}

/**
 * 展开成 IPC payload 的基准字段(mdPath 优先,恰好一个;两者皆无返回空对象,
 * main 端会报 missing path base —— 那是不可达路径,渲染层 gate 已拦)。
 */
export function mdSrcBasePayload(
  base: MdSrcBase | undefined,
): { mdPath?: string; commandKey?: string } {
  if (!base) return {};
  if (base.mdPath !== undefined) return { mdPath: base.mdPath };
  if (base.commandKey !== undefined) return { commandKey: base.commandKey };
  return {};
}
