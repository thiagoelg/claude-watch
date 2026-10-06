import fs from 'node:fs';
import path from 'node:path';

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  uid: number;
  starttime: number;   // /proc/PID/stat field 22: clock ticks since boot
  startedAt: number;   // wall-clock ms
  rssKb: number;
  state: string;
  comm: string;
  cmdline: string;
  exe: string;
  cwd: string;
  env: Record<string, string> | null;   // null when unreadable
  socketInodes: number[];
}

export interface Port {
  port: number;
  addr: string;
  proto: 'tcp' | 'tcp6';
}

const CLK_TCK = 100;      // USER_HZ; 100 on every mainstream Linux build
const PAGE_KB = 4;

export interface StatFields {
  comm: string;
  state: string;
  ppid: number;
  pgid: number;
  sid: number;
  starttime: number;
  rssPages: number;
}

/**
 * Parse /proc/PID/stat. comm (field 2) may contain spaces and parentheses, so the fixed fields are
 * everything after the LAST ')'. After it, index i holds proc(5) field i + 3.
 */
export function parseStat(raw: string): StatFields | null {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = raw.slice(close + 1).trim().split(/\s+/);
  if (f.length < 22) return null;
  return {
    comm: raw.slice(open + 1, close),
    state: f[0],
    ppid: Number(f[1]),
    pgid: Number(f[2]),
    sid: Number(f[3]),
    starttime: Number(f[19]),
    rssPages: Number(f[21]),
  };
}

/** Just the starttime of a pid, or null if it no longer exists. Used to re-verify identity. */
export function readStarttime(pid: number, root = '/proc'): number | null {
  try {
    return parseStat(fs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8'))?.starttime ?? null;
  } catch {
    return null;
  }
}

export function bootTimeMs(root = '/proc'): number {
  try {
    const up = Number.parseFloat(fs.readFileSync(path.join(root, 'uptime'), 'utf8').split(' ')[0]);
    return Date.now() - up * 1000;
  } catch {
    return Date.now();
  }
}

function tryRead(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function tryLink(p: string): string {
  try { return fs.readlinkSync(p); } catch { return ''; }
}

export function parseEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

/**
 * Read one process. Returns null if it vanished mid-read or is owned by another uid.
 * Socket fds are only read when `withSockets` is set, since walking every fd is the expensive part.
 */
export function readProc(pid: number, opts: { root?: string; uid?: number; boot?: number; withSockets?: boolean } = {}): Proc | null {
  const root = opts.root ?? '/proc';
  const dir = path.join(root, String(pid));
  const stat = tryRead(path.join(dir, 'stat'));
  const s = stat ? parseStat(stat) : null;
  if (!s) return null;

  let uid: number;
  try { uid = fs.statSync(dir).uid; } catch { return null; }
  if (opts.uid !== undefined && uid !== opts.uid) return null;

  const envRaw = tryRead(path.join(dir, 'environ'));
  const boot = opts.boot ?? bootTimeMs(root);
  return {
    pid,
    ppid: s.ppid,
    pgid: s.pgid,
    sid: s.sid,
    uid,
    starttime: s.starttime,
    startedAt: Math.round(boot + (s.starttime / CLK_TCK) * 1000),
    rssKb: s.rssPages * PAGE_KB,
    state: s.state,
    comm: s.comm,
    cmdline: (tryRead(path.join(dir, 'cmdline')) ?? '').replace(/\0+$/, '').replace(/\0/g, ' '),
    exe: tryLink(path.join(dir, 'exe')),
    cwd: tryLink(path.join(dir, 'cwd')),
    env: envRaw === null ? null : parseEnviron(envRaw),
    socketInodes: opts.withSockets ? socketInodes(dir) : [],
  };
}

function socketInodes(dir: string): number[] {
  const out: number[] = [];
  let fds: string[];
  try { fds = fs.readdirSync(path.join(dir, 'fd')); } catch { return out; }
  for (const fd of fds) {
    const m = /^socket:\[(\d+)\]$/.exec(tryLink(path.join(dir, 'fd', fd)));
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Every process owned by `uid` (default: the current uid). Socket inodes are read only for
 * processes that `wantSockets` accepts.
 */
export function readProcs(opts: { root?: string; uid?: number; wantSockets?: (p: Proc) => boolean } = {}): Proc[] {
  const root = opts.root ?? '/proc';
  const uid = opts.uid ?? process.getuid?.();
  const boot = bootTimeMs(root);
  const out: Proc[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return out; }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    const p = readProc(Number(d), { root, uid, boot });
    if (!p) continue;
    if (opts.wantSockets?.(p)) p.socketInodes = socketInodes(path.join(root, d));
    out.push(p);
  }
  return out;
}

/** Parse one /proc/net/tcp{,6} table into LISTEN sockets keyed by inode. */
export function parseNetTcp(raw: string, proto: 'tcp' | 'tcp6'): Map<number, Port> {
  const out = new Map<number, Port>();
  for (const line of raw.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;           // 0A = TCP_LISTEN
    const [addrHex, portHex] = f[1].split(':');
    out.set(Number(f[9]), { port: Number.parseInt(portHex, 16), addr: decodeAddr(addrHex), proto });
  }
  return out;
}

function decodeAddr(hex: string): string {
  if (hex.length === 8) {
    // IPv4 is stored as a little-endian 32-bit word.
    return [6, 4, 2, 0].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join('.');
  }
  if (/^0+$/.test(hex)) return '::';
  if (hex === '00000000000000000000000001000000') return '::1';
  return 'ipv6';
}

export function listeningPorts(root = '/proc'): Map<number, Port> {
  const out = new Map<number, Port>();
  for (const proto of ['tcp', 'tcp6'] as const) {
    const raw = tryRead(path.join(root, 'net', proto));
    if (raw) for (const [inode, port] of parseNetTcp(raw, proto)) out.set(inode, port);
  }
  return out;
}

/** pid -> parent chain up to (not including) pid 0. */
export function ancestors(pid: number, root = '/proc'): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  let q = tryRead(path.join(root, String(pid), 'stat'));
  let cur = q ? parseStat(q)?.ppid ?? 0 : 0;
  while (cur > 0 && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    q = tryRead(path.join(root, String(cur), 'stat'));
    cur = q ? parseStat(q)?.ppid ?? 0 : 0;
  }
  return out;
}
