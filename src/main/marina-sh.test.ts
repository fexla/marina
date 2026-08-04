/**
 * @file src/main/marina-sh.test.ts
 * @purpose 契约测试:跑真实 src/skills/show-in-marina/marina.sh(POSIX 客户端,
 *   bash + curl),对内存 mock 的 file-panel 服务,断言端到端行为(ping /
 *   workspace / show / run / close / list / screenshot 的退出码、stdout、
 *   请求体)。这是 marina.ps1(由 marina-cli.test.ts 覆盖)在 Linux / macOS 上
 *   的对等客户端 —— 两者实现同一 HTTP 契约(file-panel-service.ts),所以这里
 *   复用同一个 Python mock server(marina-cli-mock-server.py)。
 *
 * @被测对象: marina.sh。用真实文件而非内联代码,是为了覆盖 shebang、可执行位
 *   兜底(`exec bash marina.sh`)、curl 调用、awk JSON 解析这些只在整文件运行时
 *   才走到的路径。marina.sh 是零依赖纯 POSIX(无 jq / python / node),所以测试
 *   只需要 bash(被测)+ python(mock server 宿主),任一缺失整组 skip。
 *
 * @为什么 mock server 还是 Python(而不是 node http):与 marina-cli.test.ts 同一
 *   原因 —— Windows Defender 静默丢弃对 node.exe 临时端口的入站连接,而
 *   bash/curl <-> Python 在 127.0.0.1 稳定。这不影响生产(真 Marina 由 electron
 *   起,已被防火墙放行),也不影响被测的 marina.sh(它只认 HTTP,不关心服务端
 *   语言)。
 *
 * @平台: 全平台可跑。Windows 上用 Git Bash 跑 marina.sh(curl 是原生 Windows
 *   二进制);Linux / macOS 上用系统 bash + curl。这组测试刻意不依赖
 *   powershell.exe,所以它在 Linux CI 上也能覆盖 marina.sh。
 *
 * @对应:
 *   src/skills/show-in-marina/marina.sh        (被测 POSIX 客户端)
 *   src/skills/show-in-marina/marina           (调度器;本测试不直接覆盖,但它的
 *                                               Linux 分支 exec 的就是这个 sh)
 *   src/main/marina-cli-mock-server.py          (契约 mock fixture,与 ps1 测试共享)
 *   src/main/marina-cli.test.ts                 (ps1 客户端的等价测试)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SKILL_DIR = resolve(__dirname, '..', 'skills', 'show-in-marina');
// 被测对象:真实的 marina.sh(POSIX 客户端)。
const SH = join(SKILL_DIR, 'marina.sh');
const MOCK_SERVER = resolve(__dirname, 'marina-cli-mock-server.py');
const TOKEN = 'test-token-xyz';
const MARINA_VARS = ['MARINA_SERVICE', 'MARINA_TOKEN', 'TERMINAL_ID', 'MARINA_WORKSPACE'] as const;

/** bash 运行时(被测 marina.sh 的解释器)。试 PATH 上的 bash 与 Git for Windows 常见路径。 */
function findBash(): string | null {
  const candidates = [
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'exit 0'], { stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** curl 运行时(marina.sh 的唯一外部依赖)。bash 同源环境通常自带。 */
function findCurl(bash: string): boolean {
  try {
    const r = spawnSync(bash, ['-c', 'command -v curl >/dev/null 2>&1'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** mock server 宿主:Python(见文件头)。 */
function findPython(): string | null {
  for (const c of ['python', 'py', 'python3']) {
    const r = spawnSync(c, ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  return null;
}

const BASH = findBash();
const PY = findPython();
const HAS_CURL = BASH ? findCurl(BASH) : false;
// 被测需要 bash + curl;mock 需要 python。任一缺失整组 skip(不静默声称覆盖)。
const describeOrSkip = BASH && HAS_CURL && PY ? describe : describe.skip;

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
}

/**
 * 跑真实 marina.sh。显式用 BASH 解释器执行(不依赖文件 +x),"$@" 透传。
 * 超时 15s 兜底:marina.sh 是非交互的,挂起只能是 bug。
 */
function runMarinaSh(
  args: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of MARINA_VARS) delete env[v];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  const child = spawn(BASH as string, [SH, ...args], {
    env,
    cwd: opts.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  return new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolveFn) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveFn({ status: null, stdout, stderr, timedOut: true });
    }, 15000);
    child.on('error', () => {
      clearTimeout(timer);
      resolveFn({ status: null, stdout, stderr, timedOut: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveFn({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

/**
 * 启动 mock server。argv 协议(见 marina-cli-mock-server.py):
 *   argv[1]=port argv[2]=logfile argv[3]=token argv[4]=health_mode argv[5]=list_mode
 * 注意:即使只用 list_mode,也必须先 push health_mode 占位(默认 'marina'),
 * 否则 list_mode 会被错放到 health_mode 槽位。
 */
function startMock(
  healthMode?: string,
  listMode?: string,
): Promise<{ proc: ChildProcess; baseUrl: string; logFile: string }> {
  const logFile = join(tmpdir(), `marina-sh-test-${Date.now()}-${Math.random()}.log`);
  const args = [MOCK_SERVER, '0', logFile, TOKEN];
  if (healthMode || listMode) {
    args.push(healthMode ?? 'marina');
    if (listMode) args.push(listMode);
  }
  const proc = spawn(PY as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(
      () => rejectFn(new Error('mock Marina server did not start within 5s')),
      5000,
    );
    proc.stdout?.on('data', (d: Buffer) => {
      const m = d.toString().match(/listening (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolveFn({ proc, baseUrl: `http://127.0.0.1:${m[1]}`, logFile });
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      rejectFn(e);
    });
  });
}

function readRequests(logFile: string): RecordedRequest[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecordedRequest);
}

/**
 * Convert an OS path into one the bash interpreter can hand to marina.sh.
 * On Windows, mkdtempSync/mkdtemp give `C:\...` paths that bash's POSIX-only
 * resolve_abs / [ -f ] treat as relative; cygpath -u maps them to `/c/...`.
 * On real Linux/macOS there is no cygpath and paths are already POSIX, so the
 * helper is a no-op there. (marina.sh itself is correct on Linux; this only
 * bridges the Windows Git-Bash test host.)
 */
function toBashPath(p: string): string {
  if (!BASH) return p;
  try {
    const r = spawnSync(BASH, ['-c', `cygpath -u "$1"`, '--', p], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    // cygpath only exists on a Git-Bash/MSYS host; on a real POSIX box it is
    // absent (exit !=0) and we return the path unchanged.
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    /* fall through */
  }
  return p;
}

describeOrSkip('marina.sh POSIX client (requires bash + curl + Python mock)', () => {
  let mock: { proc: ChildProcess; baseUrl: string; logFile: string };
  let workspace: string; // bash-friendly POSIX path (cygpath-converted on Windows)
  let workspaceOs: string; // original OS path (for Node fs writes)

  beforeEach(async () => {
    workspaceOs = mkdtempSync(join(tmpdir(), 'marina-sh-test-'));
    workspace = toBashPath(workspaceOs);
    mock = await startMock();
  });

  afterEach(async () => {
    try {
      mock.proc.kill();
      await new Promise<void>((r) => mock.proc.on('exit', () => r()));
    } catch {
      /* best effort */
    }
    rmSync(workspaceOs, { recursive: true, force: true });
    try {
      rmSync(mock.logFile, { force: true });
    } catch {
      /* best effort */
    }
  });

  // ── ping:严格健康标记 ────────────────────────────────────────
  it('ping: online only when /health returns the exact Marina marker', async () => {
    const r = await runMarinaSh(['ping'], { env: { MARINA_SERVICE: mock.baseUrl } });
    expect(r.timedOut).toBe(false);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe('marina: online');
  });

  it('ping: offline (exit 1) when service unreachable (dead port)', async () => {
    const r = await runMarinaSh(['ping'], { env: { MARINA_SERVICE: 'http://127.0.0.1:1' } });
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain('offline');
  });

  it('ping: offline when MARINA_SERVICE unset (not in a Marina terminal)', async () => {
    const r = await runMarinaSh(['ping']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not in a Marina terminal');
  });

  it('ping: rejects marker look-alike {"ok":"true","marina":"true"} (string, not bool)', async () => {
    const bad = await startMock('wrong_marker');
    try {
      const r = await runMarinaSh(['ping'], { env: { MARINA_SERVICE: bad.baseUrl } });
      expect(r.status).toBe(1);
      expect(r.stderr.toLowerCase()).toContain('offline');
    } finally {
      bad.proc.kill();
    }
  });

  it('ping: rejects unrelated JSON 200 (no marina key)', async () => {
    const bad = await startMock('unrelated');
    try {
      const r = await runMarinaSh(['ping'], { env: { MARINA_SERVICE: bad.baseUrl } });
      expect(r.status).toBe(1);
      expect(r.stderr.toLowerCase()).toContain('offline');
    } finally {
      bad.proc.kill();
    }
  });

  it('ping: rejects HTTP 500 (Marina answered but not healthy)', async () => {
    const bad = await startMock('status_500');
    try {
      const r = await runMarinaSh(['ping'], { env: { MARINA_SERVICE: bad.baseUrl } });
      expect(r.status).toBe(1);
      expect(r.stderr.toLowerCase()).toContain('offline');
    } finally {
      bad.proc.kill();
    }
  });

  // ── workspace ─────────────────────────────────────────────────
  it('workspace: prints the bound workspace absolute path', async () => {
    const r = await runMarinaSh(['workspace'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toMatch(/workspace[\\/]current$/);
  });

  it('workspace: missing SERVICE/TOKEN/TERMINAL_ID -> exit 1 (no $env fallback)', async () => {
    const r = await runMarinaSh(['workspace'], { env: { MARINA_WORKSPACE: '/stale' } });
    expect(r.status).toBe(1);
  });

  it('workspace list: lists named workspaces', async () => {
    const r = await runMarinaSh(['workspace', 'list'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('feat-x');
    expect(r.stdout).toContain('pinned');
  });

  it('workspace list --json: machine-readable JSON', async () => {
    const r = await runMarinaSh(['workspace', 'list', '--json'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // marina.sh --json passes the raw server body through (richer than ps1's
    // items-only re-serialization); normalize to find the named item.
    const items = parsed.items ?? parsed;
    const arr = Array.isArray(items) ? items : [items];
    expect(arr[0].name).toBe('feat-x');
  });

  it('workspace bind --name X (new) -> created', async () => {
    const r = await runMarinaSh(['workspace', 'bind', '--name', 'fresh'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Named current');
  });

  it('workspace bind --name X (existing) -> switched', async () => {
    const r = await runMarinaSh(['workspace', 'bind', '--name', 'feat-x'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Switched to existing');
  });

  it('workspace bind --name X --new (existing) -> exit 3 (NameConflict 409)', async () => {
    const r = await runMarinaSh(['workspace', 'bind', '--name', 'feat-x', '--new'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('409');
  });

  it('workspace bind without --name -> exit 2', async () => {
    const r = await runMarinaSh(['workspace', 'bind'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--name');
  });

  it('workspace new -> switches to a fresh workspace', async () => {
    const r = await runMarinaSh(['workspace', 'new'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('fresh');
  });

  it('workspace unpin -> strips name+pinned', async () => {
    const r = await runMarinaSh(['workspace', 'unpin'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Unpinned');
  });

  it('workspace unknown subcommand -> exit 2', async () => {
    const r = await runMarinaSh(['workspace', 'bogus'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
  });

  // ── show ──────────────────────────────────────────────────────
  it('show: existing file -> exit 0 + POST /open-file with absolute path + terminal', async () => {
    const f = join(workspaceOs, 'report.md');
    writeFileSync(f, '# real report');
    const r = await runMarinaSh(['show', toBashPath(f)], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const openReq = readRequests(mock.logFile).find((x) => x.path === '/open-file');
    expect(openReq).toBeDefined();
    expect(openReq!.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(openReq!.body)).toMatchObject({ terminal: 't1' });
    expect(JSON.parse(openReq!.body).path.replace(/\\/g, '/')).toMatch(/report\.md$/);
    expect(r.stdout).toContain('shown:');
  });

  it('show: nonexistent file -> exit 3 (rejected)', async () => {
    const r = await runMarinaSh(['show', toBashPath(join(workspaceOs, 'nope.md'))], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('not a file');
  });

  it('show: no path -> exit 2 (NO stdin/staging mode)', async () => {
    const r = await runMarinaSh(['show'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PATH');
  });

  it('show: --quiet suppresses the success line', async () => {
    const f = join(workspaceOs, 'q.md');
    writeFileSync(f, 'x');
    const r = await runMarinaSh(['show', '--quiet', toBashPath(f)], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('show: unknown option -> exit 2 (not silently swallowed)', async () => {
    const f = join(workspaceOs, 'x.md');
    writeFileSync(f, 'x');
    const r = await runMarinaSh(['show', '--bogus', toBashPath(f)], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown option');
  });

  // ── run ───────────────────────────────────────────────────────
  it('run: posts /run with the joined command + terminal', async () => {
    const r = await runMarinaSh(['run', 'gh issue list'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const runReq = readRequests(mock.logFile).find((x) => x.path === '/run');
    expect(runReq).toBeDefined();
    expect(JSON.parse(runReq!.body)).toMatchObject({ terminal: 't1', command: 'gh issue list' });
    expect(r.stdout).toContain('ran:');
  });

  it('run: --title sets the tab title; multiple args are joined', async () => {
    const r = await runMarinaSh(['run', '--title', 'issues', 'gh', 'issue', 'list'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    const runReq = readRequests(mock.logFile)
      .filter((x) => x.path === '/run')
      .pop();
    expect(JSON.parse(runReq!.body)).toMatchObject({
      command: 'gh issue list',
      title: 'issues',
    });
  });

  it('run: no command -> exit 2', async () => {
    const r = await runMarinaSh(['run'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
  });

  // ── close / list ──────────────────────────────────────────────
  it('close: POSTs /close-file with bearer + terminal', async () => {
    const f = join(workspaceOs, 'a.md');
    writeFileSync(f, 'x');
    const r = await runMarinaSh(['close', toBashPath(f)], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't9' },
    });
    expect(r.status).toBe(0);
    const closeReq = readRequests(mock.logFile).find((x) => x.path === '/close-file');
    expect(closeReq!.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(closeReq!.body)).toMatchObject({ terminal: 't9' });
  });

  it('list --json: prints JSON from Marina', async () => {
    const r = await runMarinaSh(['list', '--json'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).files).toBeDefined();
  });

  it('list: human mode shows "(no files open)" on empty', async () => {
    const r = await runMarinaSh(['list'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no files open');
  });

  // ── list 僵尸标记 + close 批量(用 mixed fixture mock)─────────
  it('list marks deleted (zombie) tabs with ! and (deleted)', async () => {
    const mixed = await startMock(undefined, 'mixed');
    try {
      const r = await runMarinaSh(['list'], {
        env: { MARINA_SERVICE: mixed.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('gone.md');
      expect(r.stdout).toContain('!');
      expect(r.stdout).toContain('(deleted)');
      expect(r.stdout).toContain('close --stale');
      const aLine = r.stdout.split(/\r?\n/).find((l) => l.includes('a.md'))!;
      expect(aLine).not.toContain('(deleted)');
    } finally {
      mixed.proc.kill();
    }
  });

  it('close --all POSTs /close-files mode=all and reports count', async () => {
    const mixed = await startMock(undefined, 'mixed');
    try {
      const r = await runMarinaSh(['close', '--all'], {
        env: { MARINA_SERVICE: mixed.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't2' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      const req = readRequests(mixed.logFile).find((x) => x.path === '/close-files');
      expect(req).toBeDefined();
      expect(JSON.parse(req!.body)).toMatchObject({ terminal: 't2', mode: 'all' });
      expect(r.stdout).toContain('closed 2 file(s)');
    } finally {
      mixed.proc.kill();
    }
  });

  it('close --stale POSTs /close-files mode=stale (only the missing one)', async () => {
    const mixed = await startMock(undefined, 'mixed');
    try {
      const r = await runMarinaSh(['close', '--stale'], {
        env: { MARINA_SERVICE: mixed.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't3' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      const req = readRequests(mixed.logFile).find((x) => x.path === '/close-files');
      expect(JSON.parse(req!.body)).toMatchObject({ mode: 'stale' });
      expect(r.stdout).toContain('closed 1 file(s)');
      expect(r.stdout).toContain('gone.md');
    } finally {
      mixed.proc.kill();
    }
  });

  it('close --glob PATTERN POSTs /close-files mode=glob + pattern', async () => {
    // Use a literal non-matching pattern so the host shell cannot glob-expand
    // `*` before marina.sh sees it (a test-harness concern on Windows; on real
    // Linux the agent's quoting controls this). Proves arg parsing + body shape.
    const mixed = await startMock(undefined, 'mixed');
    try {
      const r = await runMarinaSh(['close', '--glob', 'ZZNOMATCH.md'], {
        env: { MARINA_SERVICE: mixed.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't4' },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      const req = readRequests(mixed.logFile).find((x) => x.path === '/close-files');
      expect(JSON.parse(req!.body)).toMatchObject({ mode: 'glob', pattern: 'ZZNOMATCH.md' });
    } finally {
      mixed.proc.kill();
    }
  });

  it('close --all --stale are mutually exclusive (exit 2)', async () => {
    const r = await runMarinaSh(['close', '--all', '--stale'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't6' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('mutually exclusive');
  });

  it('close --glob without pattern (exit 2)', async () => {
    const r = await runMarinaSh(['close', '--glob'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PATTERN');
  });

  // ── screenshot (T12) ──────────────────────────────────────────
  it('screenshot: explicit path saves the PNG + prints the path', async () => {
    const out = join(workspaceOs, 'shot.png');
    if (existsSync(out)) rmSync(out);
    const r = await runMarinaSh(['screenshot', toBashPath(out)], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(out)).toBe(true);
    const expected = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000d49444154789c63000100000005000100',
      'hex',
    );
    expect(readFileSync(out).equals(expected)).toBe(true);
  });

  it('screenshot: default path lands under the managed workspace', async () => {
    const r = await runMarinaSh(['screenshot'], {
      env: {
        MARINA_SERVICE: mock.baseUrl,
        MARINA_TOKEN: TOKEN,
        TERMINAL_ID: 't1',
        MARINA_WORKSPACE: workspace,
      },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const printed = r.stdout.trim();
    expect(printed).toContain('marina-screenshot-');
    expect(printed.endsWith('.png')).toBe(true);
    // `printed` is a bash-POSIX path (e.g. /c/Users/...). Node's fs (native
    // Windows) can't see it, so re-derive the OS path via the workspace +
    // basename (basename is identical across path styles).
    const osPath = join(workspaceOs, printed.replace(/\\/g, '/').split('/').pop()!);
    expect(existsSync(osPath)).toBe(true);
  });

  it('screenshot: missing TERMINAL_ID -> exit 1 (offline)', async () => {
    const r = await runMarinaSh(['screenshot'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TERMINAL');
  });

  // ── CLI 结构 / env 严格性 ─────────────────────────────────────
  it('--help: exit 0 and lists subcommands', async () => {
    const r = await runMarinaSh(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ping|show|close|list/);
  });

  it('no subcommand -> exit 2 (usage error)', async () => {
    const r = await runMarinaSh([]);
    expect(r.status).toBe(2);
  });

  it('unknown command -> exit 2', async () => {
    const r = await runMarinaSh(['bogus'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown command');
  });

  it('missing MARINA_TOKEN on show -> exit 1 (offline)', async () => {
    const f = join(workspaceOs, 'x.md');
    writeFileSync(f, 'x');
    const r = await runMarinaSh(['show', toBashPath(f)], {
      env: { MARINA_SERVICE: mock.baseUrl, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MARINA_TOKEN');
  });

  it('missing TERMINAL_ID on show -> exit 1 (offline)', async () => {
    const f = join(workspaceOs, 'x.md');
    writeFileSync(f, 'x');
    const r = await runMarinaSh(['show', toBashPath(f)], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TERMINAL_ID');
  });

  // ── dispatcher 契约(可选,只在 bash 可用时)─────────────────
  // 验证 `marina`(无扩展名调度器)在「无 powershell.exe」时 exec 到 marina.sh。
  // 这个路由只在 Linux / macOS 上能干净地测:Windows 上 powershell.exe 总
  // 在(调度器正确地走 ps1 分支),且剥离 PATH 会让 Node 连 bash 都 spawn
  // 不了(ENOENT)。所以本用例只在非 Windows 平台跑;Windows 上的调度器
  // 「走 ps1」分支已由 marina-cli.test.ts 充分覆盖。
  const itIfPosix = process.platform === 'win32' ? it.skip : it;
  itIfPosix('dispatcher `marina` routes to marina.sh when powershell.exe is absent', async () => {
    const dispatcher = join(SKILL_DIR, 'marina');
    // 构造一个不含 powershell.exe 的最小 PATH,并确保 System32 兜底路径也不可达。
    const strippedEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const v of MARINA_VARS) delete strippedEnv[v];
    strippedEnv.MARINA_SERVICE = mock.baseUrl;
    strippedEnv.PATH = '/usr/bin:/bin';
    const child = spawn(BASH as string, [dispatcher, 'ping'], {
      env: strippedEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolveFn) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolveFn({ status: null, stdout, stderr });
        }, 15000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolveFn({ status: code, stdout, stderr });
        });
      },
    );
    // 关键断言:走 sh 分支并对真实(模拟)的 /health 返回 online(exit 0)。
    // 若误走到 powershell.exe 分支,在 stripped PATH 下会 127。
    expect(res.status, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
    expect(res.stdout.trim()).toBe('marina: online');
  }, 20000);
});
