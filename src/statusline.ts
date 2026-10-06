import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { buildSnapshot } from './core/model.ts';
import { observe, selfOf } from './core/observe.ts';
import { statuslineCache, type Paths } from './core/paths.ts';
import { dashboardUrl } from './server.ts';
import { ensureServer, findServer } from './launch.ts';

/**
 * The status line segment: a clickable "claude-watch" link to the dashboard (OSC 8), with the
 * number of ghost groups when there are any. Claude Code runs it after every update and on its
 * refresh interval, so it must stay fast: the server check is one `ps`, and the ghost count (a
 * full snapshot) is cached for a few seconds and shared by all sessions.
 */

const GHOST_TTL_MS = 15_000;

/** OSC 8: `text`, clickable, opening `url`. */
export const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

export function renderSegment(s: { url: string | null; ghosts: number | null; error?: string }): string {
  if (!s.url) return dim(`claude-watch: off${s.error ? ` (${s.error})` : ''}`);
  if (!s.ghosts) return dim(link(s.url, 'claude-watch'));
  return yellow(link(s.url, `claude-watch: ${s.ghosts} ghost${s.ghosts === 1 ? '' : 's'}`));
}

/** Ghost groups right now, from a cache younger than GHOST_TTL_MS when there is one. Null on failure. */
export function ghostCount(paths: Paths, sessionId?: string, now = Date.now()): number | null {
  const file = statuslineCache(paths);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof c.ghosts === 'number' && now - c.at >= 0 && now - c.at < GHOST_TTL_MS) return c.ghosts;
  } catch {}
  try {
    // The calling session may not have written its record yet; it is never a ghost.
    const assumeLive = sessionId ? [sessionId.toLowerCase()] : [];
    const ghosts = buildSnapshot(observe(paths, selfOf(process.pid, paths, assumeLive))).groups.filter((g) => g.status === 'ghost').length;
    fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ at: now, ghosts }), { mode: 0o600 });
    return ghosts;
  } catch {
    return null;
  }
}

/**
 * The segment for one status line run. If the dashboard is not running (it exits after 10 idle
 * minutes), it is started again, so the link always works while a session is open.
 */
export async function statusSegment(paths: Paths, stdin: string, ensure: () => Promise<{ url: string }> = () => ensureServer(paths)): Promise<string> {
  let input: { session_id?: string } = {};
  try { input = JSON.parse(stdin || '{}'); } catch {}
  let url: string | null = null;
  let error: string | undefined;
  const running = findServer(paths);
  if (running) url = dashboardUrl(running);
  else {
    try { url = (await ensure()).url; } catch (e) { error = String((e as Error)?.message ?? e).split(';')[0]; }
  }
  return renderSegment({ url, ghosts: ghostCount(paths, input.session_id), error });
}

/** Run another status line command with the same input; its stdout, or '' if it fails. */
export function runWrapped(command: string, stdin: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/** The whole status line: the wrapped command's output (if any), then our segment on its own line. */
export async function statusLine(paths: Paths, stdin: string, wrap?: string, ensure?: () => Promise<{ url: string }>): Promise<string> {
  const wrapped = wrap ? runWrapped(wrap, stdin) : Promise.resolve('');
  const segment = await statusSegment(paths, stdin, ensure);
  const before = (await wrapped).replace(/\s+$/, '');
  return before ? `${before}\n${segment}` : segment;
}
