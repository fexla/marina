/**
 * @file src/main/marina-cli.test.ts
 * @purpose 集成测试:跑真实 src/skills/show-in-marina/marina.cmd(Windows
 *   启动器壳)→ marina.ps1,断言端到端行为(ping/show/close/list 退出码、
 *   env 严格性、健康标记严格匹配、相对路径启动器调用、退出码穿透)。
 *
 * @被测对象: marina.cmd 启动器 + 它调用的 marina.ps1。用真实 .cmd 而非
 *   直接调 .ps1,是为了覆盖启动器本身的退出码穿透(`endlocal & exit /b
 *   %errorlevel%`)和 %~dp0 解析 marina.ps1 的契约。Marina 面向 Windows
 *   用户,PowerShell 是系统自带运行时,skill 不依赖外部 python。
 *
 * @mock server 为什么还是 Python(marina-cli-mock-server.py):
 *   Windows Defender 静默丢弃对 node.exe 临时监听端口的入站连接 —— 任何
 *   客户端连 node mock server 都会 timeout。但 PowerShell<->Python 在
 *   127.0.0.1 稳定(已 spike 验证)。所以 mock server 用 Python,被测
 *   客户端是 PowerShell(marina.cmd→marina.ps1)。这不影响生产(真 Marina
 *   由 electron 起,已被防火墙放行)。测试需要机器同时有 powershell
 *   (被测)和 python(mock server),任一缺失则整个 describe skip(不
 *   静默声称覆盖了启动器 —— skip 就是 skip)。
 *
 * @设计要点(被测):
 *   - 路径模式唯一:无 stdin、无 --as(PS 5.1 管道会损坏非 ASCII 字节)。
 *   - ping 严格:GET /health 必须返回 HTTP 200 且 body 恰为
 *     {"ok":true,"marina":true}(两个都是 [bool])。任何其它响应(404/
 *     500/字符串值/缺 marina 键/无关 JSON)一律判离线,无遗留宽松回退。
 *   - env 严格:MARINA_SERVICE/TOKEN/TERMINAL_ID 缺一即 exit 1,不端口
 *     扫描、不地址回退、不改 PATH。
 *
 * @对应: src/skills/show-in-marina/marina.cmd(被测启动器)
 *          src/skills/show-in-marina/marina.ps1(被测真身)
 *          src/main/marina-cli-mock-server.py(mock server)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SKILL_DIR = resolve(__dirname, '..', 'skills', 'show-in-marina');
// 被测对象是真实的 marina.cmd 启动器(不是 marina.ps1 本身)。这样退出码
// 穿透(`endlocal & exit /b %errorlevel%`)和 %~dp0 解析都被覆盖。
const CMD = join(SKILL_DIR, 'marina.cmd');
// bash / Git Bash 封装(同目录、无扩展名)。它 exec powershell.exe -File
// marina.ps1，退出码由 exec 直接透传。被测是为了覆盖:
// (1) MSYS 下 cmd /c 的 /c->C:/ 陷阱确实被绕过(不会 exit 0 误判);
// (2) BASH_SOURCE 定位同目录 marina.ps1 正确;
// (3) "$@" 能把含空格的路径完整传到 ps1。
const BASH_WRAPPER = join(SKILL_DIR, 'marina');
const MOCK_SERVER = resolve(__dirname, 'marina-cli-mock-server.py');
const TOKEN = 'test-token-xyz';
// 含 MARINA_WORKSPACE 是为了在测单个用例时把它从环境里清掉 (防止开发机
// 残留干扰被测 CLI 的 env 严格性证据)。注意：该变量本身仍然存在，是
// Marina 为每个 session 注入的临时展示目录 (见 session-workspace-manager.ts)，
// 是 AI 写展示文档的推荐位置 (见 SKILL.md)。它只是不被 marina.ps1 本身读取 ——
// CLI 只读 MARINA_SERVICE/TOKEN/TERMINAL_ID 做鉴权与路由。这里从 env 清掉它，
// 是为了证明“CLI 不依赖 MARINA_WORKSPACE 就能工作”，而不是说它被废弃了。
const MARINA_VARS = ['MARINA_SERVICE', 'MARINA_TOKEN', 'TERMINAL_ID', 'MARINA_WORKSPACE'] as const;

/**
 * 被测 CLI 的运行时:PowerShell。Windows 自带 powershell.exe(System32,
 * 总在 PATH)。非 Windows 机器一般没有 → 返回 null → 整组 skip(本 skill
 * 本来就是 Windows PowerShell 专用)。
 */
