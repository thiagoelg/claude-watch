import path from 'node:path';
import type { Port, Proc } from './proc.ts';
import { liveSessions, type SessionRecord } from './sessions.ts';

export type Status = 'active' | 'ghost' | 'unattributed';

export interface Member {
  pid: number;
  starttime: number;
  ppid: number;
  cmdline: string;
  cwd: string;
  startedAt: number;
  rssKb: number;
  ports: number[];
  role: 'claude' | 'command';
  /** Set when this process can never be signalled (it is Claude, or this tool, or its ancestor). */
  protectedReason?: string;
  /** Whether this single process may be killed on its own (same checks as a single-process kill). */
  killable: boolean;
}

export interface Group {
  id: string;                  // `${sessionId ?? 'none'}:${sid}`
  sessionId: string | null;
  sid: number;
  status: Status;
  members: Member[];
  killable: boolean;
  refusal?: string;
}

export interface SessionView {
  sessionId: string;
  name?: string;
  cwd?: string;
  live: boolean;
  claudePid?: number;
}

export interface Snapshot {
  takenAt: number;
  sessions: SessionView[];
  groups: Group[];
}

export interface Self {
  pid: number;
  ancestors: number[];
  /** Session ids to treat as live even without a live record (the hook's own new session). */
  assumeLive?: string[];
}

export interface Input {
  procs: Proc[];
  records: SessionRecord[];
  ports: Map<number, Port>;
  self: Self;
}

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_RUNTIMES = new Set(['node', 'bun', 'deno']);

export const isClaudeStarted = (p: Proc) => p.env?.CLAUDECODE === '1';

export function sessionOf(p: Proc): string | null {
  const s = p.env?.CLAUDE_CODE_SESSION_ID;
  return s && SESSION_RE.test(s) ? s.toLowerCase() : null;
}

export const groupId = (sessionId: string | null, sid: number) => `${sessionId ?? 'none'}:${sid}`;

/** Everything the pure checks need to know about the world, derived once per snapshot. */
export interface World {
  procs: Map<number, Proc>;
  live: Map<string, SessionRecord>;
  claudeExes: Set<string>;
  self: Self;
}

export function world(input: Pick<Input, 'procs' | 'records' | 'self'>): World {
  const procs = new Map(input.procs.map((p) => [p.pid, p]));
  const live = liveSessions(input.records, procs);
  const claudeExes = new Set<string>();
  for (const r of live.values()) {
    const exe = procs.get(r.pid)?.exe;
    // A Claude running under a generic runtime would make every node/bun/deno process look like
    // Claude, so only a dedicated binary's exe is used for matching.
    if (exe && !GENERIC_RUNTIMES.has(path.basename(exe))) claudeExes.add(exe);
  }
  return { procs, live, claudeExes, self: input.self };
}

export function isLiveSession(w: World, sessionId: string | null): boolean {
  return !!sessionId && (w.live.has(sessionId) || !!w.self.assumeLive?.includes(sessionId));
}

/** A live session's own process, or anything running the same dedicated Claude binary. */
export function claudeReason(w: World, p: Proc): string | undefined {
  for (const r of w.live.values()) if (r.pid === p.pid) return 'is a Claude Code session process';
  if (p.exe && w.claudeExes.has(p.exe)) return 'runs the Claude Code binary';
  return undefined;
}

/** Why this process must never be signalled, or undefined if it may be. */
export function protectedReason(w: World, p: Proc): string | undefined {
  const claude = claudeReason(w, p);
  if (claude) return claude;
  if (p.pid === w.self.pid) return 'is claude-watch itself';
  if (w.self.ancestors.includes(p.pid)) return 'is an ancestor of claude-watch';
  return undefined;
}

export function statusOf(w: World, sessionId: string | null): Status {
  if (!sessionId) return 'unattributed';
  return isLiveSession(w, sessionId) ? 'active' : 'ghost';
}

/**
 * Per-process eligibility (spec checks 2 and 3): Claude-started, attributed to `sessionId`, not protected.
 * Returns the reason it is not eligible, or undefined.
 */
export function memberRefusal(w: World, p: Proc, sessionId: string | null): string | undefined {
  if (p.uid !== process.getuid?.()) return `pid ${p.pid} belongs to another user`;
  if (!isClaudeStarted(p)) return `pid ${p.pid} was not started by Claude Code`;
  const s = sessionOf(p);
  if (!s || !sessionId) return `pid ${p.pid} has no session id`;
  if (s !== sessionId) return `pid ${p.pid} belongs to a different session`;
  const prot = protectedReason(w, p);
  return prot ? `pid ${p.pid} ${prot}` : undefined;
}

