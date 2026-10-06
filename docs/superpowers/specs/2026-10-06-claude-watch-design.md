# claude-watch — design

Date: 2026-10-06
Status: approved in conversation, pending written-spec review

## Goal

See every process Claude Code starts (dev servers, watchers, build daemons, MCP servers), grouped
by the session that started it, in a live local web dashboard — and safely clean up the ones that
outlive their session ("ghosts").

Success means:

- Opening the dashboard shows every Claude-started process of the current user, grouped by session,
  with each group marked **active** (its Claude session is alive) or **ghost** (it is not).
- Ghost groups can be killed with one confirmation; active-session groups can be killed behind a
  stronger confirmation; Claude processes themselves can never be killed.
- A SessionStart hook reports ghosts into the new session and makes sure the dashboard is running.
- The detection and kill-safety logic is covered by tests, and `npm run typecheck` passes.

## Non-goals

- Anything other than Linux and the current uid.
- Attributing processes that do not carry Claude's environment markers (e.g. a process that ran
  `env -i`). They are invisible to claude-watch by design.
- History/journaling of past processes. Only an action log is kept.
- Managing Claude sessions themselves (no `claude stop`).

## Replaces

This is a full rewrite of `strata`. Removed: the SQLite journal, the birth-journal wrapper and its
log rotation, the 9-level provenance ladder and confidence scores, cmdline-regex classification, the
terminal UI, and daemon-roster integration. The verified facts from the old README (detached
spawn, environ surviving orphaning, starttime as field 22) are kept as background documentation.

## Definitions

- **Claude-started process**: a process owned by the current uid whose environment contains
  `CLAUDECODE=1`. Its **session id** is the `CLAUDE_CODE_SESSION_ID` value (UUID format). A process
  with `CLAUDECODE=1` but no valid session id is **unattributed**: shown, never killable.
- **Session record**: `~/.claude/sessions/<pid>.json` (`$CLAUDE_CONFIG_DIR/sessions` when set),
  fields used: `pid`, `procStart` (string), `sessionId`, `name`, `cwd`, `kind`, `entrypoint`.
- **Live session**: a session record whose `pid` exists **and** whose `/proc/<pid>/stat` starttime
  (field 22) equals `procStart`. Records can outlive their process (observed on this machine), so
  the starttime check is mandatory.
- **Claude process**: the process of a live session record, or any process whose `/proc/<pid>/exe`
  equals the exe of a live session's process — unless that exe's basename is a generic runtime
  (`node`, `bun`, `deno`), in which case only the record's own pid counts (otherwise every node dev
  server would be protected). Shown as an anchor, never killable.
- **Group**: Claude-started processes sharing `(sessionId, sid)`. Claude spawns background commands
  with `detached: true`, so each command tree is its own sid.
- **Group status**: `active` if its session id is a live session, `ghost` otherwise,
  `unattributed` for processes without a session id.
- **Identity**: a process is `(pid, starttime)`, never a bare pid.

## Architecture

One Node process, zero runtime dependencies. Node ≥ 22.18 (runs `.ts` directly via type stripping).

```
src/
  core/proc.ts       read /proc: stat, environ, exe, cwd, cmdline, socket inodes; listening ports
  core/sessions.ts   read session records; decide liveness
  core/model.ts      pure: procs + records + ports + self -> Snapshot
  core/kill.ts       pure kill-plan checks + execution (verify, TERM, grace, re-verify, KILL)
  core/paths.ts      data dir, Claude config dir, proc root (overridable for tests)
  server.ts          localhost HTTP server: page, SSE, kill endpoint, single-instance file
  hook.ts            SessionStart hook
  cli.ts             entry point: serve | open | list | kill | hook | install-hook
ui/index.html        the dashboard (single file, vanilla JS + CSS)
test/                node:test suites + fixture /proc builders
```

### core/proc.ts

```ts
interface Proc {
  pid: number; ppid: number; pgid: number; sid: number; uid: number;
  starttime: number;          // stat field 22, clock ticks since boot
  startedAt: number;          // wall-clock ms
  rssKb: number;
  state: string; comm: string; cmdline: string; exe: string; cwd: string;
  env: Record<string, string> | null;   // null when unreadable
  socketInodes: number[];
}
readProcs(root?: string): Proc[]              // only processes owned by the current uid
readProc(pid: number, root?: string): Proc | null
listeningPorts(root?: string): Map<number, { port: number; addr: string; proto: 'tcp' | 'tcp6' }>
```

