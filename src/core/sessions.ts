import fs from 'node:fs';
import path from 'node:path';
import type { Proc } from './proc.ts';

/** ~/.claude/sessions/<pid>.json, written by every Claude Code session root. */
export interface SessionRecord {
  pid: number;
  procStart: string;   // Linux: the /proc/PID/stat starttime, as a string
  startedAt?: number;  // epoch ms
  sessionId: string;
  name?: string;
  cwd?: string;
  kind?: string;
  entrypoint?: string;
}

export function readSessionRecords(dir: string): SessionRecord[] {
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out: SessionRecord[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (typeof r?.pid !== 'number' || typeof r?.sessionId !== 'string') continue;
      out.push({
        pid: r.pid,
        procStart: String(r.procStart ?? ''),
        startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
        sessionId: r.sessionId,
        name: typeof r.name === 'string' ? r.name : undefined,
        cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
        kind: typeof r.kind === 'string' ? r.kind : undefined,
        entrypoint: typeof r.entrypoint === 'string' ? r.entrypoint : undefined,
      });
    } catch {}
  }
  return out;
}

export type StartMatcher = (p: Proc, procStart: string, startedAt?: number) => boolean;

/** Linux semantics: Claude Code records the stat starttime itself, so it must match exactly. */
export const exactStart: StartMatcher = (p, procStart) => procStart !== '' && String(p.starttime) === procStart;

/**
 * A record is live only if its pid exists AND that process's start time matches the record.
 * Records outlive crashed sessions, and the pid may since belong to an unrelated process.
 */
export function isLive(rec: SessionRecord, procs: Map<number, Proc>, matches: StartMatcher = exactStart): boolean {
  const p = procs.get(rec.pid);
  return !!p && matches(p, rec.procStart, rec.startedAt);
}

/** sessionId -> its live record. */
export function liveSessions(records: SessionRecord[], procs: Map<number, Proc>, matches: StartMatcher = exactStart): Map<string, SessionRecord> {
  const out = new Map<string, SessionRecord>();
  for (const r of records) if (isLive(r, procs, matches)) out.set(r.sessionId, r);
  return out;
}
