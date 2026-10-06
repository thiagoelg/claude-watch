import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Changes to settings files outside this repo: Claude Code's settings.json (hook, status line)
 * and ccstatusline's settings.json (widget). Every change keeps the rest of the file as it is,
 * copies the old file to `<file>.bak-<ms>` first, and replaces it in one rename.
 */

export type InstallResult =
  | { outcome: 'installed'; backup?: string }
  | { outcome: 'already-installed' }
  | { outcome: 'refused'; reason: string };

/** What a change does to the parsed file: changes it in place, or says why it is not needed. */
type Change = (settings: any) => { outcome: 'change' } | Exclude<InstallResult, { outcome: 'installed' }>;

const isObject = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);

function updateJsonFile(file: string, change: Change, opts: { mustExist?: boolean } = {}): InstallResult {
  let text: string | null = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  if (text === null && opts.mustExist) return { outcome: 'refused', reason: `${file} does not exist` };
  let settings: any = {};
  if (text !== null && text.trim()) {
    try { settings = JSON.parse(text); } catch { return { outcome: 'refused', reason: `${file} is not valid JSON` }; }
  }
  if (!isObject(settings)) return { outcome: 'refused', reason: `${file} is not a JSON object` };
  const r = change(settings);
  if (r.outcome !== 'change') return r;

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

/** Quote one argument for sh. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---- SessionStart hook ----

/** The settings.json fragment that runs `command` on every SessionStart. */
export const hookEntry = (command: string) => ({ hooks: [{ type: 'command', command, timeout: 10 }] });

const OUR_HOOK = /cli\.ts"? hook$|claude-watch hook$/;

/** Add the SessionStart hook. Refuses a different claude-watch hook (another checkout). */
export function installHook(file: string, command: string): InstallResult {
  return updateJsonFile(file, (settings) => {
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
    return { outcome: 'change' };
  });
}

// ---- Claude Code status line ----

const OUR_STATUSLINE = /cli\.ts"? statusline\b|claude-watch statusline\b/;

/** The statusLine command: ours, wrapping the existing one if there is one. */
export const statusLineCommand = (base: string, existing?: string) =>
  existing ? `${base} --wrap ${shellQuote(existing)}` : base;

/**
 * Point Claude Code's statusLine at `claude-watch statusline`. An existing status line command
 * keeps running: ours wraps it and adds its link on a line of its own. Sets a refresh interval
 * if there is none, so the ghost count stays current while the session is idle.
 */
export function installStatusLine(file: string, base: string): InstallResult {
  return updateJsonFile(file, (settings) => {
    const current = settings.statusLine;
    if (current !== undefined && !isObject(current)) return { outcome: 'refused', reason: '"statusLine" is not an object' };
    const existing = typeof current?.command === 'string' && current.command.trim() ? current.command : undefined;
    if (existing && OUR_STATUSLINE.test(existing)) {
      return existing.startsWith(base) ? { outcome: 'already-installed' }
        : { outcome: 'refused', reason: `a different claude-watch status line is already installed (${existing}); remove it first` };
    }
    if (current && current.type !== undefined && current.type !== 'command') return { outcome: 'refused', reason: `statusLine type "${current.type}" is not a command` };
    settings.statusLine = { ...current, type: 'command', command: statusLineCommand(base, existing), refreshInterval: current?.refreshInterval ?? 10 };
    return { outcome: 'change' };
  });
}

// ---- ccstatusline widget ----

export const ccstatuslineSettings = () => path.join(os.homedir(), '.config', 'ccstatusline', 'settings.json');

/**
 * Add a Custom Command widget running `claude-watch statusline` to the end of ccstatusline's first
 * line. preserveColors keeps the link escape codes; the timeout leaves room for a ghost recount.
 */
export function installCcstatuslineWidget(file: string, command: string): InstallResult {
  return updateJsonFile(file, (settings) => {
    if (!Array.isArray(settings.lines)) return { outcome: 'refused', reason: `${file} has no "lines" list; run ccstatusline once to create it` };
    const items: Record<string, any>[] = settings.lines.flat().filter(isObject);
    const ours = items.find((w) => w.type === 'custom-command' && typeof w.commandPath === 'string' && OUR_STATUSLINE.test(w.commandPath));
    if (ours) {
      return ours.commandPath === command ? { outcome: 'already-installed' }
        : { outcome: 'refused', reason: `a different claude-watch widget is already installed (${ours.commandPath}); remove it first` };
    }
    if (!Array.isArray(settings.lines[0])) settings.lines[0] = [];
    const first = settings.lines[0];
    if (first.length) first.push({ id: crypto.randomUUID(), type: 'separator' });
    first.push({ id: crypto.randomUUID(), type: 'custom-command', commandPath: command, preserveColors: true, timeout: 2000 });
    return { outcome: 'change' };
  }, { mustExist: true });
}
