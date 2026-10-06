import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serverFile, serverLog, type Paths } from './core/paths.ts';
import { procSource, type ProcSource } from './core/proc.ts';
import { stillAlive } from './core/kill.ts';
import { DEFAULT_PORT, dashboardUrl, newToken, readServerInfo, type ServerInfo } from './server.ts';

const CLI = path.join(import.meta.dirname, 'cli.ts');

/**
 * The environment the background server runs with. Claude's markers are removed so the dashboard
 * is never itself counted as a Claude-started process (and, once its session ends, a ghost).
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k === 'AI_AGENT' || k.startsWith('CLAUDE_CODE_')) continue;
    out[k] = v;
  }
  return out;
}

/** Whether `pid` itself holds the LISTEN socket for `port`, so nobody else is answering there. */
export function ownsListener(pid: number, port: number, source: ProcSource): boolean {
  const listening = source.listening();
  const p = source.get(pid, { withSockets: true });
  return !!p && p.socketInodes.some((i) => listening.get(i)?.port === port);
}

/**
 * Whether anything is listening on `port`. A bind probe, because on macOS lsof only sees your own
 * processes' sockets, and the program to keep out may belong to another user.
 */
export function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

/**
 * The server described by server.json, if that exact process (pid + starttime) is alive.
 * With `listening`, it must also hold the port itself: proof without trusting whoever answers HTTP.
 */
export function findServer(paths: Paths, opts: { listening?: boolean } = {}, source: ProcSource = procSource(paths)): ServerInfo | null {
  const info = readServerInfo(paths);
  if (!info || !stillAlive({ pid: info.pid, starttime: info.procStart }, source)) return null;
  if (opts.listening && !ownsListener(info.pid, info.port, source)) return null;
  return info;
}

// Waits must be async: the token is still being written to the server's stdin pipe meanwhile.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Return the dashboard URL, starting the server in the background if none is running.
 * The URL is known up front: the token is generated here, handed to the server over a pipe, and
 * recorded in server.json right after the spawn, so concurrent callers all hand out the same one.
 */
export async function ensureServer(paths: Paths, env: NodeJS.ProcessEnv = process.env): Promise<{ url: string; started: boolean }> {
  const source = procSource(paths);
  const existing = findServer(paths, { listening: true }, source);
  if (existing) return { url: dashboardUrl(existing), started: false };

  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(paths.dataDir, 'server.lock');
  let haveLock = false;
  for (let attempt = 0; attempt < 2 && !haveLock; attempt++) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      haveLock = true;
    } catch {
      // Someone else is starting it: wait for their server to be listening.
      for (let i = 0; i < 100; i++) {
        const info = findServer(paths, { listening: true }, source);
        if (info) return { url: dashboardUrl(info), started: false };
        await sleep(25);
      }
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch {}
    }
  }
  if (!haveLock) throw new Error('another claude-watch is starting the dashboard; run `claude-watch open` in a moment');

  try {
    const port = Number(env.CLAUDE_WATCH_PORT) || DEFAULT_PORT;
    // Never hand out a URL (with its token) that would reach someone else's program.
    if (await portTaken(port)) throw new Error(`port ${port} is in use by another program; set CLAUDE_WATCH_PORT`);

    const token = newToken();
    // The server must not inherit our stdout: the hook's caller waits for that pipe to close.
    const log = fs.openSync(serverLog(paths), 'a', 0o600);
    const child = spawn(process.execPath, [CLI, 'serve'], {
      cwd: os.homedir(),
      detached: true,
      stdio: ['pipe', log, log],
      env: {
        ...cleanEnv(env),
        CLAUDE_WATCH_TOKEN_STDIN: '1',
        CLAUDE_WATCH_PORT: String(port),
        CLAUDE_WATCH_DIR: paths.dataDir,
        CLAUDE_WATCH_PROC_ROOT: paths.procRoot,
        CLAUDE_CONFIG_DIR: paths.claudeDir,
      },
    });
    fs.closeSync(log);
    // The token goes over the pipe, not the environment, so it never shows in /proc/<pid>/environ.
    child.stdin!.end(token + '\n');
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();

    const info: ServerInfo = { pid: child.pid!, procStart: source.identity(child.pid!)?.starttime ?? 0, port, token };
    fs.writeFileSync(serverFile(paths), JSON.stringify(info), { mode: 0o600 });

    // The port was free a moment ago, but someone could have taken it since. Only hand out the
    // URL (and its token) once our own process is the one holding the listening socket.
    for (let i = 0; i < 80; i++) {
      if (ownsListener(info.pid, port, source)) return { url: dashboardUrl(info), started: true };
      if (!stillAlive({ pid: info.pid, starttime: info.procStart }, source)) break;
      await sleep(25);
    }
    throw new Error(`the dashboard did not start listening on port ${port}; see ${serverLog(paths)}`);
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}
