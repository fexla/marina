/**
 * @file src/main/persistence.test.ts
 * @purpose JsonStore 的全面测试。覆盖原子写、损坏恢复、debounce、并发、
 *   AGENTS.md 5.6 要求的"会出错"场景 (corrupted JSON / I/O 失败 / 磁盘满等)。
 *
 * @对应文档章节: AGENTS.md 5.3 (持久化必测)、5.6 (测试要会出错)
 *
 * @安全约束: 全部用 createTempDataDir 隔离,每个 case 后 removeTempDataDir。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { JsonStore, createTempDataDir, removeTempDataDir } from './persistence';

interface SampleData {
  version: 1;
  counter: number;
  items: string[];
}

const DEFAULT: SampleData = { version: 1, counter: 0, items: [] };

describe('JsonStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await createTempDataDir('persistence-test-');
    filePath = join(dir, 'sample.json');
  });

  afterEach(async () => {
    await removeTempDataDir(dir);
  });

  describe('load 路径回退', () => {
    it('文件不存在时返回默认值,source = "default",不写盘', async () => {
      const store = new JsonStore<SampleData>(filePath);
      const result = await store.load(DEFAULT);
      expect(result.value).toEqual(DEFAULT);
      expect(result.source).toBe('default');
      // 不写盘
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('主文件存在且合法时返回主文件内容', async () => {
      const data: SampleData = { version: 1, counter: 5, items: ['a', 'b'] };
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
      const store = new JsonStore<SampleData>(filePath);
      const result = await store.load(DEFAULT);
      expect(result.value).toEqual(data);
      expect(result.source).toBe('main');
    });

    it('主文件 JSON 损坏 → 回退 .bak', async () => {
      const data: SampleData = { version: 1, counter: 7, items: ['x'] };
      await fs.writeFile(filePath, '{ not json', 'utf8');
      await fs.writeFile(`${filePath}.bak`, JSON.stringify(data), 'utf8');
      // 主文件解析失败时 JsonStore 会 console.warn,这是预期行为,
      // 测试里抑制掉以保持测试输出干净
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = new JsonStore<SampleData>(filePath);
      const result = await store.load(DEFAULT);
      expect(result.value).toEqual(data);
      expect(result.source).toBe('bak');
      expect(warnSpy).toHaveBeenCalled(); // 同时验证 warn 真的发了
      warnSpy.mockRestore();
    });

    it('主文件与 .bak 都损坏 → 默认值', async () => {
      await fs.writeFile(filePath, 'corrupted', 'utf8');
      await fs.writeFile(`${filePath}.bak`, 'also corrupted', 'utf8');
      // 抑制 console.warn
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = new JsonStore<SampleData>(filePath);
      const result = await store.load(DEFAULT);
      expect(result.value).toEqual(DEFAULT);
      expect(result.source).toBe('default');
      // 损坏不应自动覆盖,留给开发者排查
      const remaining = await fs.readFile(filePath, 'utf8');
      expect(remaining).toBe('corrupted');
      warnSpy.mockRestore();
    });

    it('主文件不存在但 .bak 存在 → 返回 .bak', async () => {
      const data: SampleData = { version: 1, counter: 99, items: [] };
      await fs.writeFile(`${filePath}.bak`, JSON.stringify(data), 'utf8');
      const store = new JsonStore<SampleData>(filePath);
      const result = await store.load(DEFAULT);
      expect(result.value).toEqual(data);
      expect(result.source).toBe('bak');
    });
  });

  describe('原子写 + .bak', () => {
    it('首次写入创建文件,无 .bak (没有前一份可备份)', async () => {
      const store = new JsonStore<SampleData>(filePath, 0); // 立即写
      store.set({ version: 1, counter: 1, items: ['first'] });
      await store.flush();
      const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(written.counter).toBe(1);
      // 首次写时 .bak 不存在 (代码 catch 了 ENOENT)
      await expect(fs.access(`${filePath}.bak`)).rejects.toThrow();
    });

    it('第二次写入会把当前文件备份到 .bak,然后覆盖主文件', async () => {
      const store = new JsonStore<SampleData>(filePath, 0);
      store.set({ version: 1, counter: 1, items: ['v1'] });
      await store.flush();
      store.set({ version: 1, counter: 2, items: ['v2'] });
      await store.flush();

      const main = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const bak = JSON.parse(await fs.readFile(`${filePath}.bak`, 'utf8'));
      expect(main.counter).toBe(2);
      expect(bak.counter).toBe(1);
    });

    it('rename 失败时清理临时文件,不留下 .tmp', async () => {
      const store = new JsonStore<SampleData>(filePath, 0);
      // 先正常写一次,确保 dir 创建
      store.set({ version: 1, counter: 1, items: [] });
      await store.flush();

      // mock fs.rename 让它失败
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
        new Error('mock rename failure'),
      );
      store.set({ version: 1, counter: 2, items: [] });
      await expect(store.flush()).rejects.toThrow(/atomic rename failed/);
      renameSpy.mockRestore();

      // 不应有残留 .tmp.* 文件
      const files = await fs.readdir(dir);
      expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
    });
  });

  describe('debounce', () => {
    it('多次 set 在 debounceMs 内合并为一次写', async () => {
      const store = new JsonStore<SampleData>(filePath, 50);
      store.set({ version: 1, counter: 1, items: [] });
      store.set({ version: 1, counter: 2, items: [] });
      store.set({ version: 1, counter: 3, items: [] });

      // 立即读应该没东西
      await expect(fs.access(filePath)).rejects.toThrow();

      // 等 debounce 触发
      await new Promise((r) => setTimeout(r, 80));
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(data.counter).toBe(3);
    });

    it('flush 立即落盘,不等 debounce', async () => {
      const store = new JsonStore<SampleData>(filePath, 5000);
      store.set({ version: 1, counter: 42, items: [] });
      await store.flush();
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(data.counter).toBe(42);
    });

    it('destroy 后清掉 timer 不再写盘', async () => {
      const store = new JsonStore<SampleData>(filePath, 50);
      store.set({ version: 1, counter: 1, items: [] });
      store.destroy();
      await new Promise((r) => setTimeout(r, 80));
      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });

  describe('并发与串行化', () => {
    it('flush 串行化:连续多次 set + flush 不丢更新', async () => {
      const store = new JsonStore<SampleData>(filePath, 0);
      // 同步连续 set 多次,用 flush 等
      const promises: Promise<void>[] = [];
      for (let i = 1; i <= 5; i++) {
        store.set({ version: 1, counter: i, items: [] });
        promises.push(store.flush());
      }
      await Promise.all(promises);
      const final = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(final.counter).toBe(5);
    });

    it('flush 期间又 set 新值,会接着写新值 (不丢更新)', async () => {
      const store = new JsonStore<SampleData>(filePath, 0);
      store.set({ version: 1, counter: 1, items: [] });
      const flushPromise = store.flush();
      // flush 进行中,再 set
      store.set({ version: 1, counter: 999, items: [] });
      await flushPromise;
      // 等可能的内部递归 flush
      await store.flush();
      const final = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(final.counter).toBe(999);
    });
  });

  describe('getInMemory', () => {
    it('load 之前为 null', () => {
      const store = new JsonStore<SampleData>(filePath);
      expect(store.getInMemory()).toBeNull();
    });

    it('load 之后返回最新值', async () => {
      const data: SampleData = { version: 1, counter: 7, items: ['a'] };
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
      const store = new JsonStore<SampleData>(filePath);
      await store.load(DEFAULT);
      expect(store.getInMemory()).toEqual(data);
    });

    it('set 之后立刻反映新值,不必等 debounce', () => {
      const store = new JsonStore<SampleData>(filePath, 5000);
      const next: SampleData = { version: 1, counter: 100, items: [] };
      store.set(next);
      expect(store.getInMemory()).toEqual(next);
    });
  });

  describe('数据目录嵌套', () => {
    it('父目录不存在时自动 mkdir -p', async () => {
      const nestedPath = join(dir, 'nested', 'deeper', 'file.json');
      const store = new JsonStore<SampleData>(nestedPath, 0);
      store.set({ version: 1, counter: 1, items: [] });
      await store.flush();
      const data = JSON.parse(await fs.readFile(nestedPath, 'utf8'));
      expect(data.counter).toBe(1);
    });
  });
});

describe('createTempDataDir / removeTempDataDir', () => {
  it('创建可写的临时目录,后续删除', async () => {
    const dir = await createTempDataDir('test-helper-');
    await fs.writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
    await removeTempDataDir(dir);
    await expect(fs.access(dir)).rejects.toThrow();
  });
});