/** The members of group (sessionId, sid) in this world, sorted by pid. */
export function groupProcs(w: World, sessionId: string | null, sid: number): Proc[] {
  return [...w.procs.values()]
    .filter((p) => isClaudeStarted(p) && p.sid === sid && sessionOf(p) === sessionId)
    .sort((a, b) => a.pid - b.pid);
}

/**
 * Processes that share the sid but are NOT part of the group: a group kill must not proceed if the
 * sid also holds processes from elsewhere, since they would be left in a half-killed tree.
 */
export function sidStrangers(w: World, sessionId: string | null, sid: number): Proc[] {
  return [...w.procs.values()].filter((p) => p.sid === sid && !(isClaudeStarted(p) && sessionOf(p) === sessionId));
}

/** Group-level refusal (spec checks 2-4, without the stale-view check, which needs the request). */
export function groupRefusal(w: World, sessionId: string | null, sid: number): string | undefined {
  const status = statusOf(w, sessionId);
  if (status === 'unattributed') return 'processes without a Claude session id are never killed';
  if (sid <= 1) return 'session id 1 is init';
  const members = groupProcs(w, sessionId, sid);
  if (!members.length) return 'the group no longer exists';
  for (const p of members) {
    const r = memberRefusal(w, p, sessionId);
    if (r) return r;
  }
  const strangers = sidStrangers(w, sessionId, sid);
  if (strangers.length) return `sid ${sid} also contains ${strangers.length} process(es) from outside this session`;
  return undefined;
}

export function buildSnapshot(input: Input): Snapshot {
  const w = world(input);
  const portsByPid = (p: Proc) => [...new Set(p.socketInodes.map((i) => input.ports.get(i)?.port).filter((x): x is number => x !== undefined))].sort((a, b) => a - b);

  const groups = new Map<string, Group>();
  for (const p of w.procs.values()) {
    if (!isClaudeStarted(p)) continue;
    const sessionId = sessionOf(p);
    const id = groupId(sessionId, p.sid);
    let g = groups.get(id);
    if (!g) {
      g = { id, sessionId, sid: p.sid, status: statusOf(w, sessionId), members: [], killable: false };
      groups.set(id, g);
    }
    const prot = protectedReason(w, p);
    g.members.push({
      pid: p.pid, starttime: p.starttime, ppid: p.ppid, cmdline: p.cmdline || p.comm, cwd: p.cwd,
      startedAt: p.startedAt, rssKb: p.rssKb, ports: portsByPid(p),
      role: claudeReason(w, p) ? 'claude' : 'command',
      protectedReason: prot,
      killable: g.status !== 'unattributed' && !memberRefusal(w, p, sessionId),
    });
  }

  for (const g of groups.values()) {
    g.members.sort((a, b) => a.pid - b.pid);
    g.refusal = groupRefusal(w, g.sessionId, g.sid);
    g.killable = !g.refusal;
  }

  // Live Claude processes usually lack CLAUDECODE=1 themselves; show them as their session's anchor.
  const sessions = new Map<string, SessionView>();
  for (const r of w.live.values()) {
    sessions.set(r.sessionId, { sessionId: r.sessionId, name: r.name, cwd: r.cwd, live: true, claudePid: r.pid });
  }
  for (const g of groups.values()) {
    if (g.sessionId && !sessions.has(g.sessionId)) {
      sessions.set(g.sessionId, { sessionId: g.sessionId, live: isLiveSession(w, g.sessionId) });
    }
  }
  // Dead sessions keep their name if a stale record still names them.
  for (const r of input.records) {
    const s = sessions.get(r.sessionId);
    if (s && !s.name && r.name) { s.name = r.name; s.cwd ??= r.cwd; }
  }

  const order: Record<Status, number> = { ghost: 0, active: 1, unattributed: 2 };
  return {
    takenAt: Date.now(),
    sessions: [...sessions.values()].sort((a, b) => Number(a.live) - Number(b.live) || (a.name ?? '').localeCompare(b.name ?? '')),
    groups: [...groups.values()].sort((a, b) => order[a.status] - order[b.status] || a.sid - b.sid),
  };
}
