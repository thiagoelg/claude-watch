import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { world, type Self } from '../src/core/model.ts';
import { observe } from '../src/core/observe.ts';
import { planKill, executeKill, type KillRequest } from '../src/core/kill.ts';
import { actionsLog } from '../src/core/paths.ts';
import { linuxSource } from '../src/core/proc-linux.ts';
import { FakeWorld, typicalWorld, claudeEnv, SESSION_A, SESSION_B } from './fixtures.ts';

const SELF: Self = { pid: 99999, ancestors: [] };
let fw: FakeWorld | undefined;
afterEach(() => { fw?.cleanup(); fw = undefined; });

const look = (w: FakeWorld) => () => world(observe(w.paths, SELF));
const st = (pid: number) => 1000 + pid;   // fixture default starttime
const groupReq = (sessionId: string, sid: number, pids: number[], confirm?: string): KillRequest => ({
  target: { kind: 'group', sessionId, sid }, expect: pids.map((pid) => ({ pid, starttime: st(pid) })), confirm,
});

/** A ghost group: session B has no record. Shell 300 -> child 301. */
const ghostWorld = () => typicalWorld()
  .proc({ pid: 300, sid: 300, env: claudeEnv(SESSION_B) })
  .proc({ pid: 301, ppid: 300, sid: 300, env: claudeEnv(SESSION_B) });

describe('planKill', () => {
  test('a ghost group is allowed with no confirmation', () => {
    fw = ghostWorld();
    const plan = planKill(look(fw)(), groupReq(SESSION_B, 300, [300, 301]));
    assert.equal(plan.ok, true);
  });

  test('an active group needs the session name typed', () => {
    fw = typicalWorld();
    const no = planKill(look(fw)(), groupReq(SESSION_A, 200, [200, 201]));
    assert.equal(no.ok, false);
    assert.match(!no.ok ? no.refusal : '', /confirm by typing "proj-a1"/);
    assert.equal(planKill(look(fw)(), groupReq(SESSION_A, 200, [200, 201], 'wrong')).ok, false);
    assert.equal(planKill(look(fw)(), groupReq(SESSION_A, 200, [200, 201], 'proj-a1')).ok, true);
  });

  test('a stale view (member set changed) is refused', () => {
    fw = ghostWorld().proc({ pid: 302, ppid: 300, sid: 300, env: claudeEnv(SESSION_B) });
    const plan = planKill(look(fw)(), groupReq(SESSION_B, 300, [300, 301]));
    assert.equal(plan.ok, false);
    assert.match(!plan.ok ? plan.refusal : '', /changed since you looked/);
  });

  test('pid reuse (same pid, new starttime) is refused', () => {
    fw = ghostWorld().proc({ pid: 301, ppid: 300, sid: 300, starttime: 5555, env: claudeEnv(SESSION_B) });
    assert.equal(planKill(look(fw)(), groupReq(SESSION_B, 300, [300, 301])).ok, false);
    const single = planKill(look(fw)(), { target: { kind: 'process', pid: 301, starttime: st(301) }, expect: [] });
    assert.equal(single.ok, false);
  });

  test('a process not started by Claude cannot be targeted', () => {
    fw = typicalWorld().proc({ pid: 400, comm: 'bash', env: { HOME: '/home/u' } });
    const plan = planKill(look(fw)(), { target: { kind: 'process', pid: 400, starttime: st(400) }, expect: [] });
    assert.equal(plan.ok, false);
    assert.match(!plan.ok ? plan.refusal : '', /not started by Claude Code/);
  });

  test('a single protected process cannot be targeted', () => {
    fw = typicalWorld();
    const plan = planKill(world(observe(fw.paths, { pid: 201, ancestors: [200, 100] })), { target: { kind: 'process', pid: 200, starttime: st(200) }, expect: [] });
    assert.equal(plan.ok, false);
  });

  test('a single row of a refused group is still killable on its own', () => {
    fw = ghostWorld().proc({ pid: 303, ppid: 300, sid: 300, env: claudeEnv(SESSION_A) });   // a stranger in sid 300
    assert.equal(planKill(look(fw)(), groupReq(SESSION_B, 300, [300, 301])).ok, false);
    assert.equal(planKill(look(fw)(), { target: { kind: 'process', pid: 301, starttime: st(301) }, expect: [] }).ok, true);
  });
});

