import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeGroup, runHook } from '../src/hook.ts';
import { installHook } from '../src/install.ts';
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
    assert.match(ctx, /node vite on :5174/);
    assert.doesNotMatch(ctx, /shell-snapshots/);
    assert.ok(ctx.includes(URL));
    assert.equal(JSON.parse(out!).systemMessage, `claude-watch: 1 ghost process group(s) left by ended sessions. Dashboard: ${URL}`);
  });

  test('with no ghosts it prints just the dashboard line', async () => {
    fw = typicalWorld();
    const out = await runHook(JSON.stringify({ source: 'resume' }), fw.paths, ensure, {});
    assert.equal(context(out), `claude-watch dashboard (processes started by Claude Code): ${URL}`);
    assert.equal(JSON.parse(out!).systemMessage, `claude-watch dashboard: ${URL}`);
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
    assert.match(ctx, /not started: boom/);
  });
});

describe('cleanEnv', () => {
  test("strips Claude's markers and keeps everything else", () => {
    const env = cleanEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', AI_AGENT: 'claude-code', HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
    assert.deepEqual(env, { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
  });
});

describe('installHook', () => {
  const CMD = '"/usr/bin/node" "/home/u/claude-watch/src/cli.ts" hook';
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const setup = (body?: string) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watch-settings-'));
    const file = path.join(dir, 'settings.json');
    if (body !== undefined) fs.writeFileSync(file, body);
    return file;
  };
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  test('creates a missing settings file', () => {
    const file = setup();
    assert.deepEqual(installHook(file, CMD), { outcome: 'installed', backup: undefined });
    assert.equal(read(file).hooks.SessionStart[0].hooks[0].command, CMD);
  });

  test('keeps every other setting and hook, and backs up the old file', () => {
    const before = { model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [] } };
    const file = setup(JSON.stringify(before));
    const r = installHook(file, CMD);
    assert.equal(r.outcome, 'installed');
    assert.deepEqual(read((r as { backup: string }).backup), before);
    const after = read(file);
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.hooks.Stop, []);
    assert.deepEqual(after.hooks.SessionStart.map((e: any) => e.hooks[0].command), ['echo hi', CMD]);
  });

  test('a second run changes nothing', () => {
    const file = setup('{}');
    installHook(file, CMD);
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(installHook(file, CMD), { outcome: 'already-installed' });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.readdirSync(dir).length, 2);   // settings.json and one backup
  });

  test('refuses invalid files and a hook from another checkout, without writing', () => {
    for (const body of ['{nope', '[]', '{"hooks": []}', '{"hooks": {"SessionStart": {}}}',
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"/usr/bin/node" "/old/src/cli.ts" hook' }] }] } })]) {
      const file = setup(body);
      assert.equal(installHook(file, CMD).outcome, 'refused', body);
      assert.equal(fs.readFileSync(file, 'utf8'), body);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watch-settings-'));
  });

  test('a group is described by its program name, not its full path', () => {
    const member = (cmdline: string, ports: number[] = []) => ({ pid: 1, starttime: 1, ppid: 1, cmdline, cwd: '/', startedAt: 0, rssKb: 0, ports, role: 'command' as const, killable: true });
    const group = (...members: ReturnType<typeof member>[]) => ({ id: 'x', sessionId: null, sid: 1, status: 'ghost' as const, members, killable: true });
    assert.equal(describeGroup(group(member('/nix/store/l5z1hq6l2233-openjdk-21/bin/java -jar app.jar', [8081]))), 'java -jar app.jar on :8081');
    assert.equal(describeGroup(group(member('node /home/u/.npm/_npx/98/node_modules/.bin/playwright-mcp'))), 'node playwright-mcp');
    assert.equal(describeGroup(group(member('node ../vite/bin/vite.js --port 5174'))), 'node ../vite/bin/vite.js --port 5174');
  });
});
