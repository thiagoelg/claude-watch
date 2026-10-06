/**
 * The macOS process source. macOS has no /proc, so everything comes from `ps` and `lsof`:
 *
 *   ps -axww -o pid=,ppid=,pgid=,uid=,rss=,state=,lstart=,comm=   process table
 *   ps -axww -o pid=,args=          command lines
 *   ps -axwwE -o pid=,args=         command lines followed by the environment
 *   lsof -a -d cwd -Fpn -p <pids>   working directories
 *   lsof -nP -iTCP -sTCP:LISTEN -Fpn   listening sockets
 *
 * Differences from Linux, all deliberate:
 * - Kill unit: macOS `ps` cannot report a process's session id, so the process group stands in
 *   for it. Claude Code spawns commands with `detached: true` (setsid), which also makes the
 *   command its own process group; children inherit it unless a shell with job control moves
 *   them into new groups (those then show up as separate groups).
 * - Identity: `lstart` has one-second resolution, so `starttime` is epoch seconds.
 * - Sockets have no inode: each (pid, port) listener gets a synthetic id, `pid * 65536 + port`.
 *
 * See docs/macos-testing.md for what still has to be verified on a Mac.
 */
import { execFileSync } from 'node:child_process';
import type { Identity, Port, Proc, ProcSource } from './proc.ts';

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const LSTART = /([A-Z][a-z]{2}) ([A-Z][a-z]{2})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})/;

