import type { Snapshot } from './core/model.ts';
import { describeGroup, ghostReport, userNote } from './hook.ts';

/** One group as `list --json` reports it: what a front end (the Claude mod) needs to show and kill it. */
export interface ReportGroup {
  id: string;
  sid: number;
  sessionId: string | null;
  sessionName?: string;
  status: Snapshot['groups'][number]['status'];
  /** The leaf command and ports, as the hook and dashboard describe it. */
  label: string;
  ports: number[];
  startedAt: number;
  killable: boolean;
  refusal?: string;
  /** The exact processes seen, for `kill <sid> --expect` (refused if the group changed since). */
  expect: string;
}

export interface Report {
  takenAt: number;
  url: string | null;
  /** Why there is no URL, when there is none. */
  error?: string;
  ghosts: number;
  groups: ReportGroup[];
  /** The one-line note for the person, and the note for Claude, as the SessionStart hook writes them. */
  userNote: string;
  context: string;
}

export function buildReport(s: Snapshot, url: string | null, error?: string): Report {
  const names = new Map(s.sessions.map((v) => [v.sessionId, v.name]));
  const shown = url ?? `(not started: ${error || 'unknown error'})`;
  return {
    takenAt: s.takenAt,
    url,
    ...(url ? {} : { error: error || 'not running' }),
    ghosts: s.groups.filter((g) => g.status === 'ghost').length,
    groups: s.groups.map((g) => ({
      id: g.id,
      sid: g.sid,
      sessionId: g.sessionId,
      ...(g.sessionId && names.get(g.sessionId) ? { sessionName: names.get(g.sessionId) } : {}),
      status: g.status,
      label: describeGroup(g),
      ports: [...new Set(g.members.flatMap((m) => m.ports))],
      startedAt: Math.min(...g.members.map((m) => m.startedAt)),
      killable: g.killable,
      ...(g.refusal ? { refusal: g.refusal } : {}),
      expect: g.members.map((m) => `${m.pid}:${m.starttime}`).join(','),
    })),
    userNote: userNote(s, shown),
    context: ghostReport(s, shown),
  };
}

/** Parse `--expect pid:starttime,...`; null if malformed. */
export function parseExpect(arg: string): { pid: number; starttime: number }[] | null {
  const out = arg.split(',').map((x) => {
    const [pid, starttime] = x.split(':').map(Number);
    return { pid, starttime };
  });
  return out.length && out.every((m) => Number.isSafeInteger(m.pid) && m.pid > 0 && Number.isSafeInteger(m.starttime) && m.starttime >= 0) ? out : null;
}
