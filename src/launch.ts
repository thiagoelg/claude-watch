import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverLog, type Paths } from './core/paths.ts';
import { DEFAULT_PORT, dashboardUrl, findRunning, newToken } from './server.ts';

const CLI = path.join(import.meta.dirname, 'cli.ts');

/**
 * The environment the background server runs with. Claude's markers are removed so the dashboard
 * is never itself counted as a Claude-started process (and, once its session ends, a ghost).
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k === 'AI_AGENT' || k.startsWith('CLAUDE_CODE_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Return the dashboard URL, starting the server in the background if none is running.
 * Does not wait for the new server to bind: the URL is known up front because the token is
 * generated here and handed over through the environment.
 */
export async function ensureServer(paths: Paths, env: NodeJS.ProcessEnv = process.env): Promise<{ url: string; started: boolean }> {
  const running = await findRunning(paths);
  if (running) return { url: dashboardUrl(running), started: false };

  const port = Number(env.CLAUDE_WATCH_PORT) || DEFAULT_PORT;
  const token = newToken();
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  // The server must not inherit our stdout: the hook's caller waits for that pipe to close.
  const log = fs.openSync(serverLog(paths), 'a', 0o600);
  const child = spawn(process.execPath, [CLI, 'serve'], {
    cwd: os.homedir(),
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...cleanEnv(env),
      CLAUDE_WATCH_TOKEN: token,
      CLAUDE_WATCH_PORT: String(port),
      CLAUDE_WATCH_DIR: paths.dataDir,
      CLAUDE_WATCH_PROC_ROOT: paths.procRoot,
      CLAUDE_CONFIG_DIR: paths.claudeDir,
    },
  });
  child.unref();
  fs.closeSync(log);
  return { url: dashboardUrl({ port, token }), started: true };
}