/** `ps -o lstart` ("Tue Oct  6 02:06:36 2026", local time, LC_ALL=C) -> epoch ms. */
export function parseLstart(s: string): number | null {
  const m = LSTART.exec(s);
  if (!m || MONTHS[m[2]] === undefined) return null;
  return new Date(Number(m[7]), MONTHS[m[2]], Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

export interface PsRow {
  pid: number; ppid: number; pgid: number; uid: number; rssKb: number; state: string; startedAt: number; comm: string;
}

const PS_ROW = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(` + LSTART.source + String.raw`)\s+(.*)$`);

/** Parse `ps -axww -o pid=,ppid=,pgid=,uid=,rss=,state=,lstart=,comm=`. */
export function parsePsTable(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = PS_ROW.exec(line);
    if (!m) continue;
    const startedAt = parseLstart(m[7]);
    if (startedAt === null) continue;
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), rssKb: Number(m[5]),
      state: m[6][0], startedAt, comm: m[15].trim(),
    });
  }
  return rows;
}

/** Parse `ps -o pid=,args=` (with or without -E) into pid -> text. */
export function parsePsArgs(out: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

/** The variables attribution relies on. */
const RELIED_ON = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'];

/**
 * `ps -E` prints the environment after the arguments, space-separated, with no quoting. Split
 * the remainder at every " NAME=" boundary. A value containing " X=" is split wrongly; it can even
 * smuggle in a fake "CLAUDE_CODE_SESSION_ID=…". So a relied-on variable that appears more than
 * once is ambiguous and dropped: the process then counts as unattributed (or not Claude-started),
 * which only ever makes it, and any group it is in, less killable.
 * Returns null when there is no environment (ps could not read it).
 */
export function parseEnvSuffix(args: string, withEnv: string): Record<string, string> | null {
  if (!withEnv.startsWith(args)) return null;
  const rest = withEnv.slice(args.length);
  if (!rest.trim()) return null;
  const env: Record<string, string> = {};
  const re = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g;
  const hits: { name: string; start: number; valueStart: number }[] = [];
  for (let m; (m = re.exec(rest));) hits.push({ name: m[1], start: m.index, valueStart: m.index + m[0].length });
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : rest.length;
    env[h.name] = rest.slice(h.valueStart, end);
  });
  for (const name of RELIED_ON) {
    if (hits.filter((h) => h.name === name).length > 1) delete env[name];
  }
  return env;
}

/** Parse `lsof -F` output with p (pid) and n (name) fields into pid -> names. */
export function parseLsofNames(out: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  let pid = -1;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); if (!map.has(pid)) map.set(pid, []); }
    else if (line.startsWith('n') && pid >= 0) map.get(pid)!.push(line.slice(1));
  }
  return map;
}

/** An lsof TCP name ("127.0.0.1:5173", "*:5173", "[::1]:5173") -> Port. */
export function parseLsofAddr(name: string): Port | null {
  const m = /^(.*):(\d+)$/.exec(name);
  if (!m || name.includes('->')) return null;
  const host = m[1];
  const v6 = host.startsWith('[');
  return { port: Number(m[2]), addr: v6 ? host.slice(1, -1) : host === '*' ? '0.0.0.0' : host, proto: v6 ? 'tcp6' : 'tcp' };
}

export const socketId = (pid: number, port: number) => pid * 65536 + port;

/** Listening sockets of `lsof -nP -iTCP -sTCP:LISTEN -Fpn` keyed by synthetic socket id. */
export function listeningFromLsof(out: string): Map<number, Port> {
  const map = new Map<number, Port>();
  for (const [pid, names] of parseLsofNames(out)) {
    for (const n of names) {
      const port = parseLsofAddr(n);
      if (port) map.set(socketId(pid, port.port), port);
    }
  }
  return map;
}

/**
 * Does a session record describe this process? Claude Code's procStart format on macOS is not
 * verified yet, so every plausible encoding of a start time is accepted (epoch s/ms/us, or a
 * date string), and failing those, a process that started within a minute before the record's
 * startedAt. Each variant still rejects a pid recycled hours later.
 */
export function darwinMatchesStart(p: Pick<Proc, 'starttime' | 'startedAt'>, procStart: string, startedAt?: number): boolean {
  const sec = p.starttime;
  if (/^\d+(\.\d+)?$/.test(procStart)) {
    const n = Number(procStart);
    for (const asSec of [n, n / 1e3, n / 1e6]) if (Math.abs(asSec - sec) <= 1) return true;
  } else if (procStart) {
    const t = Date.parse(procStart);
    if (!Number.isNaN(t) && Math.abs(t / 1000 - sec) <= 1) return true;
  }
  if (startedAt !== undefined) return p.startedAt <= startedAt + 2000 && p.startedAt >= startedAt - 60_000;
  return false;
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch (e: any) {
    return typeof e?.stdout === 'string' ? e.stdout : '';   // lsof exits 1 when some pids are gone
  }
}

const TABLE = ['-axww', '-o', 'pid=,ppid=,pgid=,uid=,rss=,state=,lstart=,comm='];

export function darwinSource(): ProcSource {
  const uid = process.getuid?.();

  const cwds = (pids: number[]) => {
    const out = new Map<number, string>();
    if (!pids.length) return out;
    for (const [pid, names] of parseLsofNames(run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]))) out.set(pid, names[0] ?? '');
    return out;
  };
  const listeners = (pids?: number[]) => {
    if (pids && !pids.length) return new Map<number, Port>();
    const args = ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fpn'];
    return listeningFromLsof(run('lsof', pids ? [...args, '-p', pids.join(',')] : args));
  };

  const build = (rows: PsRow[], argsText: Map<number, string>, envText: Map<number, string>): Proc[] =>
    rows.map((r) => {
      const args = argsText.get(r.pid) ?? '';
      return {
        pid: r.pid, ppid: r.ppid, pgid: r.pgid, sid: r.pgid, uid: r.uid,
        starttime: Math.round(r.startedAt / 1000), startedAt: r.startedAt, rssKb: r.rssKb, state: r.state,
        comm: r.comm.split('/').pop() ?? r.comm, cmdline: args, exe: r.comm.startsWith('/') ? r.comm : '',
        cwd: '', env: parseEnvSuffix(args, envText.get(r.pid) ?? ''), socketInodes: [],
      };
    });

  const attach = (procs: Proc[], wanted: Proc[]) => {
    const pids = wanted.map((p) => p.pid);
    const dirs = cwds(pids);
    const sockets = new Map<number, number[]>();
    for (const id of listeners(pids).keys()) {
      const pid = Math.floor(id / 65536);
      sockets.set(pid, [...(sockets.get(pid) ?? []), id]);
    }
    for (const p of wanted) { p.cwd = dirs.get(p.pid) ?? ''; p.socketInodes = sockets.get(p.pid) ?? []; }
    return procs;
  };

  const source: ProcSource = {
    platform: 'darwin',
    list(opts = {}) {
      const rows = parsePsTable(run('ps', TABLE)).filter((r) => r.uid === uid);
      const procs = build(rows, parsePsArgs(run('ps', ['-axww', '-o', 'pid=,args='])), parsePsArgs(run('ps', ['-axwwE', '-o', 'pid=,args='])));
      return attach(procs, procs.filter((p) => opts.wantSockets?.(p)));
    },
    get(pid, opts = {}) {
      const p = String(pid);
      const rows = parsePsTable(run('ps', ['-ww', '-o', TABLE[2], '-p', p])).filter((r) => r.uid === uid);
      if (!rows.length) return null;
      const procs = build(rows, parsePsArgs(run('ps', ['-ww', '-o', 'pid=,args=', '-p', p])), parsePsArgs(run('ps', ['-wwE', '-o', 'pid=,args=', '-p', p])));
      return attach(procs, opts.withSockets ? procs : [])[0];
    },
    identity(pid) {
      const r = parsePsTable(run('ps', ['-ww', '-o', TABLE[2], '-p', String(pid)]))[0];
      return r ? { starttime: Math.round(r.startedAt / 1000), state: r.state } as Identity : null;
    },
    listening: () => listeners(),
    ancestors(pid) {
      const parent = new Map(parsePsTable(run('ps', TABLE)).map((r) => [r.pid, r.ppid]));
      const out: number[] = [];
      for (let cur = parent.get(pid) ?? 0; cur > 0 && !out.includes(cur); cur = parent.get(cur) ?? 0) out.push(cur);
      return out;
    },
    matchesSessionStart: darwinMatchesStart,
  };
  return source;
}