function findPowerShell(): string | null {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
    stdio: 'ignore',
  });
  return r.status === 0 ? 'powershell.exe' : null;
}

/**
 * mock server 的运行时:Python(node mock server 被 Defender 拦,见文件头)。
 * 找不到则整组 skip —— 但被测 CLI 本身不依赖 python,这只是测试夹具需要。
 */
function findPython(): string | null {
  for (const candidate of ['python', 'py', 'python3']) {
    const r = spawnSync(candidate, ['-c', 'import sys; sys.exit(0)'], {
      stdio: 'ignore',
    });
    if (r.status === 0) return candidate;
  }
  return null;
}

/**
 * bash 封装脚本的运行时:bash。在 Windows 上常见于 Git Bash / MSYS2
 * (随 Git for Windows 安装)。非 Windows 或未装 Git Bash 的 CI 上可能没有
 * → 返回 null → bash 封装那组 describe skip(不静默声称覆盖了 bash 封装)。
 *
 * 依次试 `bash`(在 PATH 上)与 Git for Windows 的常见路径 bash.exe。任一能
 * `bash -c 'exit 0'` 返回 0 即认为可用。
 */
function findBash(): string | null {
  const candidates = [
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const candidate of candidates) {
    try {
      const r = spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' });
      if (r.status === 0) return candidate;
    } catch {
      // ENOENT 等 —— 试下一个候选。
    }
  }
  return null;
}

const PS = findPowerShell();
const PY = findPython();
const BASH = findBash();
// 需要两者都到位:PS = 被测对象运行时, PY = mock server 宿主。任一缺失
// 即整组 skip —— 不静默声称"启动器覆盖"。
const describeOrSkip = PS && PY ? describe : describe.skip;
// bash 封装那组额外需要 BASH 在场(Git Bash / MSYS)。任一缺失即整组 skip。
const describeBashOrSkip = PS && PY && BASH ? describe : describe.skip;

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
}

/**
 * 跑真实 marina.cmd(绝对路径)。shell:true 让 Node 用 cmd.exe 处理 .cmd
 * 扩展名;windowsHide 避免每次弹窗。退出码由启动器的
 * `endlocal & exit /b %errorlevel%` 透传到 spawnSync.status。
 */
