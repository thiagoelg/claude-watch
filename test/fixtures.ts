import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Paths } from '../src/core/paths.ts';

export interface FakeProc {
  pid: number;
  ppid?: number;
  sid?: number;
  pgid?: number;
  starttime?: number;
  state?: string;
  comm?: string;
  argv?: string[];
  exe?: string;
  cwd?: string;
  env?: Record<string, string> | null;   // null: environ unreadable
  sockets?: number[];
}

export const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444';
export const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444';

/** Environment of a process Claude Code started in `session`. */
export const claudeEnv = (session: string | null, extra: Record<string, string> = {}) => ({
  CLAUDECODE: '1', ...(session ? { CLAUDE_CODE_SESSION_ID: session } : {}), ...extra,
});

export function statLine(p: FakeProc): string {
  // Fields 3..52 after "pid (comm)"; only the ones claude-watch reads are meaningful.
  const f = new Array(50).fill('0');
  f[0] = p.state ?? 'S';
  f[1] = String(p.ppid ?? 1);
  f[2] = String(p.pgid ?? p.sid ?? p.pid);
  f[3] = String(p.sid ?? p.pid);
  f[19] = String(p.starttime ?? 1000 + p.pid);
  f[21] = '256';
  return `${p.pid} (${p.comm ?? 'proc'}) ${f.join(' ')}\n`;
}

export class FakeWorld {
  readonly dir: string;
  readonly paths: Paths;

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-watch-test-'));
    this.paths = {
      procRoot: path.join(this.dir, 'proc'),
      claudeDir: path.join(this.dir, 'claude'),
      dataDir: path.join(this.dir, 'data'),
    };
    fs.mkdirSync(path.join(this.paths.procRoot, 'net'), { recursive: true });
    fs.mkdirSync(path.join(this.paths.claudeDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(this.paths.procRoot, 'uptime'), '1000.00 2000.00\n');
  }

  proc(p: FakeProc): this {
    const d = path.join(this.paths.procRoot, String(p.pid));
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(path.join(d, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(d, 'stat'), statLine(p));
    fs.writeFileSync(path.join(d, 'cmdline'), (p.argv ?? [p.comm ?? 'proc']).map((a) => a + '\0').join(''));
    if (p.env !== null) {
      fs.writeFileSync(path.join(d, 'environ'), Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}\0`).join(''));
    }
    fs.symlinkSync(p.exe ?? '/usr/bin/' + (p.comm ?? 'proc'), path.join(d, 'exe'));
    fs.symlinkSync(p.cwd ?? '/home/u/project', path.join(d, 'cwd'));
    (p.sockets ?? []).forEach((ino, i) => fs.symlinkSync(`socket:[${ino}]`, path.join(d, 'fd', String(10 + i))));
    return this;
  }

  remove(pid: number): this {
    fs.rmSync(path.join(this.paths.procRoot, String(pid)), { recursive: true, force: true });
    return this;
  }

  /** A ~/.claude/sessions/<pid>.json record. */
  session(r: { pid: number; procStart: number | string; sessionId: string; name?: string }): this {
    fs.writeFileSync(
      path.join(this.paths.claudeDir, 'sessions', `${r.pid}.json`),
      JSON.stringify({ ...r, procStart: String(r.procStart), cwd: '/home/u/project', kind: 'interactive' }),
    );
    return this;
  }

  /** LISTEN sockets: inode -> port, written as /proc/net/tcp. */
  listen(sockets: Record<number, number>): this {
    const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    const rows = Object.entries(sockets).map(([ino, port], i) =>
      `   ${i}: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${ino} 1 0000000000000000 100 0 0 10 0\n`);
    fs.writeFileSync(path.join(this.paths.procRoot, 'net', 'tcp'), header + rows.join(''));
    return this;
  }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * A typical world: session A is live (Claude pid 100, a dedicated binary), and its Bash tool ran a
 * detached dev server: shell wrapper 200 (sid 200) -> node 201 listening on :5173.
 */
export function typicalWorld(): FakeWorld {
  return new FakeWorld()
    .proc({ pid: 100, comm: 'claude', exe: '/home/u/.local/share/claude/versions/2.1.290', argv: ['claude'], env: {} })
    .session({ pid: 100, procStart: 1100, sessionId: SESSION_A, name: 'proj-a1' })
    .proc({
      pid: 200, ppid: 100, comm: 'zsh', exe: '/usr/bin/zsh',
      // The cmdline that made the old implementation think this shell was Claude itself.
      argv: ['/usr/bin/zsh', '-c', 'source /home/u/.claude/shell-snapshots/snapshot-zsh-1.sh && eval \'npm run dev\''],
      env: claudeEnv(SESSION_A),
    })
    .proc({ pid: 201, ppid: 200, sid: 200, comm: 'node', exe: '/usr/bin/node', argv: ['node', 'vite'], env: claudeEnv(SESSION_A), sockets: [9001] })
    .listen({ 9001: 5173 });
}
