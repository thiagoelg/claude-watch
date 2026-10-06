# macOS: what to verify

The macOS process source (`src/core/proc-darwin.ts`) was written on Linux. Its output parsers are
unit-tested against sample `ps`/`lsof` output (`test/darwin.test.ts`), but nothing has run on a Mac
yet. Work through this list in order; **stop at step 3 if it fails** (see why there).

Setup: `npm install`, then work inside a Claude Code session in this repo, so the commands Claude
runs carry `CLAUDECODE=1` and a session id.

## 1. Test suite

```sh
npm test && npm run typecheck
```

`test/integration.test.ts` spawns real processes and kills them through the macOS source (`ps` +
`lsof` + signals); everything else is platform-independent. Expect all green.

## 2. The `ps` and `lsof` output matches what the parsers expect

```sh
LC_ALL=C ps -axww -o pid=,ppid=,pgid=,uid=,rss=,state=,lstart=,comm= | head -5
LC_ALL=C ps -wwE -o pid=,args= -p $$ | head -c 600; echo
lsof -a -d cwd -Fpn -p $$
lsof -nP -iTCP -sTCP:LISTEN -Fpn | head
```

- [ ] Rows look like `  812   790   812   501  45320 S    Tue Oct  6 02:06:36 2026     /path/to/exe`.
- [ ] `comm` is the **full executable path** (the Claude-binary protection compares exe paths). If it
      is only a short name, switch to another source for `exe` (e.g. `ps -o comm` vs `ucomm`, or
      `lsof -d txt`).
- [ ] `ps -E` shows the environment after the arguments, including `CLAUDECODE=1` and
      `CLAUDE_CODE_SESSION_ID=…` when run from Claude's Bash tool.
- [ ] `lsof` prints `p<pid>` and `n<path or address>` lines.

## 3. Session liveness — the one that matters most

The live/ended decision compares `procStart` in `~/.claude/sessions/<pid>.json` with the process's
start time. On Linux, Claude Code writes the `/proc` starttime; **its format on macOS is unknown**.
`darwinMatchesStart` accepts epoch seconds, milliseconds, microseconds or a date string, and
otherwise falls back to "the process started up to a minute before the record's `startedAt`".

```sh
cat ~/.claude/sessions/*.json | head -c 800; echo
ps -o pid=,lstart= -p <pid from that record>
node src/cli.ts list
```

- [ ] Note the `procStart` format here: ______
- [ ] `list` shows your current session as **ACTIVE**, not GHOST.

If a live session shows up as GHOST, **stop using the dashboard on macOS** — a ghost group is
killed after a single confirmation instead of the typed session name. Fix `darwinMatchesStart` for
the real format (and tighten it: drop the `startedAt` fallback once the exact format is known), and
add the observed value to `test/darwin.test.ts`.

## 4. Kill unit (process group instead of session id)

Ask Claude to run a background command, e.g. `sleep 600 & sleep 601 & wait` with
`run_in_background`, then:

```sh
ps -o pid,ppid,pgid,args -ax | grep -E 'sleep 60[01]|snapshot-zsh' | grep -v grep
node src/cli.ts list
```

- [ ] The shell wrapper's `pgid` equals its own pid, and both `sleep`s share it.
- [ ] `list` shows them as one group (`sid` = that pgid), killable, with no "outside this session".
- [ ] MCP servers: note whether they share a group with Claude/the editor (expected: their group
      kill is refused, single rows killable).

## 5. Ports and cwd

Ask Claude to run `python3 -m http.server 8765` in the background, then open the dashboard
(`node src/cli.ts open`).

- [ ] The python row shows `:8765` and the right `cwd`.

## 6. Protection of Claude itself

```sh
ps -o pid=,comm= -p <claude pid from ~/.claude/sessions/*.json>
```

- [ ] Note whether Claude runs as a dedicated binary or as `node` (only a dedicated binary's exe is
      used to protect other processes running it).
- [ ] The dashboard shows Claude's pid as the session anchor, with no kill button.

## 7. End-to-end kill

```sh
CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=feedface-0000-4000-8000-0000000000e3 \
  sh -c 'sleep 900 & python3 -m http.server 8766 >/dev/null 2>&1 & wait' &
```

- [ ] It appears under "Left behind by ended sessions" with `:8766`.
- [ ] "Kill group" → confirm → all three processes are gone (`ps -ax | grep 8766`), and
      `~/.claude-watch/actions.log` has the entry.
- [ ] Killing an active-session group requires typing the session name.

## 8. Hook and dashboard server

```sh
node src/cli.ts install-hook        # check the node path it prints (e.g. /opt/homebrew/bin/node)
time (echo '{"source":"startup"}' | node src/cli.ts hook | cat)
```

- [ ] The hook returns promptly (Linux: ~70 ms warm, ~150 ms cold; macOS spawns `ps`/`lsof`, so
      a few hundred ms is acceptable). Note it: ______
- [ ] `ps -wwE -o args= -p $(node -p "require(process.env.HOME+'/.claude-watch/server.json').pid")`
      shows **no** `CLAUDECODE`/`CLAUDE_CODE_*` in the server's environment.
- [ ] `node src/cli.ts open` opens the browser (uses `open`).
- [ ] After installing the hook, a new session's context gets the claude-watch note:
      `claude -p "Quote any note starting with claude-watch, else say NONE"`.

## Known macOS differences (by design)

- The kill unit is the process group; a shell with job control can split a command tree into
  several groups, which then appear as separate rows.
- Process start times have one-second resolution (identity is `(pid, start second)`).
- Environments of other users' processes, and possibly of hardened processes, are not visible;
  such processes are simply not listed.
