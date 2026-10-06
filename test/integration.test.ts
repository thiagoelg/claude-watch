import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, world } from '../src/core/model.ts';
import { observe, selfOf } from '../src/core/observe.ts';
import { executeKill } from '../src/core/kill.ts';
import { procSource } from '../src/core/proc.ts';
import { cleanEnv } from '../src/launch.ts';
import type { Paths } from '../src/core/paths.ts';

// Real processes against the real OS (/proc on Linux, ps/lsof on macOS). The fake session id has no record, so the spawned tree
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
  // Like Claude Code's Bash tool: a detached leader (own session) running two children. node, not
  // sh/sleep: macOS hides the environment of Apple's own binaries, so those would not be listed.
  const tree = `const { spawn } = require('node:child_process');
    for (const t of [120, 121]) spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + t * 1000 + ')'], { stdio: 'ignore' });
    setTimeout(() => {}, 122_000);`;
  const child = spawn(process.execPath, ['-e', tree], {
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
    { look: () => world(observe(paths, self)), source: procSource(paths), graceMs: 3000 },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  await sleep(100);
  for (const m of g.members) {
    const id = procSource(paths).identity(m.pid);
    assert.ok(!id || id.starttime !== m.starttime || id.state === 'Z', `pid ${m.pid} is gone`);
  }
  leader = undefined;
});