`stat` is parsed after the **last** `)`. Ports come from `/proc/net/tcp` and `/proc/net/tcp6` rows
in state `0A` (LISTEN), joined to processes through `socket:[inode]` fds. Fds are only read for
Claude-started processes.

### core/sessions.ts

```ts
interface SessionRecord { pid: number; procStart: string; sessionId: string; name?: string; cwd?: string; kind?: string; entrypoint?: string }
readSessionRecords(dir?: string): SessionRecord[]       // malformed files are skipped
liveSessions(records: SessionRecord[], procs: Map<number, Proc>): Map<string, SessionRecord>
```

### core/model.ts (pure)

```ts
interface Member { pid: number; starttime: number; ppid: number; cmdline: string; cwd: string;
  startedAt: number; rssKb: number; ports: number[]; role: 'claude' | 'command'; protectedReason?: string }
interface Group { id: string;            // `${sessionId ?? 'none'}:${sid}`
  sessionId: string | null; sid: number; status: 'active' | 'ghost' | 'unattributed';
  members: Member[]; killable: boolean; refusal?: string }
interface SessionView { sessionId: string; name?: string; cwd?: string; live: boolean; claudePid?: number }
interface Snapshot { takenAt: number; sessions: SessionView[]; groups: Group[] }
type Ports = ReturnType<typeof listeningPorts>;   // inode -> { port, addr, proto }
buildSnapshot(input: { procs: Proc[]; records: SessionRecord[]; ports: Ports; self: { pid: number; ancestors: number[] } }): Snapshot
```

`killable`/`refusal` on a group are the result of the same checks `core/kill.ts` runs, so the UI
never offers an action the server would refuse (the server still re-checks).

## Kill safety (core/kill.ts)

A kill request names a target — a group `(sessionId, sid)` or a single process `(pid, starttime)` —
plus `expect`: the exact `(pid, starttime)` members the user was looking at.

Immediately before signalling, from a **fresh** `/proc` read:

1. Rebuild the target. For a group, its member set must equal `expect`; otherwise refuse with
   "group changed since you looked — refresh".
2. Every member must be owned by the current uid, have `CLAUDECODE=1`, and the same session id as
   the target.
3. No member may be a Claude process, the claude-watch server itself, or an ancestor of the server.
4. Status rules: `unattributed` is never killable; `active` requires `confirm` equal to the session's
   name (or its first 8 id chars when it has no name), and the session must still be live.
5. A group that fails any check is refused as a whole — no silent fallback to a narrower kill. Single
   rows that pass checks 2–3 remain individually killable.

Execution: each verified pid is signalled **individually** (not `kill(-pgid)`; a sid may contain
several process groups). SIGTERM all; then every 200 ms for up to 5 s re-scan the target, adding
newly forked members only if they pass checks 2–3; survivors are re-verified by `(pid, starttime)`
and get SIGKILL. A pid whose starttime changed is never signalled.

Every kill and every refusal is appended as one JSON line to `~/.claude-watch/actions.log`:
`{ts, target, status, members, outcome, refusal?, signalled: [{pid, starttime, signal}]}`.

## Server (server.ts)

- Binds `127.0.0.1:${CLAUDE_WATCH_PORT ?? 7337}`.
- Single instance: on start writes `~/.claude-watch/server.json` (mode 0600)
  `{pid, procStart, port, token}`. A start that finds a live server there (pid + starttime match
  **and** `GET /health` answers) exits and reuses it. If the port is held by something else, the
  start fails with a clear message.
- Idle exit after 10 minutes with no connected SSE client.
- Snapshots every 2 s, only while at least one client is connected, pushed over SSE.

Endpoints:

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | Host check only | `{app: "claude-watch", pid, procStart}` |
| GET | `/?t=<token>` | token (query) | dashboard HTML; 403 page without a valid token |
| GET | `/events?t=<token>` | token (query) | SSE stream of `Snapshot` |
| POST | `/kill` | token header + Origin + JSON | kill result (see Kill safety) |

