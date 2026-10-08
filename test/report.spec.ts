import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/core/model.ts';
import { observe, selfOf } from '../src/core/observe.ts';
import { procSource } from '../src/core/proc.ts';
import { buildReport, parseExpect } from '../src/report.ts';
import { FakeWorld, typicalWorld, claudeEnv, SESSION_A, SESSION_B } from './fixtures.ts';

let fw: FakeWorld | undefined;
afterEach(() => { fw?.cleanup(); fw = undefined; });

const URL = 'http://127.0.0.1:7337/?t=tok';
const snapshot = (w: FakeWorld) => {
  const source = procSource(w.paths);
  return buildSnapshot(observe(w.paths, selfOf(1, w.paths, [], source), source));
};

describe('report', () => {
  test('describes each group with its session, label, ports and the members to expect', () => {
    fw = typicalWorld().proc({ pid: 300, sid: 300, argv: ['node', 'server.js'], env: claudeEnv(SESSION_B) });
    const r = buildReport(snapshot(fw), URL);
    assert.equal(r.url, URL);
    assert.equal(r.ghosts, 1);
    const active = r.groups.find((g) => g.sessionId === SESSION_A)!;
    assert.equal(active.status, 'active');
    assert.equal(active.sessionName, 'proj-a1');
    assert.equal(active.label, 'node vite on :5173');
    assert.deepEqual(active.ports, [5173]);
    assert.equal(active.expect, '200:1200,201:1201');
    const ghost = r.groups.find((g) => g.sessionId === SESSION_B)!;
    assert.equal(ghost.status, 'ghost');
    assert.equal(ghost.killable, true);
    assert.match(r.context, /1 ghost process group\(s\)/);
    assert.ok(r.userNote.includes(URL));
  });

  test('without a URL it says why', () => {
    fw = typicalWorld();
    const r = buildReport(snapshot(fw), null, 'port 7337 is in use by another program');
    assert.equal(r.error, 'port 7337 is in use by another program');
    assert.match(r.userNote, /not started: port 7337 is in use/);
  });

  test('parses --expect', () => {
    assert.deepEqual(parseExpect('200:1200,201:1201'), [{ pid: 200, starttime: 1200 }, { pid: 201, starttime: 1201 }]);
    assert.equal(parseExpect('200'), null);
    assert.equal(parseExpect('x:1'), null);
    assert.equal(parseExpect(''), null);
  });
});
