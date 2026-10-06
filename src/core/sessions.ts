import fs from 'node:fs';
import path from 'node:path';
import type { Proc } from './proc.ts';

/** ~/.claude/sessions/<pid>.json, written by every Claude Code session root. */
export interface SessionRecord {
  pid: number;
  procStart: string;   // the /proc/PID/stat starttime, as a string
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

/**
 * A record is live only if its pid exists AND that process's starttime equals procStart.
 * Records outlive crashed sessions, and the pid may since belong to an unrelated process.
 */
export function isLive(rec: SessionRecord, procs: Map<number, Proc>): boolean {
  const p = procs.get(rec.pid);
  return !!p && rec.procStart !== '' && String(p.starttime) === rec.procStart;
}

/** sessionId -> its live record. */
export function liveSessions(records: SessionRecord[], procs: Map<number, Proc>): Map<string, SessionRecord> {
  const out = new Map<string, SessionRecord>();
  for (const r of records) if (isLive(r, procs)) out.set(r.sessionId, r);
  return out;
}
