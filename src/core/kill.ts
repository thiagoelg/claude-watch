import fs from 'node:fs';
import path from 'node:path';
import { parseStat, type Proc } from './proc.ts';
import {
  groupId, groupProcs, groupRefusal, memberRefusal, sessionOf, statusOf,
  type Status, type World,
} from './model.ts';

export type Target =
  | { kind: 'group'; sessionId: string | null; sid: number }
  | { kind: 'process'; pid: number; starttime: number };

export interface Identity { pid: number; starttime: number }

export interface KillRequest {
  target: Target;
  /** The exact members the user was looking at. A group kill is refused if this no longer matches. */
  expect: Identity[];
  /** Required for active sessions: the session name (or its first 8 id characters). */
  confirm?: string;
}

export type Plan =
  | { ok: true; status: Status; sessionId: string; members: Proc[] }
  | { ok: false; status?: Status; refusal: string };

const key = (i: Identity) => `${i.pid}:${i.starttime}`;

/** What an active session's kill confirmation must say. */
export function confirmWord(w: World, sessionId: string): string {
  return w.live.get(sessionId)?.name || sessionId.slice(0, 8);
}

/** Decide, from a fresh view of the world, whether `req` may proceed. Pure. */
export function planKill(w: World, req: KillRequest): Plan {
  let sessionId: string | null;
  let members: Proc[];

  if (req.target.kind === 'group') {
    sessionId = req.target.sessionId;
    const status = statusOf(w, sessionId);
    const refusal = groupRefusal(w, sessionId, req.target.sid);
    if (refusal) return { ok: false, status, refusal };
    members = groupProcs(w, sessionId, req.target.sid);
    const now = new Set(members.map(key));
    const seen = new Set(req.expect.map(key));
    if (now.size !== seen.size || [...now].some((k) => !seen.has(k))) {
      return { ok: false, status, refusal: 'the group changed since you looked; refresh and try again' };
    }
  } else {
    const { pid, starttime } = req.target;
    const p = w.procs.get(pid);
    if (!p || p.starttime !== starttime) return { ok: false, refusal: `pid ${pid} is gone or is now a different process` };
    sessionId = sessionOf(p);
    const refusal = memberRefusal(w, p, sessionId);
    if (refusal) return { ok: false, status: statusOf(w, sessionId), refusal };
    members = [p];
  }

  const status = statusOf(w, sessionId);
  if (status === 'unattributed' || !sessionId) return { ok: false, status, refusal: 'processes without a Claude session id are never killed' };
  if (status === 'active') {
    const want = confirmWord(w, sessionId);
    if (req.confirm !== want) return { ok: false, status, refusal: `this session is still active; confirm by typing "${want}"` };
  }
  return { ok: true, status, sessionId, members };
}

export interface KillResult {
  ok: boolean;
  outcome: 'refused' | 'dry-run' | 'terminated' | 'killed' | 'partial';
  status?: Status;
  refusal?: string;
  members: { pid: number; starttime: number; cmdline: string }[];
  signalled: { pid: number; starttime: number; signal: 'SIGTERM' | 'SIGKILL' }[];
  survivors: number[];
}

export interface KillDeps {
  /** A fresh view of the world. Called before planning and on every poll. */
  look: () => World;
  procRoot: string;
  logFile?: string;
  graceMs?: number;
  pollMs?: number;
  signal?: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void;
}

/**
 * True while `pid` is still the same live process. A zombie has already died; a changed starttime
 * means the pid now belongs to someone else and must never be signalled.
 */
export function stillAlive(id: Identity, procRoot: string): boolean {
  try {
    const s = parseStat(fs.readFileSync(path.join(procRoot, String(id.pid), 'stat'), 'utf8'));
    return !!s && s.starttime === id.starttime && s.state !== 'Z' && s.state !== 'X';
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeKill(req: KillRequest, deps: KillDeps, opts: { dryRun?: boolean } = {}): Promise<KillResult> {
  const graceMs = deps.graceMs ?? 5000;
  const pollMs = deps.pollMs ?? 200;
  const signal = deps.signal ?? ((pid, sig) => { try { process.kill(pid, sig); } catch {} });

  const plan = planKill(deps.look(), req);
  const describe = (ps: Proc[]) => ps.map((p) => ({ pid: p.pid, starttime: p.starttime, cmdline: p.cmdline || p.comm }));

  if (!plan.ok) {
    return finish(deps, req, { ok: false, outcome: 'refused', status: plan.status, refusal: plan.refusal, members: [], signalled: [], survivors: [] });
  }
  if (opts.dryRun) {
    return finish(deps, req, { ok: true, outcome: 'dry-run', status: plan.status, members: describe(plan.members), signalled: [], survivors: [] });
  }

  const tracked = new Map<string, Proc>(plan.members.map((p) => [key(p), p]));
  const signalled: KillResult['signalled'] = [];
  const send = (p: Proc, sig: 'SIGTERM' | 'SIGKILL') => {
    // Re-verify identity immediately before every signal.
    if (!stillAlive(p, deps.procRoot)) return;
    signal(p.pid, sig);
    signalled.push({ pid: p.pid, starttime: p.starttime, signal: sig });
  };

  for (const p of tracked.values()) send(p, 'SIGTERM');

  const survivors = () => [...tracked.values()].filter((p) => stillAlive(p, deps.procRoot));
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    // Children forked after the first signal join the kill only if they pass the same checks.
    if (req.target.kind === 'group') {
      const w = deps.look();
      for (const p of groupProcs(w, plan.sessionId, req.target.sid)) {
        if (!tracked.has(key(p)) && !memberRefusal(w, p, plan.sessionId)) {
          tracked.set(key(p), p);
          send(p, 'SIGTERM');
        }
      }
    }
    if (!survivors().length) break;
  }

  let outcome: KillResult['outcome'] = 'terminated';
  const stubborn = survivors();
  if (stubborn.length) {
    for (const p of stubborn) send(p, 'SIGKILL');
    await sleep(pollMs);
    outcome = 'killed';
  }
  const left = survivors();
  if (left.length) outcome = 'partial';

  return finish(deps, req, {
    ok: !left.length, outcome, status: plan.status, members: describe([...tracked.values()]),
    signalled, survivors: left.map((p) => p.pid),
  });
}

function finish(deps: KillDeps, req: KillRequest, r: KillResult): KillResult {
  if (deps.logFile) {
    const target = req.target.kind === 'group' ? groupId(req.target.sessionId, req.target.sid) : key(req.target);
    try {
      // Command lines can carry secrets (tokens in argv), so the log is private to the user.
      fs.mkdirSync(path.dirname(deps.logFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(deps.logFile, JSON.stringify({ ts: new Date().toISOString(), target, ...r }) + '\n', { mode: 0o600 });
    } catch {}
  }
  return r;
}
