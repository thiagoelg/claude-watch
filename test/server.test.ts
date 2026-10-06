import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { serve, parseKillRequest, type Running } from '../src/server.ts';
import { FakeWorld, typicalWorld, claudeEnv, SESSION_B } from './fixtures.ts';

const TOKEN = 'a'.repeat(64);
let fw: FakeWorld;
let srv: Running;
let port: number;

interface Reply { status: number; body: string; headers: http.IncomingHttpHeaders }

/** Raw HTTP so tests can forge Host and Origin, which fetch() will not let us set. */
function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string; firstChunkOnly?: boolean }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (opts.firstChunkOnly) { req.destroy(); resolve({ status: res.statusCode!, body, headers: res.headers }); }
      });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', (e) => { if (!opts.firstChunkOnly) reject(e); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const killPost = (headers: Record<string, string>, body = JSON.stringify({ target: { kind: 'group', sessionId: SESSION_B, sid: 300 }, expect: [{ pid: 300, starttime: 1300 }] })) =>
  request({ method: 'POST', path: '/kill', headers, body });
const goodHeaders = () => ({ 'Content-Type': 'application/json', 'X-Claude-Watch-Token': TOKEN, Origin: `http://127.0.0.1:${port}` });

describe('server', () => {
  before(async () => {
    fw = typicalWorld().proc({ pid: 300, sid: 300, env: claudeEnv(SESSION_B) });
    srv = await serve({ paths: fw.paths, port: 0, token: TOKEN, self: { pid: 99999, ancestors: [] }, snapshotMs: 50 });
    port = srv.info.port;
  });
  after(async () => { await srv.close(); fw.cleanup(); });

  test('/health answers without a token', async () => {
    const r = await request({ path: '/health' });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).app, 'claude-watch');
  });

  test('the page needs the token', async () => {
    assert.equal((await request({ path: '/' })).status, 403);
    assert.equal((await request({ path: '/?t=wrong' })).status, 403);
    const ok = await request({ path: `/?t=${TOKEN}` });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /<title>claude-watch<\/title>/);
    assert.match(String(ok.headers['content-security-policy']), /frame-ancestors 'none'/);
  });

  test('a foreign Host is refused (DNS rebinding)', async () => {
    const r = await request({ path: `/?t=${TOKEN}`, headers: { Host: `evil.example:${port}` } });
    assert.equal(r.status, 403);
  });

  test('/events needs the token and streams a snapshot', async () => {
    assert.equal((await request({ path: '/events' })).status, 403);
    const r = await request({ path: `/events?t=${TOKEN}`, firstChunkOnly: true });
    assert.equal(r.status, 200);
    const snap = JSON.parse(r.body.replace(/^data: /, ''));
    assert.deepEqual(snap.groups.map((g: any) => [g.sid, g.status]), [[300, 'ghost'], [200, 'active']]);
  });

  test('POST /kill without the token header, or with a foreign or missing Origin, is refused', async () => {
    const h = goodHeaders();
    assert.equal((await killPost({ ...h, 'X-Claude-Watch-Token': 'nope' })).status, 403);
    assert.equal((await killPost({ ...h, Origin: 'https://evil.example' })).status, 403);
    const { Origin: _, ...noOrigin } = h;
    assert.equal((await killPost(noOrigin)).status, 403);
    assert.equal((await killPost({ ...h, 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await killPost(h, '{not json')).status, 400);
    assert.equal((await killPost(h, JSON.stringify({ target: { kind: 'group', sid: -1 } }))).status, 400);
  });

  test('a valid POST /kill reaches the kill logic, which refuses an active group without confirmation', async () => {
    const body = JSON.stringify({ target: { kind: 'group', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', sid: 200 }, expect: [{ pid: 200, starttime: 1200 }, { pid: 201, starttime: 1201 }] });
    const r = await killPost(goodHeaders(), body);
    assert.equal(r.status, 200);
    const res = JSON.parse(r.body);
    assert.equal(res.outcome, 'refused');
    assert.match(res.refusal, /confirm by typing "proj-a1"/);
  });

  test('no CORS headers are ever sent', async () => {
    const r = await request({ method: 'OPTIONS', path: '/kill', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });
});

describe('parseKillRequest', () => {
  test('accepts the two target shapes and rejects the rest', () => {
    assert.ok(parseKillRequest({ target: { kind: 'group', sessionId: null, sid: 5 }, expect: [] }));
    assert.ok(parseKillRequest({ target: { kind: 'process', pid: 5, starttime: 9 }, expect: [{ pid: 5, starttime: 9 }], confirm: 'x' }));
    assert.equal(parseKillRequest({ target: { kind: 'process', pid: '5', starttime: 9 }, expect: [] }), null);
    assert.equal(parseKillRequest({ target: { kind: 'group', sessionId: 1, sid: 5 }, expect: [] }), null);
    assert.equal(parseKillRequest({ target: { kind: 'group', sessionId: null, sid: 5 }, expect: [{ pid: 1 }] }), null);
    assert.equal(parseKillRequest({ target: { kind: 'group', sessionId: null, sid: 5 }, expect: [], confirm: 3 }), null);
    assert.equal(parseKillRequest(null), null);
  });
});
