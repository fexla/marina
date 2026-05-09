/**
 * @file src/main/persistence.ts
 * @purpose JSON 文件持久化:原子写、损坏恢复、版本迁移、debounced 写入。
 *
 * @关键设计 (软件定义书 11.3):
 * - 原子写: 写临时文件 → fsync → rename(目标),失败回滚不破坏现有文件
 * - 备份: 每次成功写入前,把现有目标文件复制为 .bak
 * - 加载: 主文件 JSON 解析失败 → 尝试 .bak → 都失败用默认值
 * - 写入 debounce 500ms 合并高频变更 (软件定义书 6.6.1 即改即生效但不写
 *   过快;以及 PathManager 在多个改动后只写一次)
 * - 数据目录: app.getPath('userData') (跨平台,Win 下是 %APPDATA%\EasyTerm)
 *
 * @对应文档章节: 软件定义书.md 11.1、11.3;AGENTS.md 5.3 (持久化必测)
 *
 * @安全约束 (AGENTS.md 9.1):
 * - 测试不许碰真实数据目录,必须用 os.tmpdir() 隔离
 * - 写入失败要有详细错误日志,不能静默吞错
 *
 * @不在这里做的事:
 * - 不做 schema 校验 (那是各 Manager 的职责,Persistence 只管 JSON I/O)
 * - 不做文件锁 (Electron 单实例锁已保证只有一个进程在写)
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 单个 JSON 文件的存储抽象。每个持久化的 schema (settings/bookmarks/recent/
 * templates) 创建一个 JsonStore 实例。
 *
 * 类型参数 T 是文件内容的 JS 形态。Persistence 自身不校验 T 的 schema,
 * 调用方 (Manager) 自己校验。
 */
export class JsonStore<T> {
  private writeTimer: NodeJS.Timeout | null = null;
  /** 待写入的最新值,以 _ 标记内部 */
  private pendingValue: T | null = null;
  /** 上一次成功写入的内存副本,用于 debounce 期间快速读 */
  private lastValueInMemory: T | null = null;
  /** 当前正在执行的写入 promise,防止并发 fs 操作 */
  private writeInFlight: Promise<void> | null = null;

  constructor(
    /** JSON 文件绝对路径 */
    private readonly filePath: string,
    /** 写入 debounce 间隔 ms */
    private readonly debounceMs: number = 500,
  ) {}

  /**
   * 加载文件。返回值的查找顺序:主文件 → .bak → 默认值 (调用方提供)。
   *
   * 任意一步成功后立即返回,不再尝试后续 fallback。
   * 三步全失败时返回 defaultValue 但**不**写盘 (避免覆盖损坏文件,
   * 留给开发者人工排查)。
   *
   * @returns 第一项是值,第二项是来源 ('main' | 'bak' | 'default')
   */
  async load(defaultValue: T): Promise<{ value: T; source: 'main' | 'bak' | 'default' }> {
    const mainResult = await this.tryRead(this.filePath);
    if (mainResult !== null) {
      this.lastValueInMemory = mainResult as T;
      return { value: mainResult as T, source: 'main' };
    }

    const bakResult = await this.tryRead(this.bakPath());
    if (bakResult !== null) {
      this.lastValueInMemory = bakResult as T;
      return { value: bakResult as T, source: 'bak' };
    }

    this.lastValueInMemory = defaultValue;
    return { value: defaultValue, source: 'default' };
  }

  /**
   * 同步获取当前内存副本 (上次 load / set 的值)。
   * 在 load 之前返回 null。
   */
  getInMemory(): T | null {
    return this.lastValueInMemory;
  }

  /**
   * 标记一个新值,在 debounceMs 后落盘。多次调用合并,以最后一次的值为准。
   *
   * 不抛错:磁盘错误会被 catch 后 console.error,因为 set 是 fire-and-forget。
   * 真要等待落盘完成,调 flush()。
   */
  set(value: T): void {
    this.pendingValue = value;
    this.lastValueInMemory = value;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flushInternal().catch((err) => {
        console.error(`[JsonStore] flush failed for ${this.filePath}:`, err);
      });
    }, this.debounceMs);
  }

  /**
   * 立即落盘待写入的值,等待完成。如果没有 pending 写入,等待当前正在
   * 进行的写入 (若有);两个都没有则立即返回。
   */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flushInternal();
  }

  /**
   * 销毁存储 (清掉 timer)。不写盘,如果你要数据落盘,先 flush。
   */
  destroy(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pendingValue = null;
  }

  // ──────────────────────────────────────────────────────────────────
  // 内部: 实际 I/O
  // ──────────────────────────────────────────────────────────────────

  /**
   * 真正执行写入。原子写策略: 写临时文件 → 把现有 target 复制为 .bak →
   * rename(临时, target)。
   *
   * 串行化:同时只有一个 flushInternal 在跑;期间又来 set() 会更新
   * pendingValue,等当前 flush 结束后接着写一次 (如果 pending 还有新值)。
   */
  private async flushInternal(): Promise<void> {
    // 串行化:等当前正在跑的写入完成,再发起新的
    if (this.writeInFlight) {
      await this.writeInFlight.catch(() => {}); // 上一个失败也别阻塞下一次
    }
    if (this.pendingValue === null) return;

    const valueToWrite = this.pendingValue;
    this.pendingValue = null;

    this.writeInFlight = this.atomicWrite(valueToWrite);
    try {
      await this.writeInFlight;
    } finally {
      this.writeInFlight = null;
    }

    // flush 期间又有 set 进来,递归处理 (避免丢更新)
    if (this.pendingValue !== null) {
      await this.flushInternal();
    }
  }

  private async atomicWrite(value: T): Promise<void> {
    const dir = dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const json = JSON.stringify(value, null, 2);
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;

    // 1) 写临时文件 + fsync
    const fh = await fs.open(tmpPath, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }

    // 2) 现有目标文件复制为 .bak (失败不致命:首次写时 target 不存在)
    try {
      await fs.copyFile(this.filePath, this.bakPath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 真正的 I/O 错误 (权限等),记录但继续 — 没 .bak 总比写不进去好
        console.warn(`[JsonStore] backup copy failed for ${this.filePath}:`, err);
      }
    }

    // 3) rename 临时 → target (Windows 上 rename 自动覆盖在 Node 18+ 是 OK 的)
    try {
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      // rename 失败时清掉 tmp 避免残留
      await fs.unlink(tmpPath).catch(() => {});
      throw new Error(
        `[JsonStore] atomic rename failed: ${tmpPath} -> ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 读一个文件并解析 JSON。文件不存在 / 解析失败 / I/O 错误 → null。
   */
  private async tryRead(path: string): Promise<unknown | null> {
    try {
      const text = await fs.readFile(path, 'utf8');
      return JSON.parse(text);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null; // 文件不存在,正常情况之一
      // 解析失败或 I/O 错误,日志一下让开发者知道
      console.warn(
        `[JsonStore] read failed for ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private bakPath(): string {
    return `${this.filePath}.bak`;
  }
}

/**
 * 创建一个临时数据目录 (测试用)。
 *
 * AGENTS.md 9.1 强约束:测试**永远不许**用真实 EasyTerm 数据目录,
 * 必须每次创建新的 temp dir,测试结束清理。
 */
export async function createTempDataDir(prefix = 'easyterm-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

/**
 * 删除测试 temp 目录。force/recursive 防止 Windows 文件锁导致的失败。
 */
export async function removeTempDataDir(path: string): Promise<void> {
  // 容忍 Windows 上的瞬时 EBUSY,重试 3 次
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === 2) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}
