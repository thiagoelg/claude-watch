#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot, world, type Group, type Snapshot } from './core/model.ts';
import { observe, selfOf } from './core/observe.ts';
import { executeKill, type KillRequest } from './core/kill.ts';
import { actionsLog, defaultPaths, settingsFile } from './core/paths.ts';
import { procSource } from './core/proc.ts';
import { DEFAULT_PORT, dashboardUrl, serve } from './server.ts';
import { ensureServer, findServer } from './launch.ts';
import { describeGroup, runHook } from './hook.ts';
import { ccstatuslineSettings, hookEntry, installCcstatuslineWidget, installHook, installStatusLine, type InstallResult } from './install.ts';
import { statusLine } from './statusline.ts';
import { buildReport, parseExpect } from './report.ts';

const USAGE = `usage: claude-watch <command>

  serve                              run the dashboard server in the foreground
  open [--no-browser]                start the server if needed and open the dashboard
  list [--json [--session <id>] [--ensure]]
                                     print every process Claude Code started, by session;
                                     --json for programs (--session: that session is live,
                                     --ensure: start the dashboard if it is not running)
  kill <sid|pid> [--execute] [--confirm <session name>] [--session <id>] [--expect <pid:start,...>]
                                     kill a process group (by sid) or one process (by pid);
                                     dry-run unless --execute; --expect refuses if the group
                                     is no longer exactly those processes
  hook                               the SessionStart hook (reads hook JSON on stdin)
  install-hook [--write]             print the settings.json snippet for the hook;
                                     --write adds it to ~/.claude/settings.json
  statusline [--wrap <command>]      the status line: a clickable dashboard link and the ghost
                                     count, after the output of <command> if given
  install-statusline [--write] [--ccstatusline]
                                     set Claude Code's status line to it (wrapping the one you
                                     have), or add it as a ccstatusline widget; dry run unless --write`;

const paths = defaultPaths();
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/**
 * This node's path, preferring a PATH entry that links to the same binary (e.g. /opt/homebrew/bin/node
 * over /opt/homebrew/Cellar/node/26.8.1/bin/node), so the hook survives a node upgrade.
 */
function stableNodePath(): string {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const self = real(process.execPath);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, path.basename(process.execPath));
    if (self && real(candidate) === self) return candidate;
  }
  return process.execPath;
}

const age = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
};

function sessionLabel(s: Snapshot, id: string | null): string {
  if (!id) return '(no session id)';
  const v = s.sessions.find((x) => x.sessionId === id);
  return v?.name ? `${v.name} (${id.slice(0, 8)})` : id.slice(0, 8);
}

