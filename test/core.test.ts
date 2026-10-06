import { test, describe, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseStat, readProcs, listeningPorts, parseNetTcp } from '../src/core/proc-linux.ts';
import { buildSnapshot, world, type Self } from '../src/core/model.ts';
import { observe } from '../src/core/observe.ts';
import { readSessionRecords } from '../src/core/sessions.ts';
import { sessionsDir } from '../src/core/paths.ts';
import { FakeWorld, typicalWorld, claudeEnv, statLine, SESSION_A, SESSION_B } from './fixtures.ts';

const SELF: Self = { pid: 99999, ancestors: [] };
let fw: FakeWorld | undefined;
afterEach(() => { fw?.cleanup(); fw = undefined; });

const snap = (w: FakeWorld, self: Self = SELF) => buildSnapshot(observe(w.paths, self));
const group = (s: ReturnType<typeof snap>, sid: number, session?: string) =>
  s.groups.find((g) => g.sid === sid && (session === undefined || g.sessionId === session));

describe('proc', () => {
  test('parseStat survives spaces and parentheses in comm', () => {
    const s = parseStat(statLine({ pid: 5, comm: 'a b) (c', ppid: 4, sid: 3, starttime: 777 }));
    assert.equal(s?.comm, 'a b) (c');
    assert.equal(s?.ppid, 4);
    assert.equal(s?.sid, 3);
    assert.equal(s?.starttime, 777);
  });

  test('parseStat reads starttime from field 22 of a real stat line', () => {
    const real = '909361 (claude) S 1 909361 909361 0 -1 4194560 1 0 0 0 5 3 0 0 20 0 30 0 909361 1 2 18446744073709551615 0 0 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0';
    assert.equal(parseStat(real)?.starttime, 909361);
  });

  test('parseNetTcp keeps only LISTEN rows and decodes the port', () => {
    const raw = 'header\n   0: 0100007F:4716 00000000:0000 0A 0 0 0 1000 0 593660 1\n   1: 0100007F:1F90 0100007F:9C40 01 0 0 0 1000 0 777 1\n';
    const m = parseNetTcp(raw, 'tcp');
    assert.deepEqual([...m.keys()], [593660]);
    assert.deepEqual(m.get(593660), { port: 0x4716, addr: '127.0.0.1', proto: 'tcp' });
  });

  test('readProcs reads a fixture tree, with sockets only where asked', () => {
    fw = typicalWorld();
    const procs = readProcs({ root: fw.paths.procRoot, wantSockets: (p) => p.pid === 201 });
    const p201 = procs.find((p) => p.pid === 201)!;
    assert.equal(p201.sid, 200);
    assert.equal(p201.cmdline, 'node vite');
    assert.equal(p201.env?.CLAUDE_CODE_SESSION_ID, SESSION_A);
    assert.deepEqual(p201.socketInodes, [9001]);
    assert.deepEqual(procs.find((p) => p.pid === 200)!.socketInodes, []);
    assert.equal(listeningPorts(fw.paths.procRoot).get(9001)?.port, 5173);
  });

  test('unreadable environ is null, not empty', () => {
    fw = new FakeWorld().proc({ pid: 7, env: null });
    assert.equal(readProcs({ root: fw.paths.procRoot })[0].env, null);
  });
});

describe('sessions', () => {
  test('malformed records are skipped', () => {
    fw = new FakeWorld().session({ pid: 1, procStart: 1, sessionId: SESSION_A });
    writeRecord(fw, 'junk.json', '{nope');
    writeRecord(fw, 'nopid.json', JSON.stringify({ sessionId: SESSION_B }));
    assert.deepEqual(readSessionRecords(sessionsDir(fw.paths)).map((r) => r.sessionId), [SESSION_A]);
  });
});

