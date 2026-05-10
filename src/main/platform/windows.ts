/**
 * @file src/main/platform/windows.ts
 * @purpose Windows 平台适配器实现。V1 唯一完整实现的平台。
 *
 * @关键设计:
 * - detectShells: 探测 pwsh.exe (PowerShell 7+) > powershell.exe (Windows PowerShell 5.1)
 *   > cmd.exe > Git Bash。优先级靠前的同名 shell 排在结果数组靠前
 * - buildShellLaunchParams: 给定 shell + hook 文件路径,返回 spawn 时的
 *   args 与 env,把 OSC 1337 cwd 报告 hook 注入到 shell 启动流程
 *   - PowerShell 系: 用 -NoExit -NoLogo -Command ". 'hook.ps1'"
 *   - cmd.exe: 通过 PROMPT 环境变量内嵌 OSC 1337 序列
 *   - Git Bash: 用 --rcfile bash.sh 启动
 * - getProcessCwd: NTAPI NtQueryInformationProcess 路线需要 ffi-napi
 *   原生模块,目前不依赖原生 deps (AGENTS.md 1.2 边界 2),返回 null。
 *   OSC 1337 hook 是 V1 唯一可靠的 cwd 跟踪机制
 * - Explorer 右键集成: V1.2 启用,V1 留 stub
 * - 开机启动: app.setLoginItemSettings (CP-4 接入)
 *
 * @对应文档章节: 软件定义书.md 5.1.8、12.2、ADR-003、ADR-008
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformAdapter, ShellInfo } from './index';

/**
 * 候选 shell 路径列表。同 id 的多个候选按数组顺序探测,首次命中即用。
 *
 * 这些路径覆盖 Windows 默认安装位置 + PATH 兜底。Pwsh 7 优先于 Win PS 5.1。
 */
interface ShellCandidate {
  id: string;
  displayName: string;
  paths: string[];
}

function getShellCandidates(): ShellCandidate[] {
  const env = process.env;
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const systemRoot = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows';
  return [
    {
      id: 'pwsh',
      displayName: 'PowerShell 7',
      paths: [
        join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
        // PATH 兜底:用纯文件名让 spawn 走 PATH 解析。
        // existsSync 对纯文件名总是 false,所以这条只在前面所有绝对路径都
        // 不存在时,才作为 ShellInfo.executablePath 返回 (但下面 detectShells
        // 会跳过 existsSync 失败的纯文件名,改为只接受能实测命中的路径)。
      ],
    },
    {
      id: 'powershell',
      displayName: 'Windows PowerShell',
      paths: [
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ],
    },
    {
      id: 'cmd',
      displayName: 'Command Prompt',
      paths: [join(systemRoot, 'System32', 'cmd.exe')],
    },
    {
      id: 'git-bash',
      displayName: 'Git Bash',
      paths: [
        join(programFiles, 'Git', 'bin', 'bash.exe'),
        join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      ],
    },
  ];
}

export class WindowsAdapter implements PlatformAdapter {
  /**
   * 探测系统中可用的 shell。
   *
   * 实现是同步 fs.existsSync — 对几个固定路径做存在性检查,远比 child_process
   * spawn 检测便宜,且本方法启动期只调一次。
   */
  async detectShells(): Promise<ShellInfo[]> {
    const result: ShellInfo[] = [];
    for (const candidate of getShellCandidates()) {
      for (const p of candidate.paths) {
        if (existsSync(p)) {
          result.push({
            id: candidate.id,
            displayName: candidate.displayName,
            executablePath: p,
          });
          break; // 同 id 只取第一个命中的路径
        }
      }
    }
    return result;
  }