function printList(s: Snapshot): void {
  if (!s.groups.length) { console.log('no processes started by Claude Code are running'); return; }
  for (const g of s.groups) {
    const verdict = g.killable ? 'killable' : `not killable: ${g.refusal}`;
    console.log(`${g.status.toUpperCase().padEnd(12)} ${sessionLabel(s, g.sessionId)}  sid ${g.sid}  [${verdict}]`);
    for (const m of g.members) {
      const ports = m.ports.length ? ` :${m.ports.join(',:')}` : '';
      const tag = m.protectedReason ? ` (${m.protectedReason})` : '';
      console.log(`    ${String(m.pid).padStart(7)}  ${age(m.startedAt).padStart(5)}${ports}  ${m.cmdline.slice(0, 100)}${tag}`);
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Resolve a CLI kill argument to a request, using the snapshot the user is acting on. */
function killRequestFor(s: Snapshot, n: number): KillRequest | string {
  const session = option('--session')?.toLowerCase();
  const confirm = option('--confirm');
  const bySid = s.groups.filter((g) => g.sid === n && (!session || g.sessionId?.startsWith(session)));
  if (bySid.length > 1) {
    return `sid ${n} holds groups from several sessions; pick one with --session: ${bySid.map((g) => g.sessionId ?? 'none').join(', ')}`;
  }
  const expected = option('--expect');
  const seen = expected === undefined ? null : parseExpect(expected);
  if (expected !== undefined && !seen) return `--expect takes pid:starttime pairs separated by commas`;
  const expect = (g: Group) => seen ?? g.members.map((m) => ({ pid: m.pid, starttime: m.starttime }));
  if (bySid.length === 1) {
    const g = bySid[0];
    return { target: { kind: 'group', sessionId: g.sessionId, sid: g.sid }, expect: expect(g), confirm };
  }
  for (const g of s.groups) {
    const m = g.members.find((x) => x.pid === n);
    if (m) return { target: { kind: 'process', pid: m.pid, starttime: m.starttime }, expect: [{ pid: m.pid, starttime: m.starttime }], confirm };
  }
  return `no Claude-started process group or process with id ${n}`;
}

async function main(): Promise<number> {
  const cmd = argv[0];

  if (cmd === 'serve') {
    // Run from inside a Claude Code session, the server would inherit that session's markers:
    // listed under it, and a ghost once it ends. Hand off to the same clean, detached launch the
    // hook uses instead.
    if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_SESSION_ID) {
      try {
        const { url, started } = await ensureServer(paths);
        console.log(`${started ? 'started in the background (outside this Claude session)' : 'already running'}: ${url}`);
        return 0;
      } catch (e: any) { console.error(e?.message ?? e); return 1; }
    }
    // Started by the hook: the token arrives on stdin, and this process's output goes to server.log,
    // so the token is never printed there.
    const spawned = process.env.CLAUDE_WATCH_TOKEN_STDIN === '1';
    const token = spawned ? (await readStdin()).trim() || undefined : undefined;
    const running = findServer(paths, { listening: true });
    if (running && running.pid !== process.pid) { console.log(`already running: ${dashboardUrl(running)}`); return 0; }
    try {
      const r = await serve({ paths, port: Number(process.env.CLAUDE_WATCH_PORT) || DEFAULT_PORT, token, onIdle: () => { r.close().then(() => process.exit(0)); } });
      console.log(`${new Date().toISOString()} claude-watch serving ${spawned ? `on http://127.0.0.1:${r.info.port}` : dashboardUrl(r.info)}`);
      const stop = () => { r.close().then(() => process.exit(0)); };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
      return -1;   // keep running
    } catch (e: any) {
      console.error(e?.code === 'EADDRINUSE'
        ? `port ${process.env.CLAUDE_WATCH_PORT || DEFAULT_PORT} is in use by another program; set CLAUDE_WATCH_PORT`
        : `failed to start: ${e?.message ?? e}`);
      return 1;
    }
  }

  if (cmd === 'open') {
    let url: string;
    try { ({ url } = await ensureServer(paths)); } catch (e: any) { console.error(e?.message ?? e); return 1; }
    console.log(url);
    if (!flag('--no-browser')) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      try { spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
    }
    return 0;
  }

  if (cmd === 'list' && flag('--json')) {
    const session = option('--session')?.toLowerCase();
    const running = findServer(paths);
    let url = running ? dashboardUrl(running) : null;
    let error: string | undefined;
    if (!url && flag('--ensure')) {
      try { url = (await ensureServer(paths)).url; } catch (e: any) { error = String(e?.message ?? e).split(';')[0]; }
    }
    // The calling session may not have written its record yet; it is never a ghost.
    const snap = buildSnapshot(observe(paths, selfOf(process.pid, paths, session ? [session] : [])));
    process.stdout.write(JSON.stringify(buildReport(snap, url, error)) + '\n');
    return 0;
  }

  if (cmd === 'list') {
    printList(buildSnapshot(observe(paths, selfOf(process.pid, paths))));
    return 0;
  }

  if (cmd === 'kill') {
    const n = Number(argv[1]);
    if (!Number.isSafeInteger(n) || n <= 0) { console.error(USAGE); return 2; }
    const self = selfOf(process.pid, paths);
    const req = killRequestFor(buildSnapshot(observe(paths, self)), n);
    if (typeof req === 'string') { console.error(req); return 1; }
    const r = await executeKill(req, { look: () => world(observe(paths, self)), source: procSource(paths), logFile: actionsLog(paths) }, { dryRun: !flag('--execute') });
    if (r.outcome === 'refused') { console.error(`refused: ${r.refusal}`); return 1; }
    const who = r.members.map((m) => `${m.pid} ${m.cmdline.slice(0, 60)}`).join('\n    ');
    if (r.outcome === 'dry-run') {
      console.log(`would send SIGTERM (then SIGKILL after 5s) to:\n    ${who}\nrun again with --execute to do it`);
    } else {
      console.log(`${r.outcome}:\n    ${who}${r.survivors.length ? `\nstill alive: ${r.survivors.join(', ')}` : ''}`);
    }
    return r.ok ? 0 : 1;
  }

  if (cmd === 'hook') {
    const out = await runHook(await readStdin(), paths, () => ensureServer(paths));
    if (out) process.stdout.write(out + '\n');
    return 0;
  }

  if (cmd === 'statusline') {
    process.stdout.write(await statusLine(paths, await readStdin(), option('--wrap')) + '\n');
    return 0;
  }

  // Absolute node: Claude started from an editor may have a different (older) node on PATH.
  const ourCommand = (sub: string) => `"${stableNodePath()}" "${path.join(import.meta.dirname, 'cli.ts')}" ${sub}`;
  const report = (r: InstallResult, file: string) => {
    if (r.outcome === 'refused') { console.error(`not installed: ${r.reason}`); return 1; }
    if (r.outcome === 'already-installed') console.log(`already installed in ${file}`);
    else console.log(`installed in ${file}${r.backup ? ` (previous version: ${r.backup})` : ''}; it applies to new sessions`);
    return 0;
  };

  if (cmd === 'install-statusline') {
    const ccs = flag('--ccstatusline');
    const file = ccs ? ccstatuslineSettings() : settingsFile(paths);
    const install = ccs ? installCcstatuslineWidget : installStatusLine;
    if (flag('--write')) return report(install(file, ourCommand('statusline')), file);
    console.log(ccs
      ? `--write adds a Custom Command widget to the end of the first line in ${file}:\n  ${ourCommand('statusline')}\n  (preserveColors on, so the link stays clickable; timeout 2000 ms)`
      : `--write sets statusLine in ${file} to run:\n  ${ourCommand('statusline')} [--wrap <your current status line command>]\nYour current status line keeps running; the claude-watch link goes on a line of its own.`);
    return 0;
  }

  if (cmd === 'install-hook') {
    const command = ourCommand('hook');
    const file = settingsFile(paths);
    if (flag('--write')) return report(installHook(file, command), file);
    const snippet = { hooks: { SessionStart: [hookEntry(command)] } };
    console.log(`Merge this into ${file} (it runs on every session start, resume, clear and compact),\nor run install-hook --write to add it:\n\n${JSON.stringify(snippet, null, 2)}`);
    return 0;
  }

  console.log(USAGE);
  return cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
}

main().then(
  (code) => { if (code >= 0) process.exit(code); },
  // A crashing hook must still exit 0 so it never gets in the way of a session starting.
  (e) => { console.error(e); process.exit(argv[0] === 'hook' ? 0 : 1); },
);
