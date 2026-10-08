import os from 'node:os';
import path from 'node:path';

/**
 * Every filesystem location claude-watch touches. Each one can be overridden, so tests can point
 * the whole tool at fixture directories instead of the real /proc and ~/.claude.
 */
export interface Paths {
  procRoot: string;      // normally /proc
  claudeDir: string;     // normally ~/.claude
  dataDir: string;       // normally ~/.claude-watch
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  // An empty variable counts as unset: an empty CLAUDE_CONFIG_DIR must not make every session look
  // ended (and every group a ghost) by reading session records from a relative "sessions" folder.
  return {
    procRoot: env.CLAUDE_WATCH_PROC_ROOT || '/proc',
    claudeDir: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    dataDir: env.CLAUDE_WATCH_DIR || path.join(os.homedir(), '.claude-watch'),
  };
}

export const sessionsDir = (p: Paths) => path.join(p.claudeDir, 'sessions');
export const settingsFile = (p: Paths) => path.join(p.claudeDir, 'settings.json');
export const serverFile = (p: Paths) => path.join(p.dataDir, 'server.json');
export const serverLog = (p: Paths) => path.join(p.dataDir, 'server.log');
export const statuslineCache = (p: Paths) => path.join(p.dataDir, 'statusline.json');
export const actionsLog = (p: Paths) => path.join(p.dataDir, 'actions.log');
