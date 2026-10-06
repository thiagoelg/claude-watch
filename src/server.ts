import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildSnapshot, world, type Self } from './core/model.ts';
import { observe, selfOf } from './core/observe.ts';
import { executeKill, type KillRequest, type Target } from './core/kill.ts';
import { readStarttime } from './core/proc.ts';
import { actionsLog, serverFile, type Paths } from './core/paths.ts';

export const DEFAULT_PORT = 7337;
const UI_FILE = path.join(import.meta.dirname, '..', 'ui', 'index.html');

export interface ServerInfo {
  pid: number;
  procStart: number;
  port: number;
  token: string;
}

export const dashboardUrl = (info: Pick<ServerInfo, 'port' | 'token'>) => `http://127.0.0.1:${info.port}/?t=${info.token}`;
export const newToken = () => crypto.randomBytes(32).toString('hex');

export function readServerInfo(paths: Paths): ServerInfo | null {
  try {
    const j = JSON.parse(fs.readFileSync(serverFile(paths), 'utf8'));
    if (typeof j.pid === 'number' && typeof j.port === 'number' && typeof j.token === 'string') return j;
  } catch {}
  return null;
}

export interface ServeOpts {
  paths: Paths;
  port?: number;           // 0 picks a free port (tests)
  token?: string;
  snapshotMs?: number;
  idleMs?: number;
  /** Fixed identity for tests; otherwise recomputed on every look, since ancestors can exit. */
  self?: Self;
  onIdle?: () => void;
}

export interface Running {
  info: ServerInfo;
  close: () => Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

const isInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** Validate an untrusted POST /kill body. */
export function parseKillRequest(body: unknown): KillRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const t = b.target;
  let target: Target;
  if (t?.kind === 'group' && isInt(t.sid) && (t.sessionId === null || typeof t.sessionId === 'string')) {
    target = { kind: 'group', sessionId: t.sessionId, sid: t.sid };
  } else if (t?.kind === 'process' && isInt(t.pid) && isInt(t.starttime)) {
    target = { kind: 'process', pid: t.pid, starttime: t.starttime };
  } else {
    return null;
  }
  if (!Array.isArray(b.expect) || !b.expect.every((e: any) => isInt(e?.pid) && isInt(e?.starttime))) return null;
  if (b.confirm !== undefined && typeof b.confirm !== 'string') return null;
  return { target, expect: b.expect.map((e: any) => ({ pid: e.pid, starttime: e.starttime })), confirm: b.confirm };
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function serve(opts: ServeOpts): Promise<Running> {
  const { paths } = opts;
  const token = opts.token ?? newToken();
  const snapshotMs = opts.snapshotMs ?? 2000;
  const idleMs = opts.idleMs ?? 10 * 60 * 1000;
  const self = () => opts.self ?? selfOf(process.pid, paths);
  const html = fs.readFileSync(UI_FILE, 'utf8');
  const clients = new Set<http.ServerResponse>();
  let lastActivity = Date.now();
  let port = 0;

  const snapshot = () => buildSnapshot(observe(paths, self()));
  const broadcast = () => {
    if (!clients.size) return;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(data);
  };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only our own loopback origin is ever answered.
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'forbidden host');
      const url = new URL(req.url ?? '/', `http://${host}`);
      lastActivity = Date.now();

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { app: 'claude-watch', pid: process.pid, procStart: readStarttime(process.pid, paths.procRoot) });
      }

      const queryOk = safeEqual(url.searchParams.get('t') ?? '', token);

      if (req.method === 'GET' && url.pathname === '/') {
        if (!queryOk) return send(res, 403, 'claude-watch: missing or wrong token. Run `claude-watch open` for the right URL.');
        return send(res, 200, html, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'",
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
        });
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        if (!queryOk) return send(res, 403, 'forbidden');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => { clients.delete(res); lastActivity = Date.now(); });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/kill') {
        // Cross-site requests fail here: a custom header and a JSON body force a CORS preflight,
        // which is never answered, and the Origin must be our own.
        if (!safeEqual(String(req.headers['x-claude-watch-token'] ?? ''), token)) return send(res, 403, { error: 'bad token' });
        if (req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'bad origin' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'expected application/json' });
        let parsed: unknown;
        try { parsed = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const kreq = parseKillRequest(parsed);
        if (!kreq) return send(res, 400, { error: 'invalid kill request' });
        const result = await executeKill(kreq, {
          look: () => world(observe(paths, self())),
          procRoot: paths.procRoot,
          logFile: actionsLog(paths),
        });
        send(res, 200, result);
        broadcast();
        return;
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String((e as Error)?.message ?? e) });
      else res.end();
    }
  });

  const tick = setInterval(broadcast, snapshotMs);
  const idle = setInterval(() => {
    if (!clients.size && Date.now() - lastActivity > idleMs) opts.onIdle?.();
  }, Math.min(30_000, idleMs));

  const info = (): ServerInfo => ({ pid: process.pid, procStart: readStarttime(process.pid, paths.procRoot) ?? 0, port, token });

  const close = () => new Promise<void>((resolve) => {
    clearInterval(tick);
    clearInterval(idle);
    for (const c of clients) c.end();
    // Only remove server.json if it still describes this server.
    if (readServerInfo(paths)?.pid === process.pid) { try { fs.unlinkSync(serverFile(paths)); } catch {} }
    server.close(() => resolve());
    server.closeAllConnections();
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e) => { clearInterval(tick); clearInterval(idle); reject(e); });
    server.listen(opts.port ?? DEFAULT_PORT, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      const i = info();
      fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(serverFile(paths), JSON.stringify(i), { mode: 0o600 });
      resolve({ info: i, close });
    });
  });
}
