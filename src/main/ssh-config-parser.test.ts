/**
 * @file src/main/ssh-config-parser.test.ts
 * @purpose SshConfigParser 单测(SSH 方案 v2.1 §阶段 2.1)。
 *
 * 用 inline readFile mock 避开真实 fs,Windows / Linux CI 通用。
 */
import { describe, expect, it } from 'vitest';
import { parseSshConfig } from './ssh-config-parser';

describe('parseSshConfig — Host 块基本解析', () => {
  it('单 Host 块,所有 key 都给出 → 完整字段还原', () => {
    const entries = parseSshConfig({
      rootPath: '/fake/ssh/config',
      readFile: () => `
        Host prod
          HostName prod.example.com
          User alice
          Port 2222
          IdentityFile ~/.ssh/prod_ed25519
          ProxyJump bastion.example.com
      `,
    });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.alias).toBe('prod');
    expect(e.hostName).toBe('prod.example.com');
    expect(e.user).toBe('alice');
    expect(e.port).toBe(2222);
    expect(e.identityFiles).toHaveLength(1);
    expect(e.identityFiles[0]!.endsWith('prod_ed25519')).toBe(true);
    expect(e.proxyJump).toEqual(['bastion.example.com']);
    expect(e.sourceFile).toBe('/fake/ssh/config');
  });

  it('Host 行写多个别名 → 拆成多条 entry 共享同 settings', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `
        Host web1 web2 web3
          HostName backend.internal
          User deploy
      `,
    });
    expect(entries.map((e) => e.alias)).toEqual(['web1', 'web2', 'web3']);
    for (const e of entries) {
      expect(e.hostName).toBe('backend.internal');
      expect(e.user).toBe('deploy');
    }
  });

  it('通配符 Host(* / ?)跳过,不进 profile 列表', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `
        Host *.internal
          User deploy

        Host specific
          HostName specific.example.com
      `,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.alias).toBe('specific');
  });

  it('缺 HostName 时回退到 alias(OpenSSH 行为)', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `Host shorthand\n  User bob`,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hostName).toBe('shorthand');
    expect(entries[0]!.user).toBe('bob');
    expect(entries[0]!.port).toBe(22);
  });

  it('Match 段内 settings 整段忽略,但前后 Host 仍正常', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `
        Host before
          HostName before.example.com

        Match host *.matchonly
          User shouldnotappear
          Port 9999

        Host after
          HostName after.example.com
      `,
    });
    expect(entries.map((e) => e.alias)).toEqual(['before', 'after']);
    expect(entries.find((e) => e.user === 'shouldnotappear')).toBeUndefined();
  });

  it('注释 / 空行不影响解析', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `
        # 顶部注释

        Host commented
          # 行内注释开头的解析不应破坏 host 块
          HostName commented.example.com
      `,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hostName).toBe('commented.example.com');
  });

  it('Key=Value 形式 + 引号 value 都支持', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `
        Host quoted
          HostName="quoted.example.com"
          User='alice'
      `,
    });
    expect(entries[0]!.hostName).toBe('quoted.example.com');
    expect(entries[0]!.user).toBe('alice');
  });
});

describe('parseSshConfig — Include 递归 + 错误恢复', () => {
  it('Include 相对路径解析到 ~/.ssh/ 下,递归展开', () => {
    const entries = parseSshConfig({
      rootPath: '/fake/ssh/config',
      readFile: (p) => {
        if (p === '/fake/ssh/config') {
          return `Include extra.conf\nHost root\n  HostName root.example.com`;
        }
        if (p.endsWith('extra.conf')) {
          return `Host extra\n  HostName extra.example.com`;
        }
        throw new Error(`unexpected read: ${p}`);
      },
    });
    const aliases = entries.map((e) => e.alias).sort();
    expect(aliases).toEqual(['extra', 'root']);
  });

  it('Include 读失败 → 只跳过该文件,根文件其他 Host 仍可见', () => {
    const entries = parseSshConfig({
      rootPath: '/fake/ssh/config',
      readFile: (p) => {
        if (p === '/fake/ssh/config') {
          return `Include missing.conf\nHost survives\n  HostName survives.example.com`;
        }
        throw new Error('ENOENT');
      },
    });
    expect(entries.map((e) => e.alias)).toEqual(['survives']);
  });

  it('根文件不存在 → 静默返回空数组(未配置 ssh 的用户)', () => {
    const entries = parseSshConfig({
      rootPath: '/missing',
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(entries).toEqual([]);
  });

  it('Include 循环引用 → 命中 depth 上限后跳出,不死循环', () => {
    const entries = parseSshConfig({
      rootPath: '/loop.conf',
      readFile: () => 'Include loop.conf\nHost dummy\n  HostName x.example.com',
    });
    // 至少不死,且返回了 entry(每层递归都解析了 Host 行)。
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.alias).toBe('dummy');
  });
});

describe('parseSshConfig — ProxyJump 逗号拆分', () => {
  it('单值 ProxyJump 入数组', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `Host a\n  ProxyJump bastion`,
    });
    expect(entries[0]!.proxyJump).toEqual(['bastion']);
  });

  it('多值 ProxyJump 按逗号拆数组,顺序保留', () => {
    const entries = parseSshConfig({
      rootPath: '/x',
      readFile: () => `Host a\n  ProxyJump bastion1, bastion2, bastion3`,
    });
    expect(entries[0]!.proxyJump).toEqual(['bastion1', 'bastion2', 'bastion3']);
  });
});
