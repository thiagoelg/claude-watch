import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ghostCount, link, renderSegment, statusLine, statusSegment } from '../src/statusline.ts';
import { installCcstatuslineWidget, installStatusLine, statusLineCommand } from '../src/install.ts';
import { FakeWorld, typicalWorld, claudeEnv, SESSION_B } from './fixtures.ts';

let fw: FakeWorld | undefined;
afterEach(() => { fw?.cleanup(); fw = undefined; });

const URL = 'http://127.0.0.1:7337/?t=tok';
const ensure = async () => ({ url: URL });
const ghostWorld = () => typicalWorld().proc({ pid: 300, sid: 300, env: claudeEnv(SESSION_B) });
// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '');

describe('statusline', () => {
  test('the segment links to the dashboard and counts ghosts', () => {
    assert.ok(renderSegment({ url: URL, ghosts: 0 }).includes(link(URL, 'claude-watch')));
    assert.equal(visible(renderSegment({ url: URL, ghosts: 1 })), 'claude-watch: 1 ghost');
    assert.equal(visible(renderSegment({ url: URL, ghosts: 3 })), 'claude-watch: 3 ghosts');
    assert.equal(visible(renderSegment({ url: null, ghosts: 2, error: 'port 7337 is in use by another program' })), 'claude-watch: off (port 7337 is in use by another program)');
  });

  test('the ghost count is cached for a few seconds', () => {
    fw = ghostWorld();
    const t = Date.now();
    assert.equal(ghostCount(fw.paths, undefined, t), 1);
    fw.remove(300);
    assert.equal(ghostCount(fw.paths, undefined, t + 1000), 1);
    assert.equal(ghostCount(fw.paths, undefined, t + 60_000), 0);
  });

  test('the calling session is never counted as a ghost', () => {
    fw = ghostWorld();
    assert.equal(ghostCount(fw.paths, SESSION_B), 0);
  });

  test('with no server running, it starts one and links to it', async () => {
    fw = ghostWorld();
    let called = 0;
    const seg = await statusSegment(fw.paths, '{}', async () => { called++; return { url: URL }; });
    assert.equal(called, 1);
    assert.ok(seg.includes(URL));
    const off = await statusSegment(fw.paths, '{}', async () => { throw new Error('port 7337 is in use by another program; set CLAUDE_WATCH_PORT'); });
    assert.equal(visible(off), 'claude-watch: off (port 7337 is in use by another program)');
  });

  test('a wrapped status line comes first, with the same input', async () => {
    fw = typicalWorld();
    const out = await statusLine(fw.paths, '{"x":1}', 'cat; printf "\\n\\n"', ensure);
    assert.equal(visible(out), '{"x":1}\nclaude-watch');
    assert.equal(visible(await statusLine(fw.paths, '{}', 'exit 3', ensure)), 'claude-watch');
  });
});

describe('install-statusline', () => {
  const BASE = '"/usr/bin/node" "/home/u/claude-watch/src/cli.ts" statusline';
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const setup = (name: string, body?: unknown) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watch-statusline-'));
    const file = path.join(dir, name);
    if (body !== undefined) fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  test('wraps the current status line command and keeps its options', () => {
    const file = setup('settings.json', { statusLine: { type: 'command', command: "my-line --x 'a b'", padding: 0 } });
    assert.equal(installStatusLine(file, BASE).outcome, 'installed');
    const sl = read(file).statusLine;
    assert.deepEqual(sl, { type: 'command', command: statusLineCommand(BASE, "my-line --x 'a b'"), padding: 0, refreshInterval: 10 });
    assert.equal(sl.command, `${BASE} --wrap 'my-line --x '\\''a b'\\'''`);
    assert.equal(installStatusLine(file, BASE).outcome, 'already-installed');
  });

  test('without a status line, sets ours alone; a different claude-watch one is refused', () => {
    const file = setup('settings.json', {});
    installStatusLine(file, BASE);
    assert.equal(read(file).statusLine.command, BASE);
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: '"/n" "/old/src/cli.ts" statusline' } }));
    assert.equal(installStatusLine(file, BASE).outcome, 'refused');
  });

  test('adds one ccstatusline widget at the end of the first line', () => {
    const file = setup('ccs.json', { version: 4, lines: [[{ id: '1', type: 'model' }], [], []] });
    assert.equal(installCcstatuslineWidget(file, BASE).outcome, 'installed');
    const first = read(file).lines[0];
    assert.deepEqual(first.map((w: any) => w.type), ['model', 'separator', 'custom-command']);
    assert.equal(first[2].commandPath, BASE);
    assert.equal(first[2].preserveColors, true);
    assert.equal(installCcstatuslineWidget(file, BASE).outcome, 'already-installed');
  });

  test('a missing or unexpected ccstatusline config is refused', () => {
    assert.equal(installCcstatuslineWidget(setup('ccs.json'), BASE).outcome, 'refused');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(installCcstatuslineWidget(setup('ccs.json', { version: 4 }), BASE).outcome, 'refused');
  });
});
