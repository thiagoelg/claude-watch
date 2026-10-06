import { isClaudeStarted, type Input, type Self } from './model.ts';
import { procSource, type ProcSource } from './proc.ts';
import { readSessionRecords } from './sessions.ts';
import { sessionsDir, type Paths } from './paths.ts';

/** Everything claude-watch knows about the machine right now. The only I/O feeding the model. */
export function observe(paths: Paths, self: Self, source: ProcSource = procSource(paths)): Input {
  return {
    procs: source.list({ wantSockets: isClaudeStarted }),
    records: readSessionRecords(sessionsDir(paths)),
    ports: source.listening(),
    self,
    matchesStart: source.matchesSessionStart,
  };
}

export function selfOf(pid: number, paths: Paths, assumeLive: string[] = [], source: ProcSource = procSource(paths)): Self {
  return { pid, ancestors: source.ancestors(pid), assumeLive };
}
