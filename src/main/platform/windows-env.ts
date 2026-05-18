/**
 * @file src/main/platform/windows-env.ts
 * @purpose Windows 子进程环境变量规整 — BETA-ENV-1 根治。
 *
 * @背景:
 * 用户报告"PowerShell is not available on this system."(Marina 启动 Git Bash
 * 后,Bash 里 `command -v powershell.exe` 找不到,但 `/c/Windows/System32/.../powershell.exe`
 * 实际存在)。复现 + 抓 env 后定位到两个独立但叠加的 bug:
 *
 *   Bug 1: WindowsAdapter.getRefreshedPath 从注册表读 PATH 时,REG_EXPAND_SZ
 *          类型的值里含 `%SystemRoot%\System32` 字面占位符,未做展开就塞进
 *          子进程 env。
 *
 *   Bug 2: 子进程 env 块里 `SystemRoot` 这个 canonical 大小写的 key 是空串(只
 *          有 `SYSTEMROOT=C:\Windows`)。Win32 API 内部展开 `%SystemRoot%` 按
 *          进程环境块的字面 key 名查 — 而进程环境块在 API 层大小写敏感 — 找
 *          不到就替换成空,等于 PATH 里那串路径完全失效。
 *
 * Windows Terminal / cmd.exe 下不出现是因为它们都不读注册表,而是从父进程
 * (登录会话)继承已展开的 env。Marina 主动 `reg query` 拿原始字符串,绕过了
 * 登录链路的自动展开,等于把这块 ExpandEnvironmentStringsW 的责任接管到自
 * 己头上,却没做。
 *
 * @修复策略(分层防御,任一层挂掉另一层兜底):
 *   Layer 1 (源头):getRefreshedPath 读完注册表立即调
 *                  `expandWindowsEnvPlaceholders` 展开。
 *   Layer 2 (兜底):session-manager spawn 前调
 *                  `PlatformAdapter.normalizeSpawnEnv`,该方法在 Windows 上
 *                  落到本文件的 normalizeWindowsSpawnEnv,做两件事:
 *                  (a) 用 canonical 大小写补齐 SystemRoot / windir / SYSTEMROOT
 *                  (b) 对 PATH-like 字段再做一次展开
 *
 * @关键设计:
 * - 占位符语义对齐 Win32 ExpandEnvironmentStringsW
 *   * 名字查找大小写不敏感(Windows 内核行为)
 *   * 找不到的 %name% **保留原样**(不替换成空串)— 这是关键防御点:若把
 *     找不到的占位符吃掉,反而会复现 bug 2 的原始现象
 *   * 防递归:最多 5 层(Win32 大致也是这量级)
 * - canonical key 名(SystemRoot 而非 SYSTEMROOT)写入 env,且 SYSTEMROOT /
 *   windir 同步写入,确保 cmd / pwsh / bash / Python 等不同子进程都能命中
 *
 * @对应文档章节: ADR-014(待补,本次提交一起加);CHANGELOG 0.1.0-beta.6
 */

const PLACEHOLDER_PATTERN = /%([A-Za-z_][A-Za-z0-9_.()-]*)%/g;

/**
 * 应做展开的 PATH-like 环境变量名(大小写不敏感)。
 * 这些字段在 Windows 注册表里普遍存为 REG_EXPAND_SZ,实际跑起来必须是展开
 * 后的字面路径,否则子进程的命令解析 / 模块加载会挂掉。
 *
 * 不展开整个 env 是因为:
 * (1) 用户 template 里可能故意保留 %FOO% 字面量(很少见但合法)
 * (2) 节省时间 — 终端 spawn 是热路径
 */
const PATH_LIKE_KEYS = new Set(
  [
    'PATH',
    'PATHEXT',
    'PSMODULEPATH',
    'TEMP',
    'TMP',
    'COMSPEC',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'WINDIR',
    'HOMEDRIVE',
    'HOMEPATH',
  ].map((s) => s.toLowerCase()),
);

/**
 * 最多展开多少层。
 *
 * Win32 ExpandEnvironmentStringsW 自身不递归 — 只走一遍,引用里再有 `%x%`
 * 也保留。我们设 5 层是为了兼容某些场景下用户在 PATH 里写 `%PATH%;C:\new`
 * 这种自引用习惯;再多就大概率是环引用,直接 break 保留。
 */
const MAX_EXPAND_PASSES = 5;

/**
 * 像 Win32 ExpandEnvironmentStringsW 一样把 `%name%` 展开成 env 里 name 的值。
 *
 * @param value 含占位符的字符串
 * @param env   用于查找 name 的 env 字典(大小写不敏感匹配)
 * @returns 展开后的字符串;未命中的占位符保留原样
 *
 * @注意:
 * - 名字大小写不敏感:`%systemroot%` 和 `%SystemRoot%` 等价
 * - 空值视同未命中,**不替换**(防御:若 env 里 SystemRoot 是空串,保留 `%SystemRoot%`
 *   字面量比替换成空更不容易出灾难性故障 — 后续兜底层还能再修)
 * - 不抛错:任何输入都返回 string,坏数据降级处理
 */