describe('model', () => {
  test('a shell wrapper sourcing ~/.claude/shell-snapshots is a killable command, not Claude', () => {
    fw = typicalWorld();
    const g = group(snap(fw), 200)!;
    assert.equal(g.status, 'active');
    assert.equal(g.killable, true, g.refusal ?? '');
    assert.deepEqual(g.members.map((m) => [m.pid, m.role]), [[200, 'command'], [201, 'command']]);
    assert.deepEqual(g.members[1].ports, [5173]);
  });

  test('the live Claude process is the session anchor and never part of a killable group', () => {
    fw = typicalWorld();
    const s = snap(fw);
    assert.deepEqual(s.sessions.map((x) => [x.sessionId, x.live, x.claudePid, x.name]), [[SESSION_A, true, 100, 'proj-a1']]);
    assert.equal(s.groups.some((g) => g.members.some((m) => m.pid === 100)), false);
  });

  test('a stale session record (pid alive, different starttime) makes its processes ghosts', () => {
    fw = typicalWorld().session({ pid: 100, procStart: 4242, sessionId: SESSION_A, name: 'proj-a1' });
    const s = snap(fw);
    assert.equal(group(s, 200)!.status, 'ghost');
    assert.equal(group(s, 200)!.killable, true);
    assert.equal(s.sessions[0].live, false);
    assert.equal(s.sessions[0].name, 'proj-a1');
  });

  test('a session with no record at all is a ghost', () => {
    fw = typicalWorld().proc({ pid: 300, sid: 300, env: claudeEnv(SESSION_B) });
    assert.equal(group(snap(fw), 300)!.status, 'ghost');
  });

  test('processes without CLAUDECODE=1 are not listed', () => {
    fw = typicalWorld().proc({ pid: 400, comm: 'bash', exe: '/usr/bin/bash', env: { HOME: '/home/u' } });
    assert.equal(snap(fw).groups.some((g) => g.members.some((m) => m.pid === 400)), false);
  });

  test('CLAUDECODE=1 without a session id is unattributed and never killable', () => {
    fw = typicalWorld().proc({ pid: 500, env: claudeEnv(null) });
    const g = group(snap(fw), 500)!;
    assert.equal(g.status, 'unattributed');
    assert.equal(g.killable, false);
  });

  test('a group containing a process running the Claude binary is refused', () => {
    fw = typicalWorld().proc({ pid: 202, ppid: 200, sid: 200, exe: '/home/u/.local/share/claude/versions/2.1.290', env: claudeEnv(SESSION_A) });
    const g = group(snap(fw), 200)!;
    assert.equal(g.killable, false);
    assert.match(g.refusal!, /202 runs the Claude Code binary/);
    assert.equal(g.members.find((m) => m.pid === 202)!.role, 'claude');
  });

  test('a Claude running under node does not protect every node process', () => {
    fw = typicalWorld().proc({ pid: 100, comm: 'node', exe: '/usr/bin/node', argv: ['node', 'cli.js'], env: {} });
    assert.equal(group(snap(fw), 200)!.killable, true);
  });

  test('a group containing claude-watch itself or its ancestors is refused', () => {
    fw = typicalWorld();
    assert.match(group(snap(fw, { pid: 201, ancestors: [] }), 200)!.refusal!, /201 is claude-watch itself/);
    assert.match(group(snap(fw, { pid: 777, ancestors: [201] }), 200)!.refusal!, /ancestor of claude-watch/);
  });

  test('a sid shared with processes from another session is refused', () => {
    fw = typicalWorld().proc({ pid: 203, ppid: 200, sid: 200, env: claudeEnv(SESSION_B) });
    const s = snap(fw);
    assert.match(group(s, 200, SESSION_A)!.refusal!, /sid 200 also contains 1 process/);
    assert.equal(group(s, 200, SESSION_B)!.killable, false);
  });

  test('assumeLive keeps a session active before its record exists', () => {
    fw = typicalWorld().proc({ pid: 300, sid: 300, env: claudeEnv(SESSION_B) });
    assert.equal(group(snap(fw, { ...SELF, assumeLive: [SESSION_B] }), 300)!.status, 'active');
  });

  test('ghost groups are listed first', () => {
    fw = typicalWorld().proc({ pid: 300, sid: 300, env: claudeEnv(SESSION_B) });
    assert.deepEqual(snap(fw).groups.map((g) => g.status), ['ghost', 'active']);
  });

  test('world() maps live sessions', () => {
    fw = typicalWorld();
    assert.deepEqual([...world(observe(fw.paths, SELF)).live.keys()], [SESSION_A]);
  });
});

function writeRecord(w: FakeWorld, name: string, body: string) {
  fs.writeFileSync(path.join(sessionsDir(w.paths), name), body);
}
