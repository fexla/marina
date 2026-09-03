/**
 * @file packages/pi-marina-bridge/extensions/binding.ts
 * @purpose pi 对话 ↔ Marina workspace 绑定的**读取**纯函数。从 index.ts 拆出
 *   以便可单测(被 src/main/pi-bridge-binding.test.ts 相对路径 import)。
 *
 * @关键设计(方案-pibridge-fork与子会话适配-20260817,裁决 1/3):
 * - 绑定 entry 是会话**树上的节点**(pi.appendEntry 落在当时的 leaf),不是文件
 *   属性。同一文件会累积多个绑定 entry(workspace 被回收→resume 重建时会追加)。
 * - 因此「本对话当前绑定的 workspace」= **当前分支(leaf→root 路径)上离 leaf
 *   最近的 marina-workspace entry**,不是全文件第一个(旧实现的 bug:永远命中最老
 *   的、大概率已回收的死绑定 → 每次 resume 都新建 workspace,永不收敛)。
 * - fork(裁决 1):/fork 复制 root→fork 点路径到新文件,绑定 entry 被继承。
 *   fork 后 Marina 新建的 workspace 会 append 在 fork 自己的 leaf,branch-aware
 *   读天然取到新的,继承 entry 沦为无害祖先节点。
 * - 亲缘(裁决 3):fork/子会话文件 header 带 parentSession(父会话文件路径)。
 *   bridge 额外读父文件**最后追加**的绑定 entry(= 父对话的当前 workspace),
 *   随 session_start 上报;Marina 用它判定「payload 里的绑定是否是继承来的」
 *   (相等 → 继承,fork 血统不共享父 workspace,而是复制一份)。
 *
 * @不要在这里做的事:
 * - 不发 HTTP(那是 index.ts 的职责)
 * - 不写 entry(appendEntry 只在 Marina 返回新 workspaceId 时由 index.ts 执行)
 */
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** 与 index.ts 共享的 customType(存 workspaceId 的 custom entry 类型标识)。 */
export const MARINA_WORKSPACE_CUSTOM_TYPE = 'marina-workspace';

/** 只依赖 SessionManager 只读面的最小结构(测试可喂裸对象)。 */
export interface BindingSessionManagerLike {
  /** 全部 entry(整个树,文件追加序)。旧路径/回退用。 */
  getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
  /**
   * 当前分支(root→leaf 顺序,pi 实现 walk leaf→root 后 reverse)。
   * 旧版 pi 可能没有 → 调用方需探测,缺省时回退 getEntries 全量扫描。
   */
  getBranch?(fromId?: string): Array<{ type: string; customType?: string; data?: unknown }>;
}

/** 从 entry 里提取 workspaceId;非绑定 entry 返回 null。 */
function entryWorkspaceId(entry: {
  type: string;
  customType?: string;
  data?: unknown;
}): string | null {
  if (
    entry.type === 'custom' &&
    entry.customType === MARINA_WORKSPACE_CUSTOM_TYPE &&
    entry.data &&
    typeof (entry.data as { workspaceId?: unknown }).workspaceId === 'string'
  ) {
    return (entry.data as { workspaceId: string }).workspaceId;
  }
  return null;
}

/**
 * 读「本对话当前绑定的 workspaceId」。
 *
 * 优先 getBranch()(当前分支):数组是 root→leaf 顺序,**离 leaf 最近的绑定在
 * 末尾**,所以从尾往前扫,第一个命中即返回。同文件其他分支上的绑定 entry、
 * 以及本分支上更早(更老)的绑定,都被更近的覆盖——这就是「位置语义」:
 * /tree 导航到历史分支后 resume,取到的是那个位置对应的绑定。
 *
 * 旧版 pi 无 getBranch → 回退 getEntries() 全量扫描取**最后一个**(追加序里
 * 最后追加的 = 最新的绑定;比旧实现的 first-match 正确,且不依赖新 API)。
 * 无任何绑定 entry → null(首访对话 / 从未绑定过的子会话)。
 */
export function readBranchWorkspaceId(sm: BindingSessionManagerLike): string | null {
  const scan = (
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
  ): string | null => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry) continue;
      const ws = entryWorkspaceId(entry);
      if (ws !== null) return ws;
    }
    return null;
  };
  if (typeof sm.getBranch === 'function') {
    // 当前分支(root→leaf 顺序):离 leaf 最近的绑定在末尾,从尾往前扫。
    return scan(sm.getBranch());
  }
  // 旧版 pi 无 getBranch → 回退全量追加序取最后一个(最新),比旧实现的
  // first-match 正确,且不依赖新 API。
  return scan(sm.getEntries());
}

/**
 * 父文件扫描的大小上限(病态护栏):超过期不扫,返回 null(调用方回退继承
 * payload 绑定,行为安全)。正常 pi 会话文件远小于此。 */
const PARENT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 读另一个会话文件(pi 会话 JSONL)里**最后追加**的 marina-workspace 绑定。
 *
 * 用途:fork/子会话上报亲缘时,取父对话的**当前** workspace。
 *
 * **为什么是流式全文件前扫而不是尾部读窗**(2026-09-03 现场抓的缺陷):
 * 绑定 entry 通常在会话开始时追加一次(文件头部),之后对话可以长到 MB 级——
 * 尾窗读不到头部的绑定,亲缘字段静默变 null。实测:父文件 1.06MB、唯一绑定在
 * L4,64KB 尾窗返回 null(parentWs=-,Marina 日志实证)。改为 readline 流式
 * 前扫保留最后一个命中:内存平坦(逐行),一次 session_start 只扫一次,几 MB
 * 文件毫秒级,不在热路径。
 *
 * 「最后追加」而非「branch-aware」:父文件里的绑定按追加时间排序,最后一条
 * = 父对话最近一次被 Marina 分配的 workspace = 父的当前绑定(每次分配都紧跟
 * 着 append;/tree 导航不产生新绑定 entry)。
 *
 * @param sessionFile 父会话文件绝对路径(header.parentSession)
 * @returns workspaceId;文件不存在/超上限/没找到 → null(静默降级)
 */
export async function readLastWorkspaceBinding(sessionFile: string): Promise<string | null> {
  try {
    const { size } = await fs.stat(sessionFile);
    if (size > PARENT_MAX_BYTES) return null;
    const rl = createInterface({
      input: createReadStream(sessionFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let last: string | null = null;
    for await (const line of rl) {
      if (!line.includes(MARINA_WORKSPACE_CUSTOM_TYPE)) continue; // 快速过滤大多数行
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          customType?: string;
          data?: unknown;
        };
        const ws = entryWorkspaceId(entry as { type: string; customType?: string; data?: unknown });
        if (ws !== null) last = ws;
      } catch {
        // 非 JSON 行(理论不出现,防御)→ 跳过
      }
    }
    return last;
  } catch {
    // 文件不存在 / 已被清理 / 权限 → null,调用方按无可继承处理
    return null;
  }
}
