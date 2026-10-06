# claude-watch

See every process Claude Code starts — dev servers, watchers, build daemons, MCP servers — grouped by
the session that started it, in a live local dashboard. Clean up the ones left running after their
session ended ("ghosts") without risking anything else.

Linux and macOS (macOS differences: [docs/macos-testing.md](docs/macos-testing.md)).
No runtime dependencies; Node ≥ 22.18 runs the TypeScript directly.

## How it decides

Claude Code starts its commands with `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID=<uuid>` in the
environment, and with `detached: true`, so each command tree is its own process session (sid).
The environment survives the parent dying, which is what makes this work without any tracking.

| Term | Meaning |
|---|---|
| Claude-started process | owned by you, environment has `CLAUDECODE=1` |
| Group | Claude-started processes sharing a session id and a sid: one command tree |
| Live session | `~/.claude/sessions/<pid>.json` whose pid exists **and** whose starttime equals the record's `procStart` (records outlive crashed sessions) |
| **active** / **ghost** | the group's session is live / is not |
| unattributed | `CLAUDECODE=1` without a session id; shown, never killed |
| Claude process | a live session's own pid, or anything running the same dedicated Claude binary; shown, never killed |

## Use

```sh
node src/cli.ts open          # start the dashboard if needed and open it in the browser
node src/cli.ts list          # the same information in the terminal
node src/cli.ts kill <sid>    # dry run of killing a group (or <pid> for one process)
node src/cli.ts kill <sid> --execute [--confirm <session name>]
```

`npm link` installs it as `claude-watch`.

### SessionStart hook

```sh
node src/cli.ts install-hook   # prints the snippet to merge into ~/.claude/settings.json
```

On every session start and resume, the hook makes sure the dashboard is running and adds a short
note to the new session: the dashboard URL and, if there are any, a summary of the ghosts
(`2 ghost process group(s)… vite on :5173…`). It never kills anything, never fails a session
start, and takes about 70 ms here (about 150 ms when it has to start the dashboard). On `clear` and `compact` it only keeps the server running.

The dashboard server is started detached, with Claude's environment markers removed, so it is
never itself counted as a Claude-started process — and so it can never become a ghost. That holds
for `serve` too: run from inside a Claude session, it hands off to the same clean background
launch instead of running attached to the session. Its token is passed over a pipe (never the
environment or the log). Concurrent session starts share one server and one token. No URL is handed
out until the server's own process holds the port, so if another program takes it first, nothing
is started. The server exits
after 10 minutes with no open tab.

## Killing safely

Every kill is re-planned from a fresh read of `/proc` immediately before any signal:

1. A group kill names the exact `(pid, starttime)` members you saw; if the group changed, it is
   refused ("refresh and try again").
2. Every member must be yours, Claude-started, and from the same session.
3. No member may be a Claude process, claude-watch itself, or one of its ancestors.
4. If the sid also holds processes from outside the session, the group is refused as a whole.
   Single rows that pass 2–3 stay individually killable.
5. Ghost groups need one confirmation. Active-session groups need the session name typed in.

Each pid is signalled on its own (not `kill(-pgid)`): SIGTERM, then for up to 5 s new children are
picked up (if they pass the same checks), then SIGKILL for survivors. Identity is re-verified by
starttime before every signal, so a recycled pid is never hit. Every kill and refusal is appended
to `~/.claude-watch/actions.log`.

## Dashboard security

The server listens on `127.0.0.1:7337` (`CLAUDE_WATCH_PORT` to change it). Every page, stream and
kill needs a random per-server token (it is in the URL the hook and `open` print); the `Host` header
must be the loopback address (DNS-rebinding guard); `POST /kill` additionally needs the token in a
header, a same-origin `Origin`, and a JSON body, so other websites cannot trigger it. No CORS
headers are sent. A running server is recognised by its exact process (pid + starttime from
`server.json`) holding the listening socket itself, not by whatever answers on the port.

## Files

| Path | What |
|---|---|
| `~/.claude-watch/server.json` | running server's pid, port and token (mode 0600) |
| `~/.claude-watch/server.log` | server output |
| `~/.claude-watch/actions.log` | one JSON line per kill or refusal (mode 0600: command lines can hold secrets) |

`CLAUDE_WATCH_DIR`, `CLAUDE_CONFIG_DIR` and `CLAUDE_WATCH_PROC_ROOT` override the locations.

## Platforms

All process information goes through one interface (`ProcSource` in `src/core/proc.ts`):

- **Linux** (`proc-linux.ts`) reads `/proc`: stat, environ, fds, `/proc/net/tcp{,6}`.
- **macOS** (`proc-darwin.ts`) uses `ps` (including `ps -E` for the environment) and `lsof`. The
  kill unit is the process group, since macOS `ps` cannot report session ids; Claude's detached
  spawn makes each command its own group. Start times have one-second resolution. macOS hides
  the environment of Apple's own binaries (`/bin/zsh`, `/bin/sleep`); the zsh wrapper of Claude's
  Bash tool still joins its group under strict conditions. Details and the verification list:
  [docs/macos-testing.md](docs/macos-testing.md).

## Limits

- Processes that drop Claude's environment (`env -i`, setuid binaries) are invisible. On macOS,
  so is a command made only of Apple's own binaries (e.g. `sleep 600 &`).
- MCP servers (observed with the Playwright MCP) are not started detached, so they share a sid
  with the editor or terminal that runs Claude; their group kill is refused, but each one can be
  killed on its own.

## Development

```sh
npm install
npm test           # node:test: fixture /proc trees, a real-process kill, HTTP security checks
npm run typecheck
```

Design: [docs/superpowers/specs/2026-10-06-claude-watch-design.md](docs/superpowers/specs/2026-10-06-claude-watch-design.md).
