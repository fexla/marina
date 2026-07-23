/**
 * @file src/shared/panel-preferences.ts
 * @purpose 面板 UI「偏好」的跨重启持久化 —— 视图模式(tree/flat)、活跃 root、
 *   排序方式等"用户选择,关掉 Marina 重开也该记住"的少量、稳定的 UI 偏好。
 *
 * @关键设计:
 * - 这是面板 UI 状态三层模型的 **L2 层**(见 ADR-019):
 *     L0 瞬态(loading/error)        → 组件 useState
 *     L1 工作态(展开目录/选中项)     → panel-ui-cache.ts(跨 mount,重启丢)
 *     L2 偏好(视图模式/活跃 root)    → 本模块(跨重启,localStorage) ← 这里
 * - 统一 key 规范:`marina.panel.<panelId>.<key>`,收编此前散落的裸 localStorage key
 *   (marina.git.viewMode / marina.sidebar.segment / marina.sidebar.width)。
 *   首次读取老 key 时**惰性迁移**到新规范并删除老 key(一次性,用户无感)。
 * - 值统一 JSON 序列化,支持任意 JSON 结构(字符串/数字/对象);老裸字符串值在迁移时
 *   做 JSON.parse 兜底,失败则当裸字符串包回 JSON,保证迁移后格式一致。
 * - **可注入 storage**:默认惰性拿 globalThis.localStorage(生产 renderer 有);
 *   node 测试环境无 localStorage,用内置内存 storage 兜底,或 setPreferenceStorage
 *   注入隔离实例。这样纯逻辑可在 vitest(node 环境)单测,无需 jsdom。
 *
 * @对应文档章节: docs/方案-面板UI状态与缩进统一-20260721.md §2.1;ADR-019。
 *
 * @不要在这里做的事:
 * - 不存工作态(展开目录那种数据量大、随 session 变的 —— 那是 L1 的职责;
 *   localStorage 不适合存大量/高频变化数据,会拖慢启动读取)。
 * - 不做加密/敏感数据(本地明文偏好,如未来需敏感配置另设机制)。
 * - 不响应式通知:本模块不是 store,各调用方各自读;偏好变更通常即改即生效,
 *   无需跨组件广播(若需要,由调用方自行通过既有 store 同步)。
 */

/** localStorage 的最小子集接口(读写删),便于注入测试实现。 */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 新规范 key 前缀。所有面板偏好都挂在 marina.panel.* 下,便于排查/清理。 */
const KEY_PREFIX = 'marina.panel.';

/**
 * 老 key → (panelId, key) 迁移映射。读新 key 未命中时,若老 key 存在则迁移。
 * 收编历史上散落的裸 localStorage key,迁移后删除老 key。
 */
const LEGACY_KEY_MAP: Record<string, { panelId: string; key: string }> = {
  'marina.git.viewMode': { panelId: 'git', key: 'viewMode' },
  'marina.sidebar.segment': { panelId: 'sidebar', key: 'segment' },
  'marina.sidebar.width': { panelId: 'sidebar', key: 'width' },
};

/** 反查:从 (panelId, key) 找到老 key(迁移用)。构建一次,供 read 查询。 */
const LEGACY_REVERSE: Record<string, string> = {};
for (const [oldKey, target] of Object.entries(LEGACY_KEY_MAP)) {
  LEGACY_REVERSE[`${target.panelId}:${target.key}`] = oldKey;
}

/** 内存 storage 兜底(node 测试环境或浏览器禁用 localStorage 时用)。 */
function createMemoryStorage(): PreferenceStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/**
 * 当前 storage 引用。惰性解析:
 * - override 非空 → 用注入的(测试隔离)。
 * - 否则若有 globalThis.localStorage → 用真的(生产 renderer)。
 * - 否则用模块级内存实例(node 测试无 localStorage 时不崩)。
 *
 * 每次调用 getStorage() 解析,而非启动时一次性绑定 —— 这样 setPreferenceStorage
 * 注入后立即生效,且 globalThis.localStorage 在某些环境是延迟注入的。
 */
let override: PreferenceStorage | null = null;
let memoryFallback: PreferenceStorage | null = null;

function getStorage(): PreferenceStorage {
  if (override) return override;
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) return ls;
  } catch {
    /* 某些环境访问 localStorage 会抛(隐私模式 / SSR),落兜底。 */
  }
  if (!memoryFallback) memoryFallback = createMemoryStorage();
  return memoryFallback;
}

/**
 * 注入测试用 storage(传 null 恢复默认解析)。生产代码不应调用。
 *
 * 测试用法:每个 it 注入一个全新 createMemoryStorage() 实现隔离,避免用例间污染。
 */
export function setPreferenceStorage(storage: PreferenceStorage | null): void {
  override = storage;
}

function newKey(panelId: string, key: string): string {
  return `${KEY_PREFIX}${panelId}.${key}`;
}

/**
 * 把 localStorage 里的原始字符串解析回值。兼容两种历史格式:
 * - 新格式:JSON 序列化('"tree"' / '300' / '{"a":1}')。
 * - 老裸格式:非 JSON 的裸字符串(如 'tree' —— 老代码 setItem 直接存值)。
 *   尝试 JSON.parse,失败则原样返回字符串。
 */
function parseRaw(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * 读取某 panel 某 key 的偏好。未命中(新老 key 都没有)返回 fallback。
 *
 * 迁移:新 key 未命中但老 key 存在时,读老值、normalize、写到新 key、删除老 key,
 * 然后返回迁移后的值。一次性,后续读直接命中新 key。
 *
 * @example
 *   const mode = readPanelPreference<GitViewMode>('git', 'viewMode', 'tree');
 */
export function readPanelPreference<T>(panelId: string, key: string, fallback: T): T {
  const storage = getStorage();
  const nk = newKey(panelId, key);

  const rawNew = storage.getItem(nk);
  if (rawNew !== null) {
    const parsed = parseRaw(rawNew);
    return (parsed as T) ?? fallback;
  }

  // 新 key 未命中 → 查老 key 做一次性迁移。
  const oldKey = LEGACY_REVERSE[`${panelId}:${key}`];
  if (oldKey) {
    const rawOld = storage.getItem(oldKey);
    if (rawOld !== null) {
      const value = parseRaw(rawOld);
      storage.setItem(nk, JSON.stringify(value));
      storage.removeItem(oldKey);
      return (value as T) ?? fallback;
    }
  }

  return fallback;
}

/** 写入(覆盖)某 panel 某 key 的偏好。值经 JSON 序列化。 */
export function writePanelPreference<T>(panelId: string, key: string, value: T): void {
  getStorage().setItem(newKey(panelId, key), JSON.stringify(value));
}

/** 删除某 panel 某 key 的偏好。 */
export function removePanelPreference(panelId: string, key: string): void {
  getStorage().removeItem(newKey(panelId, key));
}