function runMarina(
  args: string[],
  opts: { env?: Record<string, string | undefined>; input?: string; cwd?: string } = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of MARINA_VARS) delete env[v];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return spawnSync(CMD, args, {
    env,
    input: opts.input,
    cwd: opts.cwd,
    encoding: 'utf-8',
    shell: true,
    windowsHide: true,
    stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 跑真实的 bash 封装脚本 marina(同目录、无扩展名)。显式用 BASH 解释器执行
 * (BASH_WRAPPER 路径作为脚本传给 bash)，这样不依赖文件是否有 +x。spawnSync
 * 本身是同步阻塞调用，但万一封装脚本因 bug 挂起(例如未来改错意外把 exec
 * 换成交互式调用)，会让整个测试套静止。因此用 spawn 异步 + timeout 包裹，
 * 超时则 kill 并返回一个明确的 error.status=null，断言失败信息可读。这与
 * runMarina (cmd.exe 启动器)不同 —— cmd 启动器已被项目历史上充分验证不会
 * 挂起，bash 封装是新代码，需要这个安全网。
 */
function runMarinaBash(
  args: string[],
  opts: { env?: Record<string, string | undefined>; cwd?: string } = {},
  timeoutMs = 10000,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
}> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of MARINA_VARS) delete env[v];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  const child = spawn(BASH as string, [BASH_WRAPPER, ...args], {
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
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
    timedOut: boolean;
  }>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: err, timedOut: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

/** 启动 mock server,支持 health_mode 覆盖以测 ping 的标记严格性。 */
function startMock(
  healthMode?: string,
): Promise<{ proc: ChildProcess; baseUrl: string; logFile: string }> {
  const logFile = join(tmpdir(), `marina-cli-test-${Date.now()}-${Math.random()}.log`);
  const args = [MOCK_SERVER, '0', logFile, TOKEN];
  if (healthMode) args.push(healthMode);
  const proc = spawn(PY as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr?.on('data', (d) => {
    // eslint-disable-next-line no-console
    console.warn('[mock-server stderr]', d.toString());
  });
  return new Promise<{ proc: ChildProcess; baseUrl: string; logFile: string }>(
    (resolveFn, rejectFn) => {
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
    },
  );
}

describeOrSkip('marina.cmd launcher + marina.ps1 (requires PowerShell + Python mock)', () => {
  let mock: { proc: ChildProcess; baseUrl: string; logFile: string };
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'marina-cli-test-'));
    mock = await startMock();
  });

  afterEach(async () => {
    try {
      mock.proc.kill();
      await new Promise<void>((r) => mock.proc.on('exit', () => r()));
    } catch {
      /* best effort */
    }
    rmSync(workspace, { recursive: true, force: true });
    try {
      rmSync(mock.logFile, { force: true });
    } catch {
      /* best effort */
    }
  });

  function readRequests(): RecordedRequest[] {
    if (!existsSync(mock.logFile)) return [];
    const content = readFileSync(mock.logFile, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RecordedRequest);
  }

  // ── ping:严格健康标记 ────────────────────────────────────────
  it('ping: online only when /health returns the exact Marina marker', () => {
    const r = runMarina(['ping'], { env: { MARINA_SERVICE: mock.baseUrl } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('marina: online');
  });

  it('ping: offline (exit 1) when service unreachable (dead port)', () => {
    const r = runMarina(['ping'], { env: { MARINA_SERVICE: 'http://127.0.0.1:1' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('offline');
  });

  it('ping: offline when MARINA_SERVICE unset (not in a Marina terminal)', () => {
    const r = runMarina(['ping']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not in a Marina terminal');
  });

  it('ping: rejects marker look-alike {"ok":"true","marina":"true"} (string, not bool)', async () => {
    const bad = await startMock('wrong_marker');
    try {
      const r = runMarina(['ping'], { env: { MARINA_SERVICE: bad.baseUrl } });
      expect(r.status).toBe(1);
      expect(r.stderr.toLowerCase()).toContain('offline');
    } finally {
      bad.proc.kill();
    }
  });

  it('ping: rejects unrelated JSON 200 (no marina key)', async () => {
    const bad = await startMock('unrelated');
    try {
      const r = runMarina(['ping'], { env: { MARINA_SERVICE: bad.baseUrl } });
      expect(r.status).toBe(1);
      expect(r.stderr.toLowerCase()).toContain('offline');
    } finally {
      bad.proc.kill();
    }
  });

  it('ping: rejects HTTP 500 (Marina answered but not healthy)', async () => {
    const bad = await startMock('status_500');
    try {
      const r = runMarina(['ping'], { env: { MARINA_SERVICE: bad.baseUrl } });
      expect(r.status).toBe(1);
      expect(r.stderr.toLowerCase()).toContain('offline');
    } finally {
      bad.proc.kill();
    }
  });

  // ── show:路径模式唯一(无 stdin / 无 --as)────────────────────
  it('show: existing file -> exit 0 + POST /open-file with absolute path + terminal', () => {
    const f = join(workspace, 'report.md');
    writeFileSync(f, '# real report'); // UTF-8 no BOM, via Node fs
    const r = runMarina(['show', f], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const openReq = readRequests().find((x) => x.path === '/open-file');
    expect(openReq).toBeDefined();
    expect(openReq!.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(openReq!.body)).toMatchObject({ terminal: 't1', path: f });
    expect(r.stdout.trim()).toBe(`shown: ${f}`);
  });

  it('show: UTF-8 filename survives end-to-end (the path mode UTF-8 contract)', () => {
    // 路径含中文:cmd.exe→powershell.exe 经 CreateProcessW 传 UTF-16,
    // marina.ps1 把 JSON body 显式 UTF-8 编码后发出。mock server 记录原始
    // body,断言解码回的 path 与原路径字节一致。
    const dir = join(workspace, '中文目录');
    const f = join(dir, '报告.md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, '# 中文内容');
    const r = runMarina(['show', f], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't7' },
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const openReq = readRequests().find((x) => x.path === '/open-file');
    expect(openReq).toBeDefined();
    expect(JSON.parse(openReq!.body)).toMatchObject({ path: f });
  });

  it('show: nonexistent file -> exit 3 (rejected), proven through the launcher', () => {
    // 这个用例同时验证了启动器对子进程 exit 3 的穿透。
    const r = runMarina(['show', join(workspace, 'nope.md')], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('not a file');
  });

  it('show: no path -> exit 2 (NO stdin/staging mode)', () => {
    const r = runMarina(['show'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PATH');
  });

  it('show: stdin piped without a path is NOT consumed as content (stdin mode removed)', () => {
    // 旧行为会把 stdin 当内容写入;新模式完全忽略 stdin,仍要求 PATH。
    const r = runMarina(['show'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
      input: 'this should be ignored',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PATH');
    // 没有 /open-file 被调用 —— stdin 没被当文件内容
    expect(readRequests().some((x) => x.path === '/open-file')).toBe(false);
  });

  it('show: --quiet suppresses the success line', () => {
    const f = join(workspace, 'q.md');
    writeFileSync(f, 'x');
    const r = runMarina(['show', '--quiet', f], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
    const openReq = readRequests().find((x) => x.path === '/open-file');
    expect(JSON.parse(openReq!.body)).toMatchObject({ path: f });
  });

  it('show: unknown option -> exit 2 (not silently swallowed)', () => {
    const f = join(workspace, 'x.md');
    writeFileSync(f, 'x');
    const r = runMarina(['show', '--bogus', f], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown option');
  });

  // ── close / list ──────────────────────────────────────────────
  it('close: POSTs /close-file with bearer + terminal', () => {
    const f = join(workspace, 'a.md');
    const r = runMarina(['close', f], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't9' },
    });
    expect(r.status).toBe(0);
    const closeReq = readRequests().find((x) => x.path === '/close-file');
    expect(closeReq!.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(closeReq!.body)).toMatchObject({ terminal: 't9', path: f });
  });

  it('list --json: prints JSON from Marina', () => {
    const r = runMarina(['list', '--json'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ files: [], activePath: null });
  });

  it('list: human mode shows "(no files open)" on empty', () => {
    const r = runMarina(['list'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no files open');
  });

  // ── CLI 结构 / env 严格性 ─────────────────────────────────────
  it('--help: exit 0 and lists subcommands', () => {
    const r = runMarina(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ping|show|close|list/);
  });

  it('no subcommand -> exit 2 (usage error)', () => {
    const r = runMarina([]);
    expect(r.status).toBe(2);
  });

  it('unknown command -> exit 2', () => {
    const r = runMarina(['bogus'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(2);
  });

  it('missing MARINA_TOKEN on show -> exit 1 (offline, not rejected)', () => {
    const f = join(workspace, 'x.md');
    writeFileSync(f, 'x');
    const r = runMarina(['show', f], {
      env: { MARINA_SERVICE: mock.baseUrl, TERMINAL_ID: 't1' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MARINA_TOKEN');
  });

  it('missing TERMINAL_ID on show -> exit 1 (offline)', () => {
    const f = join(workspace, 'x.md');
    writeFileSync(f, 'x');
    const r = runMarina(['show', f], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TERMINAL_ID');
  });

  // ── 相对路径启动器调用(用户硬约束)──────────────────────────
  it('launcher works when invoked by a relative path from the skill dir', () => {
    // SKILL.md 要求 AI 用"相对 skill 目录的路径"调 marina.cmd。验证:
    // cwd 切到 skill 目录,用 .\marina.cmd 调用,%~dp0 仍正确解析 marina.ps1。
    const r = spawnSync('.\\marina.cmd', ['ping'], {
      env: { ...process.env, MARINA_SERVICE: mock.baseUrl },
      cwd: SKILL_DIR,
      encoding: 'utf-8',
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe('marina: online');
  });
});

// ════════════════════════════════════════════════════════════════════════
// bash 封装脚本 marina(同目录、无扩展名)。它与 marina.cmd 走不同的调用链:
//   bash marina → exec powershell.exe -File marina.ps1
// 被测点不是 marina.ps1 的业务逻辑(那已被上一组覆盖),而是封装脚本的:
//   (1) 退出码透传(exec)
//   (2) BASH_SOURCE 定位同目录 marina.ps1
//   (3) "$@" 能把含空格的路径完整传到 ps1
//   (4) 不会像 cmd /c 那样静默 exit 0(MSYS /c->C:/ 陷阱的反面证据)
// 这一组额外需要 BASH 可用(Git Bash / MSYS);CI 上若没有 bash 则整组 skip。
// ════════════════════════════════════════════════════════════════════════
describeBashOrSkip('marina bash wrapper (requires bash + PowerShell + Python mock)', () => {
  let mock: { proc: ChildProcess; baseUrl: string; logFile: string };
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'marina-bash-test-'));
    mock = await startMock();
  });

  afterEach(async () => {
    try {
      mock.proc.kill();
      await new Promise<void>((r) => mock.proc.on('exit', () => r()));
    } catch {
      /* best effort */
    }
    rmSync(workspace, { recursive: true, force: true });
    try {
      rmSync(mock.logFile, { force: true });
    } catch {
      /* best effort */
    }
  });

  function readRequests(): RecordedRequest[] {
    if (!existsSync(mock.logFile)) return [];
    const content = readFileSync(mock.logFile, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RecordedRequest);
  }

  // ── 退出码透传(最关键)──────────────────────────────────────
  it('ping online -> exit 0 propagates through the bash wrapper', async () => {
    const r = await runMarinaBash(['ping'], { env: { MARINA_SERVICE: mock.baseUrl } });
    // 理论上 0;最坏情况是 exit 1(Marina 离线)。exit 0 = 封装工作正常 + 隐式
    // 证明不是 MSYS /c->C:/ 陷阱(那个会 exit 0但输出交互式 prompt，这里断 stdout)。
    expect(r.timedOut, 'bash wrapper hung — likely an accidental interactive shell').toBe(false);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe('marina: online');
  });

  // ── 错误输入不挂起、退出码为 2 ──────────────────────────────────
  // 这正是 MSYS /c->C:/ 陷阱的反面证据:陷阱下 unknown 命令会启动交互式 cmd
  // 并 exit 0;正确的 bash 封装会 exit 2。
  it('unknown command -> exit 2, does not hang (the cmd /c trap would exit 0)', async () => {
    const r = await runMarinaBash(['bogus'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.timedOut, 'bash wrapper hung on unknown command').toBe(false);
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain('unknown command');
  });

  it('show with no path -> exit 2, does not hang', async () => {
    const r = await runMarinaBash(['show'], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.timedOut, 'bash wrapper hung on missing path').toBe(false);
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain('PATH');
  });

  it('no subcommand -> exit 2, does not hang', async () => {
    const r = await runMarinaBash([], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't1' },
    });
    expect(r.timedOut, 'bash wrapper hung on no command').toBe(false);
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(2);
  });

  // ── 含空格路径完整传递 ────────────────────────────────────────
  // "$@" 必须把 'with spaces/report.md' 作为一个参数交给 powershell -File，
  // 不能被 MSYS 路径转换或词分割拆坏。mock server 记录的 body.path 应与原路径一致。
  it('show forwards a path with spaces to ps1 intact', async () => {
    const dir = join(workspace, 'dir with spaces');
    const f = join(dir, 'report.md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, '# spaced');
    const r = await runMarinaBash(['show', f], {
      env: { MARINA_SERVICE: mock.baseUrl, MARINA_TOKEN: TOKEN, TERMINAL_ID: 't-sp' },
    });
    expect(r.timedOut, 'bash wrapper hung on spaced path').toBe(false);
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    const openReq = readRequests().find((x) => x.path === '/open-file');
    expect(openReq, `no /open-file recorded; stdout=${r.stdout} stderr=${r.stderr}`).toBeDefined();
    expect(JSON.parse(openReq!.body)).toMatchObject({ path: f, terminal: 't-sp' });
  });

  // ── BASH_SOURCE 定位同目录 marina.ps1 ─────────────────────────
  // 从任意 cwd 调用封装，它应该靠 BASH_SOURCE 找到同目录的 ps1，而不依赖 cwd。
  it('wrapper resolves marina.ps1 via BASH_SOURCE regardless of cwd', async () => {
    const r = await runMarinaBash(['ping'], {
      env: { MARINA_SERVICE: mock.baseUrl },
      cwd: tmpdir(),
    });
    expect(r.timedOut, 'bash wrapper hung when cwd != skill dir').toBe(false);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout.trim()).toBe('marina: online');
  });
});
