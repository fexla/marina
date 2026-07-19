/**
 * @file src/renderer/components/common/SearchBar.tsx
 * @purpose 共享搜索栏组件,供 dock 面板(Ctrl+F)与终端搜索复用。
 *
 * @关键设计:
 * - 受控组件:query / caseSensitive 由父组件持有,便于父级用同一份 query 驱动
 *   过滤/查找逻辑。父级持有 = 列表过滤与命中计数都在父级 useMemo 算,SearchBar
 *   只管 UI + 键盘事件分发。
 * - 两种形态由 showNavigator 区分:
 *     · 查找型(terminal / 文件内查找):showNavigator=true,显示 x/N + 上/下按钮
 *     · 过滤型(Files / Git / Opened 列表):showNavigator=false,隐藏命中数与上/下,
 *       Enter 走 onEnter(通常是"打开第一个匹配")
 * - 键盘:Esc 关闭 / Enter 下一个(过滤型=onEnter) / Shift+Enter 上一个。
 *   stopPropagation 避免冒泡到 dock / 终端 keydown 监听重复处理。
 * - 样式复用原 .terminal-search-* 系列(已通用化重命名见 global.css);本组件
 *   直接用 .search-* 类,终端切换过来后也用同一套。
 *
 * @对应文档:docs/方案-面板Ctrl-F搜索-20260719.md
 *
 * @不要在这里做的事:
 * - 不要在这里实现过滤/查找逻辑(那是父组件的职责,SearchBar 只展示 + 分发事件)
 * - 不要持有 query state(受控,父级持有。否则 dock 级 query 无法传给面板内容)
 */
import { type RefObject } from 'react';
import { useTranslation } from '../LanguageProvider';

export interface SearchBarProps {
  /** 当前查询字符串(受控)。 */
  query: string;
  /** query 变化回调。 */
  onQueryChange: (q: string) => void;
  /** 关闭搜索栏(Esc / ×)。父级负责清状态 + 归还焦点。 */
  onClose: () => void;
  /** 大小写敏感开关当前值。 */
  caseSensitive: boolean;
  /** 切换大小写敏感。 */
  onToggleCase: () => void;

  /**
   * 是否显示「命中数 x/N + 上/下按钮」。
   * - true(默认)= 查找型(terminal / 文件内查找):多匹配间跳转
   * - false = 过滤型(列表):无"下一个"概念,Enter 走 onEnter
   */
  showNavigator?: boolean;
  /** 查找型:总命中数。 */
  matches?: number;
  /** 查找型:当前命中序号(1-based)。 */
  current?: number;
  /** 查找型:下一个(Enter)。 */
  onNext?: () => void;
  /** 查找型:上一个(Shift+Enter)。 */
  onPrev?: () => void;
  /** 过滤型:Enter 回调(通常是打开第一个匹配)。 */
  onEnter?: () => void;

  /** input 的 ref(父级聚焦用)。 */
  inputRef?: RefObject<HTMLInputElement>;
  /** 自定义 placeholder / aria-label(双语)。 */
  placeholderZh?: string;
  placeholderEn?: string;
  ariaLabelZh?: string;
  ariaLabelEn?: string;
}

/**
 * 渲染统一搜索栏。详见 SearchBarProps 字段注释。
 */
export function SearchBar({
  query,
  onQueryChange,
  onClose,
  caseSensitive,
  onToggleCase,
  showNavigator = true,
  matches = 0,
  current = 0,
  onNext,
  onPrev,
  onEnter,
  inputRef,
  placeholderZh,
  placeholderEn,
  ariaLabelZh,
  ariaLabelEn,
}: SearchBarProps): JSX.Element {
  const { tx } = useTranslation();
  const placeholder =
    placeholderZh || placeholderEn
      ? tx(
          placeholderZh ?? '搜索 (Enter 下一个 / Shift+Enter 上一个 / Esc 关闭)',
          placeholderEn ?? 'Search (Enter = next, Shift+Enter = prev, Esc = close)',
        )
      : tx(
          '搜索 (Enter 下一个 / Shift+Enter 上一个 / Esc 关闭)',
          'Search (Enter = next, Shift+Enter = prev, Esc = close)',
        );
  const ariaLabel = tx(ariaLabelZh ?? '搜索', ariaLabelEn ?? 'Search');

  const hasQuery = query.length > 0;
  // 查找型:无匹配时禁用上/下;过滤型:不显示上/下,该值不影响渲染
  const navDisabled = !hasQuery || matches === 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        // Shift+Enter = 上一个(两种形态都有意义:查找型跳上一个,过滤型通常无方向
        // 概念但仍透传 onPrev 给父级决定)
        onPrev?.();
      } else if (showNavigator) {
        onNext?.();
      } else {
        // 过滤型 Enter = 打开第一个匹配
        onEnter?.();
      }
    }
  };

  return (
    <div className="search-bar" role="search" aria-label={ariaLabel}>
      <input
        ref={inputRef}
        type="text"
        className="search-bar-input"
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoComplete="off"
      />
      {showNavigator && (
        <>
          <span
            className="search-bar-count"
            title={
              hasQuery
                ? tx(
                    `${matches} 个匹配,当前第 ${current}`,
                    `${matches} matches, currently #${current}`,
                  )
                : tx('输入关键字开始搜索', 'Type to start searching')
            }
          >
            {hasQuery
              ? matches > 0
                ? `${current}/${matches}`
                : tx('无匹配', 'No match')
              : '—'}
          </span>
          <button
            type="button"
            className="search-bar-btn"
            onClick={() => onPrev?.()}
            title={tx('上一个 (Shift+Enter)', 'Previous (Shift+Enter)')}
            aria-label={tx('上一个匹配', 'Previous match')}
            disabled={navDisabled}
          >
            ↑
          </button>
          <button
            type="button"
            className="search-bar-btn"
            onClick={() => onNext?.()}
            title={tx('下一个 (Enter)', 'Next (Enter)')}
            aria-label={tx('下一个匹配', 'Next match')}
            disabled={navDisabled}
          >
            ↓
          </button>
        </>
      )}
      <button
        type="button"
        className={`search-bar-btn${caseSensitive ? ' active' : ''}`}
        onClick={onToggleCase}
        title={tx('区分大小写', 'Case sensitive')}
        aria-label={tx('区分大小写', 'Case sensitive')}
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        className="search-bar-btn close"
        onClick={onClose}
        title={tx('关闭 (Esc)', 'Close (Esc)')}
        aria-label={tx('关闭搜索', 'Close search')}
      >
        ×
      </button>
    </div>
  );
}