  /**
   * 根据 shell 类型构造启动参数与环境变量,用于注入 OSC 1337 hook。
   *
   * @param shell 由 detectShells 返回的 shell 信息
   * @param hookFilePath OSC 1337 hook 脚本绝对路径 (pwsh.ps1 / cmd.bat / bash.sh)
   *
   * 关键设计:
   * - PowerShell 系用 -NoLogo + -NoExit + 单次 dot-source,避免重复 banner
   *   (CP-2 errata 见过 "Windows PowerShell" 横幅出现 8 次的现象)
   * - cmd.exe 通过 PROMPT 环境变量内嵌 OSC,无需外部 hook 文件
   *   $E = ESC, $P = cwd, $G = '>'。最终 PROMPT:
   *   `$E]1337;CurrentDir=$P$E\\$P$G` → `\x1b]1337;CurrentDir=<cwd>\x1b\\<cwd>>`
   *   (用 ESC \\ 即 ST 而非 BEL 终止 OSC,Windows 控制台对此更宽容)
   * - bash 系用 --rcfile,该文件先 source 用户原 ~/.bashrc 再 install hook
   */
  buildShellLaunchParams(
    shell: ShellInfo,
    hookFilePath: string,
    commandToRun?: { command: string; args: string[] },
  ): { args: string[]; env: Record<string, string> } {
    switch (shell.id) {
      case 'pwsh':
      case 'powershell': {
        // -NoLogo: 不打印 "Windows PowerShell\n版权..." 横幅
        // -NoExit: hook + command 跑完后保持交互 (postExitAction=keep_shell)
        // -Command: dot-source hook 文件,可选追加用户 command
        // 转义路径:PowerShell 单引号内只有 ' 需要转义为 ''
        const escapedHook = hookFilePath.replace(/'/g, "''");
        let scriptBlock = `. '${escapedHook}'`;
        if (commandToRun) {
          // 用 & 调用,自动按 token 切分,避免和 hook 命令冲突
          // 命令本身用单引号 (假设无单引号);args 也单引号包
          const cmd = quotePwshSingle(commandToRun.command);
          const a = commandToRun.args.map(quotePwshSingle).join(' ');
          scriptBlock += `; & ${cmd}${a ? ' ' + a : ''}`;
        }
        return {
          args: ['-NoLogo', '-NoExit', '-Command', scriptBlock],
          env: {},
        };
      }
      case 'cmd': {
        // cmd.exe 没有 prompt function,用 PROMPT 环境变量内嵌 OSC 1337。
        // ESC \\ (即 1B 5C) 是 ST (String Terminator),OSC 序列的标准结尾;
        // BEL (07) 也行但部分 Windows 解析器更喜欢 ST。
        const PROMPT = '$E]1337;CurrentDir=$P$E\\$P$G ';
        const env: Record<string, string> = {
          PROMPT,
          EASYTERM_HOOK: hookFilePath,
        };
        if (commandToRun) {
          // /K 让 cmd 跑完命令后保持开启;命令直接用引号包
          const quoted = [commandToRun.command, ...commandToRun.args]
            .map(quoteCmd)
            .join(' ');
          return { args: ['/K', quoted], env };
        }
        return { args: [], env };
      }
      case 'git-bash':
      default: {
        // bash --rcfile <file> 让 bash 加载我们的 hook;
        // 有命令时先跑命令再 exec bash (postExitAction=keep_shell)。
        if (commandToRun) {
          const cmdLine = [commandToRun.command, ...commandToRun.args]
            .map(quoteBash)
            .join(' ');
          return {
            args: [
              '--rcfile',
              hookFilePath,
              '-i',
              '-c',
              `${cmdLine}; exec bash -i`,
            ],
            env: {},
          };
        }
        return {
          args: ['--rcfile', hookFilePath, '-i'],
          env: {},
        };
      }
    }
  }

  async registerFileManagerIntegration(_appExePath: string): Promise<void> {
    throw new Error(
      '[WindowsAdapter] registerFileManagerIntegration not implemented (V1.2)',
    );
  }

  async unregisterFileManagerIntegration(): Promise<void> {
    throw new Error(
      '[WindowsAdapter] unregisterFileManagerIntegration not implemented (V1.2)',
    );
  }

  /**
   * 查询进程 cwd 的兜底接口。
   *
   * Windows 上唯一可靠的方式是 NtQueryInformationProcess + 读 PEB 的
   * ProcessParameters.CurrentDirectory.DosPath。这要求:
   *   (1) 通过 ffi-napi (heavy native dep) 调 ntdll.dll
   *   (2) 或自己写 .node 原生扩展
   * 都需要新增依赖 (AGENTS.md 1.2 边界 2 禁止未询问就引入新包),且实测
   * NtQueryInformationProcess 在跨权限边界读 PEB 时失败率不低。
   *
   * V1 的取舍:**OSC 1337 hook 是唯一可靠机制**。本函数始终返回 null,
   * SessionManager 在 5 秒兜底轮询时会得到 null → 仅记录 warn 而不更新
   * currentCwd。这意味着 hook 注入失败的 session 无法在 UI 上跟踪 cd。
   * 用户可见现象:tab 上不出现 ⚠️,但 path 归属不变(ADR-008 解耦后无害)。
   *
   * 留接口为未来加入原生绑定铺路。
   */
  async getProcessCwd(_pid: number): Promise<string | null> {
    return null;
  }

  async setAutoStart(_enabled: boolean): Promise<void> {
    throw new Error('[WindowsAdapter] setAutoStart not implemented (CP-4)');
  }

  async isAutoStartEnabled(): Promise<boolean> {
    throw new Error('[WindowsAdapter] isAutoStartEnabled not implemented (CP-4)');
  }
}

/**
 * PowerShell 单引号 quoting: 'foo' → 'foo';带 ' 的字符串内 ' 转义为 ''。
 * 命令含空格也用单引号统一包,无需考虑 PowerShell 解析逻辑。
 */
function quotePwshSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * cmd.exe quoting: 用 " 包,内部 " 用 ^ 转义。
 * cmd quoting 名声很差 (命令注入风险),用户 template 是受控数据,先用最简版。
 */
function quoteCmd(s: string): string {
  if (!/[\s"&|<>^]/.test(s)) return s;
  return `"${s.replace(/"/g, '^"')}"`;
}

/**
 * bash quoting: 单引号包,内部 ' → '\\''。
 */
function quoteBash(s: string): string {
  if (!/[\s"'$`\\&|<>()*?#!]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
