import type { Paths } from './paths.ts';
import { linuxSource } from './proc-linux.ts';
import { darwinSource } from './proc-darwin.ts';

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  /** The kill unit. Linux: the process session id. macOS: the process group (see proc-darwin.ts). */
  sid: number;
  uid: number;
  /** Platform start time used for identity. Linux: stat field 22 (ticks). macOS: epoch seconds. */
  starttime: number;
  startedAt: number;   // wall-clock ms
  rssKb: number;
  state: string;
  comm: string;
  cmdline: string;
  exe: string;
  cwd: string;
  env: Record<string, string> | null;   // null when unreadable
  /** Ids of the process's sockets, keys into ProcSource.listening(). */
  socketInodes: number[];
}

export interface Port {
  port: number;
  addr: string;
  proto: 'tcp' | 'tcp6';
}

export interface Identity {
  starttime: number;
  state: string;
}

/** The only way the rest of claude-watch learns about processes. One implementation per OS. */
export interface ProcSource {
  readonly platform: 'linux' | 'darwin';
  /** Every process owned by the current user. Sockets are only resolved where `wantSockets` says. */
  list(opts?: { wantSockets?: (p: Proc) => boolean }): Proc[];
  /** One process, or null if it is gone or belongs to another user. */
  get(pid: number, opts?: { withSockets?: boolean }): Proc | null;
  /** Cheap identity re-check used immediately before every signal. */
  identity(pid: number): Identity | null;
  /** LISTEN sockets, keyed by the ids found in Proc.socketInodes. */
  listening(): Map<number, Port>;
  /** pid's parent chain up to (not including) pid 0. */
  ancestors(pid: number): number[];
  /** Whether a ~/.claude/sessions record's procStart (and startedAt) describes process `p`. */
  matchesSessionStart(p: Proc, procStart: string, startedAt?: number): boolean;
}

/**
 * macOS gets its own source; everything else reads /proc. A fixture proc root (tests,
 * CLAUDE_WATCH_PROC_ROOT) always uses the /proc reader, on any OS.
 */
export function procSource(paths: Paths, platform: NodeJS.Platform = process.platform): ProcSource {
  if (platform === 'darwin' && paths.procRoot === '/proc') return darwinSource();
  return linuxSource(paths.procRoot);
}
