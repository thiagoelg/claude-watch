import { buildSnapshot, type Group, type Snapshot } from './core/model.ts';
import { observe, selfOf } from './core/observe.ts';
import type { Paths } from './core/paths.ts';

interface HookInput {
  session_id?: string;
  source?: string;
}

const REPORT_ON = new Set(['startup', 'resume']);

/** A short human label for a group: its most specific command, plus any listening ports. */
export function describeGroup(g: Group): string {
  // The shell wrapper's cmdline is Claude's long snapshot-sourcing line; the leaf command is what
  // the user recognises.
  const leaf = [...g.members].reverse().find((m) => !m.cmdline.includes('shell-snapshots')) ?? g.members[0];
  let cmd = leaf?.cmdline ?? '?';
  if (cmd.length > 50) cmd = cmd.slice(0, 49) + '…';
  const ports = [...new Set(g.members.flatMap((m) => m.ports))];
  return ports.length ? `${cmd} on ${ports.map((p) => ':' + p).join(', ')}` : cmd;
}

export function ghostReport(s: Snapshot, url: string): string {
  const ghosts = s.groups.filter((g) => g.status === 'ghost');
  if (!ghosts.length) return `claude-watch dashboard (processes started by Claude Code): ${url}`;
  const sessions = new Set(ghosts.map((g) => g.sessionId));
  const shown = ghosts.slice(0, 3).map(describeGroup).join('; ');
  const more = ghosts.length > 3 ? `; and ${ghosts.length - 3} more` : '';
  return [
    `claude-watch: ${ghosts.length} ghost process group(s) left running by ${sessions.size} Claude Code session(s) that have ended: ${shown}${more}.`,
    `They can be reviewed and killed from the dashboard: ${url}`,
    'Mention this to the user if it is relevant (for example a port they need is taken); do not kill them unasked.',
  ].join('\n');
}

/**
 * The SessionStart hook. Returns what to print on stdout (or null). Never throws: a failing hook
 * must not get in the way of a session starting.
 */
export async function runHook(stdin: string, paths: Paths, ensure: () => Promise<{ url: string }>, env = process.env): Promise<string | null> {
  let input: HookInput = {};
  try { input = JSON.parse(stdin || '{}'); } catch {}

  let url = '';
  try { url = (await ensure()).url; } catch {}

  if (!REPORT_ON.has(input.source ?? 'startup')) return null;

  try {
    // The new session may not have written its record yet: without this, its own processes
    // (this hook, its shell) would be reported as ghosts.
    const assumeLive = [input.session_id, env.CLAUDE_CODE_SESSION_ID].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    const snap = buildSnapshot(observe(paths, selfOf(process.pid, paths, assumeLive)));
    const additionalContext = ghostReport(snap, url || '(failed to start; run `claude-watch open`)');
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
  } catch {
    return null;
  }
}
