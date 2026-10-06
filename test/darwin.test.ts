// The macOS source's parsers, fed with captured-format ps/lsof output. These run on any OS;
// the real commands are exercised on a Mac by the integration test (see docs/macos-testing.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  darwinMatchesStart, listeningFromLsof, parseEnvSuffix, parseLsofAddr, parseLsofNames, parseLstart,
  parsePsArgs, parsePsTable, socketId,
} from '../src/core/proc-darwin.ts';
import { procSource } from '../src/core/proc.ts';

describe('darwin parsers', () => {
  test('parseLstart reads the C-locale lstart format, including a space-padded day', () => {
    assert.equal(parseLstart('Tue Oct  6 02:06:36 2026'), new Date(2026, 9, 6, 2, 6, 36).getTime());
    assert.equal(parseLstart('Mon Dec 14 23:59:01 2026'), new Date(2026, 11, 14, 23, 59, 1).getTime());
    assert.equal(parseLstart('garbage'), null);
  });

  test('parsePsTable splits fixed fields, lstart, and a comm with spaces', () => {
    const out = [
      '    1     0     1     0  12345 Ss   Mon Oct  5 08:00:00 2026     /sbin/launchd',
      '  812   790   812   501  45320 S    Tue Oct  6 02:06:36 2026     /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      '  999   812   812   501   1024 Z+   Tue Oct  6 02:07:00 2026     (node)',
      'not a row',
    ].join('\n');
    const rows = parsePsTable(out);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], {
      pid: 812, ppid: 790, pgid: 812, uid: 501, rssKb: 45320, state: 'S',
      startedAt: new Date(2026, 9, 6, 2, 6, 36).getTime(),
      comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    });
    assert.equal(rows[2].state, 'Z');
  });

  test('parsePsArgs keeps the whole argument string', () => {
    assert.deepEqual([...parsePsArgs('  42 node /x/vite --port 5173\n  7 -zsh\n')], [[42, 'node /x/vite --port 5173'], [7, '-zsh']]);
  });

  test('parseEnvSuffix recovers the environment ps -E appends after the arguments', () => {
    const args = 'node /x/vite --mode dev';
    const withEnv = `${args} PATH=/usr/bin:/bin CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=aaaaaaaa-1111-2222-3333-444444444444 TERM_PROGRAM=Apple Terminal HOME=/Users/u`;
    const env = parseEnvSuffix(args, withEnv)!;
    assert.equal(env.CLAUDECODE, '1');
    assert.equal(env.CLAUDE_CODE_SESSION_ID, 'aaaaaaaa-1111-2222-3333-444444444444');
    assert.equal(env.TERM_PROGRAM, 'Apple Terminal');
    assert.equal(env.HOME, '/Users/u');
  });

  test('parseEnvSuffix: arguments that look like assignments are not mistaken for environment', () => {
    const args = 'env CLAUDECODE=0 make';
    const env = parseEnvSuffix(args, `${args} CLAUDECODE=1 USER=u`)!;
    assert.equal(env.CLAUDECODE, '1');
  });

  test('parseEnvSuffix drops a relied-on variable that a crafted value duplicates', () => {
    const args = 'node evil.js';
    const real = 'aaaaaaaa-1111-2222-3333-444444444444';
    const fake = 'bbbbbbbb-1111-2222-3333-444444444444';
    const env = parseEnvSuffix(args, `${args} CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=${real} NOTE=x CLAUDE_CODE_SESSION_ID=${fake} HOME=/u`)!;
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined, 'ambiguous: neither value is trusted');
    assert.equal(env.CLAUDECODE, '1');
    const env2 = parseEnvSuffix(args, `${args} CLAUDECODE=1 X=a CLAUDECODE=0`)!;
    assert.equal(env2.CLAUDECODE, undefined);
  });

  test('parseEnvSuffix returns null when ps could not read the environment', () => {
    assert.equal(parseEnvSuffix('node x', 'node x'), null);
    assert.equal(parseEnvSuffix('node x', 'other'), null);
  });

  test('lsof -F output: pid and name fields, socket addresses', () => {
    const out = 'p501\nf5\nn127.0.0.1:5173\nf7\nn[::1]:5173\np777\nf3\nn*:8080\n';
    assert.deepEqual([...parseLsofNames(out)], [[501, ['127.0.0.1:5173', '[::1]:5173']], [777, ['*:8080']]]);
    assert.deepEqual(parseLsofAddr('*:8080'), { port: 8080, addr: '0.0.0.0', proto: 'tcp' });
    assert.deepEqual(parseLsofAddr('[::1]:5173'), { port: 5173, addr: '::1', proto: 'tcp6' });
    assert.equal(parseLsofAddr('127.0.0.1:5173->127.0.0.1:50000'), null);
    const ports = listeningFromLsof(out);
    assert.equal(ports.get(socketId(501, 5173))?.port, 5173);
    assert.equal(ports.get(socketId(777, 8080))?.addr, '0.0.0.0');
  });
});

describe('darwin session matching', () => {
  const start = new Date(2026, 9, 6, 2, 6, 36).getTime();
  const p = { starttime: Math.round(start / 1000), startedAt: start };

  test('accepts procStart as epoch seconds, ms, microseconds, or a date string', () => {
    assert.ok(darwinMatchesStart(p, String(p.starttime)));
    assert.ok(darwinMatchesStart(p, String(start)));
    assert.ok(darwinMatchesStart(p, String(start * 1000)));
    assert.ok(darwinMatchesStart(p, new Date(start).toISOString()));
  });

  test('reads the lstart-in-UTC procStart that Claude Code writes on macOS', () => {
    // Observed: procStart "Tue Oct  6 16:14:07 2026" for a process whose local lstart (UTC-3) was 13:14:07.
    const q = { starttime: Date.UTC(2026, 9, 6, 16, 14, 7) / 1000, startedAt: Date.UTC(2026, 9, 6, 16, 14, 7) };
    assert.ok(darwinMatchesStart(q, 'Tue Oct  6 16:14:07 2026'));
    assert.ok(!darwinMatchesStart(q, 'Tue Oct  6 19:14:07 2026'));
  });

  test('falls back to the record startedAt (the process starts shortly before the session)', () => {
    assert.ok(darwinMatchesStart(p, 'opaque-value', start + 1500));
    assert.ok(!darwinMatchesStart(p, 'opaque-value', start + 3 * 3600_000));
  });

  test('rejects a recycled pid that started at a different time', () => {
    assert.ok(!darwinMatchesStart(p, String(p.starttime + 7200), start + 7200_000));
    assert.ok(!darwinMatchesStart(p, ''));
  });
});

describe('procSource selection', () => {
  const paths = (procRoot: string) => ({ procRoot, claudeDir: '/c', dataDir: '/d' });
  test('macOS uses ps/lsof; Linux and any fixture root use /proc', () => {
    assert.equal(procSource(paths('/proc'), 'darwin').platform, 'darwin');
    assert.equal(procSource(paths('/tmp/fixture'), 'darwin').platform, 'linux');
    assert.equal(procSource(paths('/proc'), 'linux').platform, 'linux');
  });
});
