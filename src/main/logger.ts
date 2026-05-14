/**
 * @file src/main/logger.ts
 * @purpose 主进程持久化日志 (M1-D) — 无新依赖,纯 Node fs。
 *
 *   写入 `%APPDATA%/Marina/logs/main-YYYY-MM-DD.log`,按日切;同时镜像到
 *   console (dev / 启动期诊断)。
 *
 *   尊重 settings.advanced.logLevel:
 *   - 'INFO' (默认):info / warn / error 落盘
 *   - 'DEBUG':debug / info / warn / error 全落盘
 *
 *   日志线程通过 `fs.createWriteStream({ flags: 'a' })` 单实例追加;
 *   `flush` 等所有 pending 写完(退出前调)。
 *
 *   超过 5MB 强制按日内序号切;保留最近 7 天文件,启动时清理。
 *
 *   AGENTS.md 9.1:测试**不许**用真实数据目录 — 暴露 `_resetForTest()` 让单测
 *   注入 tmp 目录;在 setLogDir 之前所有调用先缓存到内存,setLogDir 后 flush。
 */
import { promises as fs, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface PendingEntry {
  level: Level;
  module: string;
  message: string;
  ts: number;
  extra: unknown[];
}

let logDir: string | null = null;
let minLevel: Level = 'info';
let stream: WriteStream | null = null;
let currentDate = '';
let currentSerial = 0;
let writtenBytes = 0;
const LOG_FILE_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB
const LOG_FILE_KEEP_DAYS = 7;

// setLogDir 之前的日志先存内存,绑定后 flush(避免启动期日志丢失)
const pending: PendingEntry[] = [];
const PENDING_LIMIT = 500;

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fileName(date: string, serial: number): string {
  return serial === 0 ? `main-${date}.log` : `main-${date}.${serial}.log`;
}

async function ensureStream(): Promise<void> {
  if (!logDir) return;
  const date = todayStr();
  if (date !== currentDate) {
    stream?.end();
    stream = null;
    currentDate = date;
    currentSerial = 0;
    writtenBytes = 0;
  }
  if (writtenBytes >= LOG_FILE_SIZE_LIMIT && stream) {
    stream.end();
    stream = null;
    currentSerial += 1;
    writtenBytes = 0;
  }
  if (!stream) {
    try {
      await fs.mkdir(logDir, { recursive: true });
    } catch {
      /* ignore */
    }
    const fp = join(logDir, fileName(date, currentSerial));
    try {
      const stat = await fs.stat(fp);
      writtenBytes = stat.size;
    } catch {
      writtenBytes = 0;
    }
    stream = createWriteStream(fp, { flags: 'a', encoding: 'utf8' });
  }
}

function format(entry: PendingEntry): string {
  const iso = new Date(entry.ts).toISOString();
  const head = `${iso} [${entry.level.toUpperCase()}] [${entry.module}] ${entry.message}`;
  if (entry.extra.length === 0) return head + '\n';
  // 简化 extra 序列化:Error → stack;对象 → JSON
  const parts = entry.extra.map((x) => {
    if (x instanceof Error) {
      return `${x.name}: ${x.message}\n${x.stack ?? ''}`;
    }
    if (typeof x === 'object' && x !== null) {
      try {
        return JSON.stringify(x);
      } catch {
        return String(x);
      }
    }
    return String(x);
  });
  return `${head} ${parts.join(' ')}\n`;
}

async function write(entry: PendingEntry): Promise<void> {
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[minLevel]) return;
  // console 镜像(始终,因为 dev / 启动期诊断需要)
  const text = format(entry).trimEnd();
  const consoleLog =
    entry.level === 'error'
      ? console.error
      : entry.level === 'warn'
        ? console.warn
        : console.log;
  consoleLog(text);

  if (!logDir) {
    if (pending.length < PENDING_LIMIT) pending.push(entry);
    return;
  }
  await ensureStream();
  if (!stream) return;
  const line = format(entry);
  stream.write(line);
  writtenBytes += Buffer.byteLength(line, 'utf8');
}

function log(level: Level, module: string, message: string, ...extra: unknown[]): void {
  // RES-2:write 内部 await ensureStream() 可能因 fs.mkdir 失败抛错
  // (磁盘满 / 权限 / 路径过长)。原先 `void write(...)` 会把 rejected
  // Promise 抛丢,故障静默。这里捕获并直接 console.error,至少 dev /
  // 启动期能看到一条诊断信息。
  void write({ level, module, message, ts: Date.now(), extra }).catch((err) => {
    try {
      console.error('[logger] write failed:', err);
    } catch {
      /* ignore — console 也坏了就只能放弃 */
    }
  });
}

export const logger = {
  debug: (module: string, message: string, ...extra: unknown[]): void =>
    log('debug', module, message, ...extra),
  info: (module: string, message: string, ...extra: unknown[]): void =>
    log('info', module, message, ...extra),
  warn: (module: string, message: string, ...extra: unknown[]): void =>
    log('warn', module, message, ...extra),
  error: (module: string, message: string, ...extra: unknown[]): void =>
    log('error', module, message, ...extra),

  /** 绑定日志目录;调用之前的日志会缓存到内存,绑定后批量 flush。 */
  async setLogDir(dir: string): Promise<void> {
    logDir = dir;
    await ensureStream();
    // flush pending
    const flushed = pending.splice(0, pending.length);
    for (const e of flushed) {
      if (LEVEL_ORDER[e.level] < LEVEL_ORDER[minLevel]) continue;
      const line = format(e);
      stream?.write(line);
      writtenBytes += Buffer.byteLength(line, 'utf8');
    }
    // 启动时清理 > LOG_FILE_KEEP_DAYS 的旧文件(best effort)
    void this.purgeOld().catch(() => {});
  },

  setLevel(level: Level): void {
    minLevel = level;
  },

  async flush(): Promise<void> {
    if (!stream) return;
    // RES-1:setImmediate 只是让出一个事件循环 tick,与 fs flush 无关 —
    // WriteStream 内部 buffer 可能还有几行未落盘。这里写一个空字符串并
    // 等 write 的 callback,callback 在 buffer flush 到 OS 后触发。
    // 不 end() stream(否则下次写需要重建)。错误吞掉:flush 在 quit
    // 路径调用,即便落盘失败也不能阻塞退出。
    const s = stream;
    await new Promise<void>((resolve) => {
      try {
        s.write('', () => resolve());
      } catch {
        resolve();
      }
    });
  },

  async purgeOld(): Promise<void> {
    if (!logDir) return;
    const cutoff = Date.now() - LOG_FILE_KEEP_DAYS * 24 * 3600 * 1000;
    try {
      const entries = await fs.readdir(logDir);
      for (const name of entries) {
        if (!name.startsWith('main-') || !name.endsWith('.log')) continue;
        const fp = join(logDir, name);
        try {
          const st = await fs.stat(fp);
          if (st.mtimeMs < cutoff) {
            await fs.unlink(fp);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* logDir 不存在等 */
    }
  },

  _resetForTest(): void {
    stream?.end();
    stream = null;
    logDir = null;
    minLevel = 'info';
    currentDate = '';
    currentSerial = 0;
    writtenBytes = 0;
    pending.length = 0;
  },
};
