/**
 * @file src/main/shipped-scripts-ascii.test.ts
 * @purpose Regression guard for ENC-1: every Windows script file we ship
 *   to user machines must be pure ASCII (no BOM, no byte > 0x7F).
 *
 * Background:
 *   Windows PowerShell 5.1 (powershell.exe, the built-in version that
 *   ships with Windows) reads .ps1 files using the *system ANSI code
 *   page* when no UTF-8 BOM is present. cmd.exe does the same for .bat
 *   with the OEM code page. On a Chinese-locale machine that is
 *   CP936/GBK; reading our UTF-8 multi-byte sequences as GBK mis-decodes
 *   them and can produce stray "}" / "{" / "'" tokens that break the
 *   parser at runtime.
 *
 *   Marina's shell detection (src/main/platform/windows.ts) prefers
 *   pwsh.exe (PowerShell 7, UTF-8 by default) but falls back to 5.1 when
 *   7 is not installed. v0.1.0-beta.1 shipped with Chinese comments in
 *   pwsh.ps1 and a user on Chinese Windows without pwsh 7 immediately
 *   saw a parse error at every session start. This test prevents the
 *   regression.
 *
 *   Adding a BOM would also work but forces every editor + tooling step
 *   (Write tool, prettier, electron-builder copy) to preserve it, which
 *   we cannot guarantee. Pure ASCII is the only stable rule.
 *
 * Scope:
 *   All Windows script files (.ps1 / .cmd / .bat) under src/shell-hooks/,
 *   src/skills/show-in-marina/, and scripts/ that get bundled into the
 *   installer via extraResources in electron-builder.yml. If you add a new
 *   .ps1 / .cmd / .bat to that pipeline, add it to LOCALE_SENSITIVE_FILES
 *   below.
 *
 *   .sh / .fish files are out of scope — POSIX shells treat `#` comments
 *   as opaque until newline, so non-ASCII bytes in comments cannot
 *   produce syntax errors. They are still kept BOM-free for shebang
 *   correctness, but that is enforced separately.
 *
 * Fix when this test fails:
 *   - Replace Chinese / non-ASCII content with English (the canonical
 *     fix; matches every other shipped .ps1 in the project).
 *   - If you must surface a Chinese string to the user, return a stable
 *     English marker or exit code from the .ps1 and translate on the
 *     TypeScript side (main / renderer), where UTF-8 is unambiguous.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Files shipped to user machines and parsed by Windows PowerShell / cmd.
 * Keep in sync with electron-builder.yml extraResources.
 */
const LOCALE_SENSITIVE_FILES = [
  'src/shell-hooks/pwsh.ps1',
  'src/shell-hooks/cmd.bat',
  'scripts/install-context-menu.ps1',
  'scripts/uninstall-context-menu.ps1',
  // show-in-marina skill ships to user projects via skill-installer (cp of
  // src/skills/show-in-marina) and is parsed by powershell.exe / cmd.exe.
  // The extensionless `marina` is a bash dispatcher; it is kept ASCII-only to
  // match the rest of the skill bundle and to avoid any surprises when the
  // skill-installer / electron-builder copies it across (and so a non-ASCII
  // byte can never sneak into a shebang line on a misconfigured box).
  // `marina.sh` is the native POSIX client (Linux / macOS); same ASCII rule so
  // a stray byte can never corrupt its shebang / comments on any box.
  'src/skills/show-in-marina/marina.ps1',
  'src/skills/show-in-marina/marina.cmd',
  'src/skills/show-in-marina/marina',
  'src/skills/show-in-marina/marina.sh',
] as const;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('Shipped Windows scripts must be ASCII-only (ENC-1)', () => {
  for (const rel of LOCALE_SENSITIVE_FILES) {
    describe(rel, () => {
      const bytes = readFileSync(resolve(REPO_ROOT, rel));

      it('has no UTF-8 BOM', () => {
        const hasBom = bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM);
        expect(hasBom, `${rel} starts with a UTF-8 BOM. See file header.`).toBe(false);
      });

      it('contains no byte > 0x7F (pure ASCII)', () => {
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i]!;
          if (b > 0x7f) {
            const before = bytes.subarray(0, i).toString('latin1');
            const line = before.split('\n').length;
            const ctxStart = Math.max(0, i - 20);
            const ctxEnd = Math.min(bytes.length, i + 20);
            const ctx = bytes.subarray(ctxStart, ctxEnd).toString('latin1');
            throw new Error(
              `${rel}: non-ASCII byte 0x${b.toString(16).padStart(2, '0')} at offset ${i} (line ${line}). ` +
                `Context: ...${ctx}... -- see file header for why this matters (ENC-1).`,
            );
          }
        }
      });
    });
  }
});

describe('show-in-marina bash dispatcher must be zero-external-tooling', () => {
  // 背景(2026-08-16 实测):AI 工具(Claude Code 等)在 Marina 终端里以裸 Git Bash
  // 起进程(no profile),MSYS PATH 只是转译后的 Windows PATH;Marina PTY 的 PATH
  // 从注册表刷新,含 Git\cmd 但不含 Git\usr\bin。该环境下:
  //   `#!/usr/bin/env bash` → "/usr/bin/env: 'bash': No such file or directory"
  //   dirname/uname 等任何 /usr/bin 工具 → "command not found"
  // dispatcher 在 exec 客户端之前只允许 bash 内建(直到 powershell.exe 接手)。
  const content = readFileSync(resolve(REPO_ROOT, 'src/skills/show-in-marina/marina'), 'utf8');

  it('shebang 是 #!/bin/bash(env 形式在裸 MSYS 下找不到 bash)', () => {
    const firstLine = content.split('\n')[0];
    expect(firstLine).toBe('#!/bin/bash');
  });

  it('不依赖 /usr/bin 外部工具(非注释行禁止 $(dirname / $(uname)', () => {
    // 只查代码行:注释里描述约束本身时会提到这些词。
    const codeLines = content.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    const code = codeLines.join('\n');
    expect(code).not.toMatch(/\$\(dirname/);
    expect(code).not.toMatch(/\$\(uname/);
  });

  it('行尾为纯 LF(CRLF 会让 shebang/变量值带上 \\r)', () => {
    expect(content).not.toContain('\r');
  });
});