export function expandWindowsEnvPlaceholders(
  value: string,
  env: Record<string, string>,
): string {
  if (!value || value.indexOf('%') < 0) return value;
  const lookup = buildCaseInsensitiveLookup(env);
  let out = value;
  for (let pass = 0; pass < MAX_EXPAND_PASSES; pass++) {
    let replaced = false;
    out = out.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
      const v = lookup.get(name.toLowerCase());
      if (typeof v !== 'string' || v === '') return match;
      // 防止替换内容本身又含 `%name%` 引发的"显式递归" — 内层循环负责
      replaced = true;
      return v;
    });
    if (!replaced) break;
  }
  return out;
}

/**
 * 子进程环境块的最后一道防御 — Windows 专用。
 *
 * 行为(原地修改并返回 env,便于链式):
 *  1. 计算 canonical SystemRoot 值(优先级:env 任意大小写非空 → 'C:\\Windows')
 *  2. 写入 env.SystemRoot / env.SYSTEMROOT / env.windir(三个 key 都给值,
 *     不同子进程 / 不同 API 路径用的 casing 不同)
 *  3. 对 PATH-like 字段做一次 expandWindowsEnvPlaceholders
 *  4. 残留占位符 → onWarn 回调(供 logger 上报,不阻塞 spawn)
 *
 * @param env     待规整的 env 字典(会被原地修改)
 * @param options.onWarn 残留占位符的告警回调,通常注入 logger.warn
 * @returns 同一个 env 引用
 */
export function normalizeWindowsSpawnEnv(
  env: Record<string, string>,
  options: { onWarn?: (message: string) => void } = {},
): Record<string, string> {
  // (1) canonical SystemRoot
  //
  // 用大小写不敏感查找:用户报告里 process.env 含
  //   { SystemRoot: '', SYSTEMROOT: 'C:\\Windows' }
  // 这种诡异组合(buildSpawnEnv 只是按 Object.entries 复制,没做合并),
  // 我们必须挑那个**非空**的值。buildCaseInsensitiveLookup 已过滤空串。
  const initial = buildCaseInsensitiveLookup(env);
  const systemRoot =
    initial.get('systemroot') ||
    initial.get('windir') ||
    'C:\\Windows';

  // (2) 三个 canonical key 全写
  //
  // - SystemRoot:Win32 API 经典 casing,PowerShell / .NET / Win32 子系统都
  //   按这个查
  // - SYSTEMROOT:POSIX shell(MSYS / Cygwin / Git Bash)按大写匹配
  // - windir:历史悠久的别名,部分老程序 / installer 只认这个
  //
  // 三处都写同一个值,避免任何一处 casing 不一致导致展开失败。
  env.SystemRoot = systemRoot;
  env.SYSTEMROOT = systemRoot;
  env.windir = systemRoot;

  // (3) 展开 PATH-like。重建 lookup,这样上面新写入的 SystemRoot 也能被引用。
  for (const key of Object.keys(env)) {
    if (PATH_LIKE_KEYS.has(key.toLowerCase())) {
      const before = env[key];
      if (typeof before !== 'string') continue;
      const after = expandWindowsEnvPlaceholders(before, env);
      if (after !== before) env[key] = after;
    }
  }

  // (4) 残留占位符告警 — PATH / Path 两种 casing 都查
  const onWarn = options.onWarn;
  if (onWarn) {
    const pathCandidates = [env.PATH, env.Path].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    for (const p of pathCandidates) {
      const remaining = p.match(PLACEHOLDER_PATTERN);
      if (remaining && remaining.length > 0) {
        const unique = Array.from(new Set(remaining));
        onWarn(
          `Windows spawn env: PATH 展开后仍残留占位符 ${unique.join(', ')}`,
        );
        break; // PATH 和 Path 通常同源,告警一次即可
      }
    }
  }

  return env;
}

/**
 * 构造大小写不敏感的 env 查找表(key 全部 toLowerCase)。
 *
 * 同名(差别仅 casing)冲突:优先保留**非空**值。两个都非空时取最后遇到的 —
 * Object.entries 的迭代顺序是插入序,实际等价于"取顺序里最后那条非空记录"。
 *
 * 空字符串视同未设置(Win32 ExpandEnvironmentStringsW 行为一致)。
 */
function buildCaseInsensitiveLookup(
  env: Record<string, string>,
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value === '') continue;
    lookup.set(key.toLowerCase(), value);
  }
  return lookup;
}
