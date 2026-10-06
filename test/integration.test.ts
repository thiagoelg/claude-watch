import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, world } from '../src/core/model.ts';
import { observe, selfOf } from '../src/core/observe.ts';
import { executeKill } from '../src/core/kill.ts';
import { readProc } from '../src/core/proc.ts';
import { cleanEnv } from '../src/launch.ts';
import type { Paths } from '../src/core/paths.ts';

// Real processes against the real /proc. The fake session id has no record, so the spawned tree
// must show up as a ghost. Only a group whose sid is the pid we spawned is ever killed.
const FAKE_SESSION = 'feedface-0000-4000-8000-000000000001';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watch-it-'));
const paths: Paths = { procRoot: '/proc', claudeDir: path.join(tmp, 'claude'), dataDir: path.join(tmp, 'data') };
let leader: number | undefined;

after(() => {
  if (leader) { try { process.kill(-leader, 'SIGKILL'); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a detached command from an ended session is a ghost and can be killed', async () => {
  // Exactly like Claude Code's Bash tool: a detached shell (own session) running a child.
  const child = spawn('sh', ['-c', 'sleep 120 & sleep 121 & wait'], {
    detached: true, stdio: 'ignore',
    env: { ...cleanEnv(process.env), CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: FAKE_SESSION },
  });
  child.unref();
  leader = child.pid!;
  await sleep(300);

  const self = selfOf(process.pid, paths);
  const snap = buildSnapshot(observe(paths, self));
  const g = snap.groups.find((x) => x.sessionId === FAKE_SESSION);
  assert.ok(g, 'the spawned group is listed');
  assert.equal(g.sid, leader, 'the group is exactly the session we spawned');
  assert.equal(g.status, 'ghost');
  assert.equal(g.killable, true, g.refusal ?? '');
  assert.equal(g.members.length, 3);

  const r = await executeKill(
    { target: { kind: 'group', sessionId: g.sessionId, sid: g.sid }, expect: g.members.map((m) => ({ pid: m.pid, starttime: m.starttime })) },
    { look: () => world(observe(paths, self)), procRoot: '/proc', graceMs: 3000 },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  await sleep(100);
  for (const m of g.members) {
    const p = readProc(m.pid);
    assert.ok(!p || p.starttime !== m.starttime || p.state === 'Z', `pid ${m.pid} is gone`);
  }
  leader = undefined;
});
