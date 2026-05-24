/**
 * @file src/main/ssh-agent.test.ts
 * @purpose ssh-agent 探测单测(SSH 方案 v2.1 §阶段 2.2)。runner 全 mock,
 *   不真起 ssh-add 子进程,Windows / Linux CI 都能跑。
 */
import { describe, expect, it } from 'vitest';
import { detectSshAgent, parseSshAddOutput } from './ssh-agent';

describe('parseSshAddOutput', () => {
  it('单 key 解析:bits / fingerprint / comment / keyType', () => {
    const keys = parseSshAddOutput(
      '256 SHA256:AAAA1234 alice@thinkpad (ED25519)\n',
    );
    expect(keys).toEqual([
      {
        bits: 256,
        fingerprint: 'SHA256:AAAA1234',
        comment: 'alice@thinkpad',
        keyType: 'ED25519',
      },
    ]);
  });

  it('多 key + 注释含空格', () => {
    const keys = parseSshAddOutput(
      [
        '256 SHA256:abc alice@thinkpad (ED25519)',
        '2048 SHA256:def ci bot key (RSA)',
        '',
        '3072 SHA256:ghi extra@host (ECDSA)',
      ].join('\n'),
    );
    expect(keys).toHaveLength(3);
    expect(keys[1]!.comment).toBe('ci bot key');
    expect(keys[1]!.keyType).toBe('RSA');
  });

  it('"The agent has no identities." 这种非标准行整行忽略', () => {
    const keys = parseSshAddOutput('The agent has no identities.\n');
    expect(keys).toEqual([]);
  });
});

describe('detectSshAgent', () => {
  it('POSIX:SSH_AUTH_SOCK 缺失 → agent-missing/no-socket(不调 ssh-add)', () => {
    if (process.platform === 'win32') return; // 该路径只在 POSIX 触发
    let called = false;
    const r = detectSshAgent({
      env: {},
      runner: () => {
        called = true;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(r.status).toBe('agent-missing');
    if (r.status === 'agent-missing') expect(r.reason).toBe('no-socket');
    expect(called).toBe(false);
  });

  it('ssh-add exit 0 + 有 key → agent-running + keys 列表', () => {
    const r = detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/fake-agent.sock' },
      runner: () => ({
        status: 0,
        stdout: '256 SHA256:abcd alice@laptop (ED25519)\n',
        stderr: '',
      }),
    });
    expect(r.status).toBe('agent-running');
    if (r.status === 'agent-running') {
      expect(r.keys).toHaveLength(1);
      expect(r.keys[0]!.comment).toBe('alice@laptop');
    }
  });

  it('ssh-add exit 1 → agent-running, keys=[]', () => {
    const r = detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/x' },
      runner: () => ({
        status: 1,
        stdout: '',
        stderr: 'The agent has no identities.\n',
      }),
    });
    expect(r.status).toBe('agent-running');
    if (r.status === 'agent-running') expect(r.keys).toEqual([]);
  });

  it('ssh-add exit 2 → agent-missing/no-socket', () => {
    const r = detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/x' },
      runner: () => ({
        status: 2,
        stdout: '',
        stderr: 'Could not open a connection to your authentication agent.\n',
      }),
    });
    expect(r.status).toBe('agent-missing');
    if (r.status === 'agent-missing') expect(r.reason).toBe('no-socket');
  });

  it('ssh-add ENOENT(CLI 不在 PATH)→ agent-missing/cli-missing', () => {
    const r = detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/x' },
      runner: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('spawn ssh-add ENOENT'), { code: 'ENOENT' }),
      }),
    });
    expect(r.status).toBe('agent-missing');
    if (r.status === 'agent-missing') expect(r.reason).toBe('cli-missing');
  });

  it('runner 抛异常 → agent-missing/cli-failed', () => {
    const r = detectSshAgent({
      env: { SSH_AUTH_SOCK: '/tmp/x' },
      runner: () => {
        throw new Error('boom');
      },
    });
    expect(r.status).toBe('agent-missing');
    if (r.status === 'agent-missing') expect(r.reason).toBe('cli-failed');
  });
});