Request security:

- Every request: `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard).
- Token: 32 random bytes, hex; compared in constant time.
- `POST /kill`: `X-Claude-Watch-Token` header, `Origin` equal to the server's own origin, and
  `Content-Type: application/json` (forces a CORS preflight, which is never answered). No CORS
  headers are ever sent.

## Dashboard (ui/index.html)

Single static file served by the server; the token is read from the page URL.

- Header: connection state, counts (sessions, active groups, ghost groups), last update time.
- Ghost groups first, then active sessions, then unattributed processes.
- Per session: name, short id, cwd, live/dead.
- Per group: sid, status badge, member table (pid, command, cwd, age, RSS, listening ports), and a
  kill button — or the refusal reason when it is not killable. Claude processes are shown as
  anchors with no buttons.
- Ghost kill: confirm dialog. Active kill: dialog requiring the session name to be typed.
- Kill results (and refusals) appear inline on the group.
- Works in light and dark (`prefers-color-scheme`), readable at narrow widths.

## SessionStart hook (hook.ts)

Installed in `~/.claude/settings.json` under `hooks.SessionStart`, command
`node /path/to/claude-watch/src/cli.ts hook`. `claude-watch install-hook` prints the snippet;
settings are only edited with the user's explicit approval.

1. Read hook input JSON from stdin (`session_id`, `source`).
2. Build a snapshot; collect ghost groups.
3. Ensure the server is running. If not, spawn `node src/cli.ts serve` with `detached: true`
   (own session), `cwd = $HOME`, stdout/stderr to `~/.claude-watch/server.log`, and an environment
   with `CLAUDECODE`, every `CLAUDE_CODE_*` variable, and `AI_AGENT` removed — so the dashboard is
   never itself a Claude-started process (and later a ghost).
4. On `startup` and `resume`, print
   `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}`:
   with ghosts, e.g. "claude-watch: 2 ghost process groups from 1 dead session (vite on :5173,
   tsc --watch). Dashboard: http://127.0.0.1:7337/?t=…"; without ghosts, one line with the URL.
   On `clear` and `compact`, ensure the server but print nothing.
5. Never break a session start: all errors caught, always exit 0, target < 300 ms.

## CLI (cli.ts)

```
claude-watch serve                 run the server in the foreground
claude-watch open                  ensure the server, print the URL, try xdg-open
claude-watch list                  print groups (status, session, sid, members, ports)
claude-watch kill <sid|pid> [--execute] [--confirm <name>]   dry-run unless --execute
claude-watch hook                  the SessionStart hook
claude-watch install-hook          print the settings.json snippet
```

The CLI `kill` uses the same `core/kill.ts` checks as the server; `expect` is taken from the
snapshot it just read.

## Error handling

- Any `/proc` read failure for a process (it exited mid-read) drops that process from the snapshot.
- Malformed session records are skipped.
- Server errors on a request return JSON `{error}` with a 4xx/5xx; the server stays up.
- The hook never throws and never exits non-zero.

## Testing

`node:test`, no dependencies. `core/paths.ts` lets the proc root, Claude config dir and data dir be
pointed at fixture directories.

Fixture `/proc` cases:

- a shell wrapper whose cmdline sources `~/.claude/shell-snapshots/…` is a killable command
- a shell without `CLAUDECODE` is not listed and cannot be targeted
- a group containing a Claude process (by record pid or by matching exe) is refused
- a stale `expect` set is refused
- pid reuse (same pid, different starttime) is never signalled
- a stale session record (pid alive, wrong `procStart`) makes its processes ghosts
- an active group without the right `confirm` is refused; with it, it is allowed
- `stat` parsing with spaces and parentheses in `comm`
- listening-port join from `/proc/net/tcp` + socket fds

Integration (real processes): spawn a detached `sh -c 'sleep …'` with `CLAUDECODE=1` and a fake
session id → it appears as a ghost group → kill with `execute` → all members gone.

Server (real HTTP on an ephemeral port): missing/wrong token → 403; wrong Host → 403; `POST /kill`
without Origin or with a foreign Origin → 403; SSE delivers a snapshot.

`npm test` runs everything; `npm run typecheck` runs `tsc --noEmit` with `typescript` and
`@types/node` as devDependencies.
