import { ancestors, listeningPorts, readProcs } from './proc.ts';
import { isClaudeStarted, type Input, type Self } from './model.ts';
import { readSessionRecords } from './sessions.ts';
import { sessionsDir, type Paths } from './paths.ts';

/** Everything claude-watch knows about the machine right now. The only I/O feeding the model. */
export function observe(paths: Paths, self: Self): Input {
  return {
    procs: readProcs({ root: paths.procRoot, wantSockets: isClaudeStarted }),
    records: readSessionRecords(sessionsDir(paths)),
    ports: listeningPorts(paths.procRoot),
    self,
  };
}

export function selfOf(pid: number, paths: Paths, assumeLive: string[] = []): Self {
  return { pid, ancestors: ancestors(pid, paths.procRoot), assumeLive };
}
