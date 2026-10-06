import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runHook } from '../src/hook.ts';
import { cleanEnv } from '../src/launch.ts';
import { FakeWorld, typicalWorld, claudeEnv, SESSION_B } from './fixtures.ts';

let fw: FakeWorld | undefined;
afterEach(() => { fw?.cleanup(); fw = undefined; });

const URL = 'http://127.0.0.1:7337/?t=tok';
const ensure = async () => ({ url: URL });
const context = (out: string | null) => out && JSON.parse(out).hookSpecificOutput.additionalContext;

/** Session B ended and left vite (with its shell wrapper) on :5173. */
const ghostWorld = () => typicalWorld()
  .proc({ pid: 300, sid: 300, comm: 'zsh', argv: ['/usr/bin/zsh', '-c', 'source /home/u/.claude/shell-snapshots/s.sh && eval vite'], env: claudeEnv(SESSION_B) })
  .proc({ pid: 301, ppid: 300, sid: 300, argv: ['node', '/p/node_modules/.bin/vite'], env: claudeEnv(SESSION_B), sockets: [9002] })
  .listen({ 9001: 5173, 9002: 5174 });

describe('hook', () => {
  test('reports ghosts with their leaf command and ports, plus the dashboard URL', async () => {
    fw = ghostWorld();
    const out = await runHook(JSON.stringify({ session_id: 'cccccccc-1111-2222-3333-444444444444', source: 'startup' }), fw.paths, ensure, {});
    const ctx = context(out);
    assert.equal(JSON.parse(out!).hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(ctx, /1 ghost process group\(s\) left running by 1 Claude Code session/);
    assert.match(ctx, /node \/p\/node_modules\/\.bin\/vite on :5174/);
    assert.doesNotMatch(ctx, /shell-snapshots/);
    assert.ok(ctx.includes(URL));
  });

  test('with no ghosts it prints just the dashboard line', async () => {
    fw = typicalWorld();
    const ctx = context(await runHook(JSON.stringify({ source: 'resume' }), fw.paths, ensure, {}));
    assert.equal(ctx, `claude-watch dashboard (processes started by Claude Code): ${URL}`);
  });

  test('the new session is not reported as a ghost before its record exists', async () => {
    fw = ghostWorld();
    const ctx = context(await runHook(JSON.stringify({ session_id: SESSION_B, source: 'startup' }), fw.paths, ensure, {}));
    assert.doesNotMatch(ctx, /ghost/);
  });

  test('clear and compact ensure the server but print nothing', async () => {
    fw = ghostWorld();
    let ensured = 0;
    const out = await runHook(JSON.stringify({ source: 'compact' }), fw.paths, async () => { ensured++; return { url: URL }; }, {});
    assert.equal(out, null);
    assert.equal(ensured, 1);
  });

  test('bad input and a failing server start do not throw', async () => {
    fw = typicalWorld();
    const ctx = context(await runHook('not json', fw.paths, async () => { throw new Error('boom'); }, {}));
    assert.match(ctx, /failed to start/);
  });
});

describe('cleanEnv', () => {
  test("strips Claude's markers and keeps everything else", () => {
    const env = cleanEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', AI_AGENT: 'claude-code', HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
    assert.deepEqual(env, { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
  });
});
