import fs from 'node:fs';
import path from 'node:path';
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
  let why = '';
  try { url = (await ensure()).url; } catch (e) { why = String((e as Error)?.message ?? e); }

  if (!REPORT_ON.has(input.source ?? 'startup')) return null;

  try {
    // The new session may not have written its record yet: without this, its own processes
    // (this hook, its shell) would be reported as ghosts.
    const assumeLive = [input.session_id, env.CLAUDE_CODE_SESSION_ID].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    const snap = buildSnapshot(observe(paths, selfOf(process.pid, paths, assumeLive)));
    const additionalContext = ghostReport(snap, url || `(not started: ${why || 'unknown error'})`);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
  } catch {
    return null;
  }
}

/** The settings.json fragment that runs `command` on every SessionStart. */
export const hookEntry = (command: string) => ({ hooks: [{ type: 'command', command, timeout: 10 }] });

const OUR_HOOK = /cli\.ts"? hook$|claude-watch hook$/;

export type InstallResult =
  | { outcome: 'installed'; backup?: string }
  | { outcome: 'already-installed' }
  | { outcome: 'refused'; reason: string };

/**
 * Add the SessionStart hook to a Claude Code settings file. Every other setting stays as it is.
 * The old file is copied to `<file>.bak-<ms>` first, and the new one replaces it in one rename.
 * Refuses a file that is not a JSON object, and a different claude-watch hook (another checkout).
 */
export function installHook(file: string, command: string): InstallResult {
  let text: string | null = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  let settings: any = {};
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text); } catch { return { outcome: 'refused', reason: `${file} is not valid JSON` }; }
  }
  const isObject = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!isObject(settings)) return { outcome: 'refused', reason: `${file} is not a JSON object` };
  settings.hooks ??= {};
  if (!isObject(settings.hooks)) return { outcome: 'refused', reason: '"hooks" is not an object' };
  settings.hooks.SessionStart ??= [];
  const entries = settings.hooks.SessionStart;
  if (!Array.isArray(entries)) return { outcome: 'refused', reason: '"hooks.SessionStart" is not a list' };

  const commands: string[] = entries.flatMap((e: any) => (Array.isArray(e?.hooks) ? e.hooks : []).map((h: any) => h?.command)).filter((c: unknown) => typeof c === 'string');
  if (commands.includes(command)) return { outcome: 'already-installed' };
  const other = commands.find((c) => OUR_HOOK.test(c));
  if (other) return { outcome: 'refused', reason: `a different claude-watch hook is already installed (${other}); remove it first` };

  entries.push(hookEntry(command));
  let backup: string | undefined;
  let mode = 0o600;
  if (text !== null) {
    backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    mode = fs.statSync(file).mode & 0o777;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.claude-watch-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  return { outcome: 'installed', backup };
}
