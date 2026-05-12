/**
 * @file src/renderer/components/icons.tsx
 * @purpose 集中导出本应用 UI 里用到的 lucide-react 图标 + 一个统一的
 *   <Icon /> 包装。CP-4 勘误 #11 引入 — 之前 UI 各处用 Emoji 当图标 (🎨 / 🔍 /
 *   📌 等),不同字体下渲染差异很大,且与"产品级感"不搭。
 *
 * @关键设计:
 * - 仅在 UI shell (设置页 nav / 侧栏分类 / 终端右键 / 状态条 等) 替换 Emoji
 * - 用户数据里的 emoji (Template.icon) 保持原样 — 那是用户自己输入的
 * - 所有图标统一 size=14,继承 currentColor,与主题文字色同步
 * - 只 import 需要的图标,bundle 里其它 lucide 图标 tree-shake 掉
 *
 * @对应文档章节: 软件定义书.md 5.1.9 (主题); CP-4 勘误 #11
 */
import type { ReactElement } from 'react';
import {
  AlertTriangle,
  Bookmark,
  ChevronRight,
  CircleDot,
  Clipboard,
  ClipboardPaste,
  Clock,
  Database,
  Eraser,
  ExternalLink,
  History,
  Info,
  Link2,
  MonitorCog,
  Palette,
  Plus,
  Search,
  Settings,
  Sliders,
  Wrench,
  X,
} from 'lucide-react';

/**
 * 默认图标尺寸 (px)。UI 文字 13px,匹配相同视觉重量取 14。
 * 状态点等极小图标用 12;tab 关闭按钮等中等用 16。
 */
export const ICON_SIZE_DEFAULT = 14;
export const ICON_SIZE_SMALL = 12;
export const ICON_SIZE_MEDIUM = 16;

/**
 * 命名映射 — 把 UI 里的"语义"(分类) 与 lucide 实际组件挂上钩。
 * 用别处只 import 这一份名字表,后续整体换图标库的代价较小。
 */
export const Icons = {
  // 设置页分类
  appearance: Palette,
  shell: MonitorCog,
  behavior: Sliders,
  data: Database,
  systemIntegration: Link2,
  advanced: Wrench,
  about: Info,

  // 侧栏分类
  bookmark: Bookmark,
  clock: Clock,
  history: History,

  // 终端右键 / 搜索栏
  copy: Clipboard,
  paste: ClipboardPaste,
  clear: Eraser,
  search: Search,

  // 通用
  settings: Settings,
  alertTriangle: AlertTriangle,
  externalLink: ExternalLink,
  chevronRight: ChevronRight,
  circleDot: CircleDot,
  close: X,
  plus: Plus,
} as const;

export type IconName = keyof typeof Icons;

/**
 * 通用 Icon 组件。color 默认走 currentColor,大小默认 14;通过 className 挂
 * 主题样式 (例如 .session-icon-warn { color: var(--gold) })。
 */
export function Icon({
  name,
  size = ICON_SIZE_DEFAULT,
  className,
  strokeWidth = 1.8,
  ...rest
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  'aria-label'?: string;
}): ReactElement {
  const Comp = Icons[name];
  return <Comp size={size} strokeWidth={strokeWidth} className={className} {...rest} />;
}