describe('executeKill', () => {
  test('dry-run signals nothing and is logged', async () => {
    fw = ghostWorld();
    const sent: number[] = [];
    const r = await executeKill(groupReq(SESSION_B, 300, [300, 301]),
      { look: look(fw), source: linuxSource(fw.paths.procRoot), logFile: actionsLog(fw.paths), signal: (pid) => sent.push(pid) }, { dryRun: true });
    assert.equal(r.outcome, 'dry-run');
    assert.deepEqual(sent, []);
    assert.match(fs.readFileSync(actionsLog(fw.paths), 'utf8'), /"outcome":"dry-run"/);
  });

  test('SIGTERM to every member; done when they exit', async () => {
    const w = ghostWorld(); fw = w;
    const sent: string[] = [];
    const r = await executeKill(groupReq(SESSION_B, 300, [300, 301]), {
      look: look(w), source: linuxSource(w.paths.procRoot), pollMs: 5, graceMs: 200,
      signal: (pid, sig) => { sent.push(`${pid}:${sig}`); w.remove(pid); },
    });
    assert.equal(r.outcome, 'terminated');
    assert.deepEqual(sent, ['300:SIGTERM', '301:SIGTERM']);
  });

  test('survivors get SIGKILL after the grace period', async () => {
    const w = ghostWorld(); fw = w;
    const sent: string[] = [];
    const r = await executeKill(groupReq(SESSION_B, 300, [300, 301]), {
      look: look(w), source: linuxSource(w.paths.procRoot), pollMs: 5, graceMs: 30,
      signal: (pid, sig) => { sent.push(`${pid}:${sig}`); if (sig === 'SIGKILL' || pid === 300) w.remove(pid); },
    });
    assert.equal(r.outcome, 'killed');
    assert.deepEqual(sent, ['300:SIGTERM', '301:SIGTERM', '301:SIGKILL']);
  });

  test('a pid reused during the grace period is never SIGKILLed', async () => {
    const w = ghostWorld(); fw = w;
    const sent: string[] = [];
    const r = await executeKill(groupReq(SESSION_B, 300, [300, 301]), {
      look: look(w), source: linuxSource(w.paths.procRoot), pollMs: 5, graceMs: 30,
      signal: (pid, sig) => {
        sent.push(`${pid}:${sig}`);
        w.remove(pid);
        // 301 dies and its pid is immediately recycled by an unrelated process.
        if (pid === 301) w.proc({ pid: 301, starttime: 9999, env: { HOME: '/x' } });
      },
    });
    assert.equal(r.outcome, 'terminated');
    assert.deepEqual(sent, ['300:SIGTERM', '301:SIGTERM']);
  });

  test('a zombie counts as dead', async () => {
    const w = ghostWorld(); fw = w;
    const r = await executeKill(groupReq(SESSION_B, 300, [300, 301]), {
      look: look(w), source: linuxSource(w.paths.procRoot), pollMs: 5, graceMs: 100,
      signal: (pid) => { w.proc({ pid, sid: 300, state: 'Z', env: claudeEnv(SESSION_B) }); },
    });
    assert.equal(r.outcome, 'terminated');
  });

  test('children forked during the kill are signalled too, if eligible', async () => {
    const w = ghostWorld(); fw = w;
    const sent: string[] = [];
    let forked = false;
    const r = await executeKill(groupReq(SESSION_B, 300, [300, 301]), {
      look: look(w), source: linuxSource(w.paths.procRoot), pollMs: 5, graceMs: 200,
      signal: (pid, sig) => {
        sent.push(`${pid}:${sig}`);
        w.remove(pid);
        if (!forked) { forked = true; w.proc({ pid: 305, ppid: 301, sid: 300, env: claudeEnv(SESSION_B) }); }
      },
    });
    assert.equal(r.outcome, 'terminated');
    assert.deepEqual(sent, ['300:SIGTERM', '301:SIGTERM', '305:SIGTERM']);
  });

  test('refusals are logged with their reason', async () => {
    fw = typicalWorld();
    const r = await executeKill(groupReq(SESSION_A, 200, [200, 201]), { look: look(fw), source: linuxSource(fw.paths.procRoot), logFile: actionsLog(fw.paths), signal: () => assert.fail('must not signal') });
    assert.equal(r.outcome, 'refused');
    assert.match(fs.readFileSync(actionsLog(fw.paths), 'utf8'), /confirm by typing/);
  });
});
