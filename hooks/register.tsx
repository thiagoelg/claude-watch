import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { WatchGroup, WatchReport } from '../types'

/**
 * claude-watch as a mod: a status entry with the ghost count, a pane listing the processes Claude
 * Code started (ghosts killable from it), a note for Claude at session start, and a warning when a
 * session ends with processes still running. Everything is read and killed through the claude-watch
 * CLI (`list --json`, `kill --expect`), so its safety checks stay the only ones.
 */

const PANE = 'process-watch'
const COMMAND = 'process-watch'
const POLL_MS = 15_000

const report = atom({ plugin: 'process-watch', key: 'report' } as const, null)
const sessionOf = atom({ plugin: 'process-watch', key: 'sessionId' } as const, null)
const confirming = atom({ plugin: 'process-watch', key: 'confirming' } as const, null)
const outcome = atom({ plugin: 'process-watch', key: 'outcome' } as const, null)
const showAttached = atom({ plugin: 'process-watch', key: 'showAttached' } as const, false)

// The module's own state; a reload starts it over.
let configured = ''
let warnOnExit = true
/** The note for Claude, fixed per session so the system prompt (and its cache) does not change every poll. */
let context: string | null = null
let contextFor: string | null = null
let polling: Timer | undefined
let looking: Promise<WatchReport | null> | null = null

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''
const message = (err: unknown) => firstLine(String((err as Error)?.message ?? err))

const age = (ms: number) => {
  const m = Math.max(0, ms) / 60_000
  return m < 1 ? 'just now' : m < 60 ? `${Math.round(m)}m ago` : m < 24 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

/** The label without its ports, which the pane shows in a column of their own. */
const command = (g: WatchGroup) => g.label.replace(/ on :\d+(, :\d+)*$/, '')
const ports = (g: WatchGroup) => g.ports.map(p => `:${p}`).join(' ')
const processes = (g: WatchGroup) => { const n = g.expect.split(',').length; return n === 1 ? '1 process' : `${n} processes` }

const who = (g: WatchGroup) => g.sessionName ?? (g.sessionId ? `session ${g.sessionId.slice(0, 8)}` : 'no session')

/** Attached to an editor or terminal (MCP servers do this): it shares that sid, so it is only stopped one process at a time. */
const isAttached = (g: WatchGroup) => !g.killable && /also contains/.test(g.refusal ?? '')

/** Why a group cannot be stopped here, short. */
const why = (g: WatchGroup) => /also contains/.test(g.refusal ?? '') ? 'shares its sid, stop each from the dashboard' : (g.refusal ?? 'not killable')

/** Groups of this session that will be left running (as ghosts) when it ends: detached command trees, not MCP servers. */
export const leftBehind = (r: WatchReport, sessionId: string) =>
  r.groups.filter(g => g.sessionId === sessionId && g.status === 'active' && g.killable)

export function statusText(r: WatchReport, sessionId: string): string | undefined {
  if (!r.url) return `claude-watch: off (${r.error ?? 'not running'})`
  const here = leftBehind(r, sessionId).length
  const parts = [r.ghosts ? plural(r.ghosts, 'ghost') : '', here ? `${here} running here` : ''].filter(Boolean)
  return parts.length ? `claude-watch: ${parts.join(' · ')} · /${COMMAND}` : undefined
}

export function summary(r: WatchReport, sessionId: string): string {
  const lines = [r.url ? `claude-watch · ${r.url}` : `claude-watch · dashboard off: ${r.error ?? 'unknown error'}`]
  const ghosts = r.groups.filter(g => g.status === 'ghost')
  const here = leftBehind(r, sessionId)
  lines.push(ghosts.length ? `⚠ ${plural(ghosts.length, 'ghost')} left by ended sessions` : '✓ No ghosts')
  for (const g of ghosts) lines.push(`    ${g.label}  (${who(g)}, ${age(r.takenAt - g.startedAt)})`)
  if (here.length) lines.push(`● ${here.length} running from this session`)
  for (const g of here) lines.push(`    ${g.label}`)
  return lines.join('\n')
}

/** The claude-watch CLI's argv: the configured one, else the one this mod ships with, else claude-watch on PATH. */
async function cli($: EngineInterface): Promise<string[]> {
  const asArgv = (p: string) => (/\.[cm]?ts$/.test(p) ? ['node', p] : [p])
  if (configured) return asArgv(configured)
  const shipped = `${$.plugin.root}/src/cli.ts`
  return (await $.fs.exists(shipped)) ? ['node', shipped] : ['claude-watch']
}

async function look($: EngineInterface, timeoutMs: number): Promise<WatchReport | null> {
  const id = await $.session.id()
  let r: WatchReport
  try {
    const out = await $.process.run([...(await cli($)), 'list', '--json', '--ensure', '--session', id], { timeoutMs })
    if (out.exitCode !== 0) throw new Error(firstLine(out.stderr) || `exit code ${out.exitCode}`)
    r = JSON.parse(out.stdout) as WatchReport
  } catch (err) {
    $.ui.status(`claude-watch: cannot run the CLI (${message(err).slice(0, 80)}); set process-watch's cli option in /config`)
    return null
  }
  await update($, report, () => r)
  await update($, sessionOf, () => id)
  $.ui.status(statusText(r, id))
  if (contextFor !== id) {
    context = r.context
    contextFor = id
  }
  return r
}

/** One look at a time: a poll and a press share it. */
async function refresh($: EngineInterface, timeoutMs = 15_000): Promise<WatchReport | null> {
  looking ??= look($, timeoutMs).finally(() => { looking = null })
  return looking
}

async function kill($: EngineInterface, g: WatchGroup) {
  await update($, confirming, () => null)
  await update($, outcome, () => ({ text: `Stopping ${command(g)}…`, tone: 'running' as const }))
  let said: { text: string; tone: 'ok' | 'failed' }
  try {
    const argv = [...(await cli($)), 'kill', String(g.sid), '--expect', g.expect, '--execute']
    if (g.sessionId) argv.push('--session', g.sessionId)
    const out = await $.process.run(argv, { timeoutMs: 30_000 })
    said = out.exitCode === 0
      ? { text: `${firstLine(out.stdout).replace(/:$/, '')}: ${command(g)}`, tone: 'ok' }
      : { text: firstLine(out.stderr || out.stdout), tone: 'failed' }
  } catch (err) {
    said = { text: `kill failed: ${message(err)}`, tone: 'failed' }
  }
  await update($, outcome, () => said)
  await refresh($)
}

async function askToKill($: EngineInterface, g: WatchGroup) {
  await update($, confirming, () => g.id)
}

async function cancelKill($: EngineInterface) {
  await update($, confirming, () => null)
}

async function toggleAttached($: EngineInterface) {
  await update($, showAttached, shown => !shown)
}

/** Opens the dashboard in the browser through the CLI, which starts it if needed. */
async function openDashboard($: EngineInterface) {
  try {
    const out = await $.process.run([...(await cli($)), 'open'], { timeoutMs: 15_000 })
    if (out.exitCode !== 0) throw new Error(firstLine(out.stderr) || `exit code ${out.exitCode}`)
  } catch (err) {
    await update($, outcome, () => ({ text: `could not open the dashboard: ${message(err)}`, tone: 'failed' as const }))
  }
}

async function poll($: EngineInterface) {
  await refresh($)
}

export const register: Register = (on, options) => {
  configured = typeof options.cli === 'string' ? options.cli.trim() : ''
  warnOnExit = options.warnOnExit !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the processes Claude Code started (claude-watch), and kill ghosts left by ended sessions',
    })
    polling?.cancel()
    polling = $.clock.every(POLL_MS, () => { void poll($) })
    const r = await refresh($)
    if (r?.ghosts) $.ui.toast(`claude-watch: ${plural(r.ghosts, 'ghost process group')} left by ended sessions · /${COMMAND}`)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!context) return composed

    return { sections: [...composed.sections, { id: 'process-watch:processes', text: context, scope: 'session' as const }] }
  })

  on('command.run', { command: COMMAND }, async $ => {
    void $.ui.open({ id: PANE, title: 'claude-watch' })
    const r = await refresh($)
    if (!r) return { text: "claude-watch: the CLI could not be run; set process-watch's cli option in /config." }

    return { text: summary(r, await $.session.id()) }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') contextFor = null   // the next session gets a fresh note
    // Exits have a short budget for every hook together: a fresh look if it is quick, else the last one.
    const r = (await refresh($, 1_000).catch(() => null)) ?? (await read($, report))
    const left = r ? leftBehind(r, e.sessionId) : []
    if (left.length && warnOnExit) {
      const text = `${plural(left.length, 'process group')} from this session ${left.length === 1 ? 'is' : 'are'} still running: ${left.map(g => g.label).join('; ')}`
      if (e.reason === 'clear') $.ui.toast(`claude-watch: ${text}`)
      else await $.ui.notify(`${text}. They will show as ghosts.`, { title: 'claude-watch' }).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, report)
    const me = await read($, sessionOf)
    const pending = await read($, confirming)
    const said = await read($, outcome)
    const isShowingAttached = await read($, showAttached)
    if (!r) return <Text dimColor>Looking for processes…</Text>

    // The terminal draws compact rows (a border costs two rows); the apps draw cards and pills.
    const isTerminal = e.surface === 'terminal'
    const canOpen = e.surface !== 'mobile'   // the dashboard is on this machine, a phone cannot reach it
    const isWide = e.props.bodyColumns >= 64

    const ghosts = r.groups.filter(g => g.status === 'ghost')
    const live = r.groups.filter(g => g.status !== 'ghost')
    const attached = live.filter(isAttached)
    const shown = isShowingAttached ? live : live.filter(g => !isAttached(g))
    const mine = shown.filter(g => g.sessionId === me)
    const others = shown.filter(g => g.sessionId !== me)
    const otherSessions = [...new Set(others.map(who))]
    const hereCount = live.filter(g => g.sessionId === me && !isAttached(g)).length
    const elsewhereCount = live.filter(g => g.sessionId !== me && !isAttached(g)).length

    const pill = (key: string, label: string, color: string) => isTerminal
      ? <Text key={key} color={color}>{label}</Text>
      : (
        <Box key={key} borderStyle="round" borderColor={color} paddingX={1}>
          <Text color={color}>{label}</Text>
        </Box>
      )

    /** One group: a status dot, the command, its ports and its action; a dim line under it; then a confirmation. */
    const card = (g: WatchGroup, color: string, meta: string, action: RenderChildren, below?: RenderChildren) => {
      const body = [
        <Box key="main" flexDirection="row" gap={1} alignItems="center">
          <Text color={color}>●</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text bold={!isTerminal} wrap="truncate-end">{command(g)}</Text>
          </Box>
          {g.ports.map(port => pill(`port:${port}`, `:${port}`, 'suggestion'))}
          {action}
        </Box>,
        <Box key="meta" paddingLeft={2}>
          <Text dimColor wrap="truncate-end">{meta}</Text>
        </Box>,
        below,
      ]

      return isTerminal
        ? <Box key={`card:${g.id}`} flexDirection="column" paddingLeft={1}>{body}</Box>
        : (
          <Box key={`card:${g.id}`} flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} hover={{ borderColor: color }}>
            {body}
          </Box>
        )
    }

    const section = (key: string, title: string, count: number | null, body: RenderChildren) => (
      <Box key={key} flexDirection="column" marginTop={1} gap={isTerminal ? 0 : 1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{title}</Text>
          {count === null ? null : <Text dimColor>{count}</Text>}
        </Box>
        {body}
      </Box>
    )

    const ghostCard = (g: WatchGroup) => {
      const meta = `${who(g)} · ${processes(g)} · ${age(r.takenAt - g.startedAt)}`
      if (!g.killable) return card(g, 'warning', `${meta} · ${why(g)}`, null)
      if (pending !== g.id) {
        return card(g, 'warning', meta, <Button key={`kill:${g.id}`} label="Stop" onPress={() => askToKill($, g)} />)
      }

      return card(g, 'warning', meta, null, (
        <Box key="confirm" flexDirection="row" gap={1} flexWrap="wrap" alignItems="center" marginTop={isTerminal ? 0 : 1}>
          <Text color="warning">SIGTERM, then SIGKILL after 5 s.</Text>
          <Button key={`yes:${g.id}`} variant="primary" label={`Stop ${processes(g)}`} onPress={() => kill($, g)} />
          <Button key={`no:${g.id}`} label="Cancel" onPress={() => cancelKill($)} />
        </Box>
      ))
    }

    const liveCard = (g: WatchGroup, color: string) =>
      card(g, color, `${processes(g)} · ${age(r.takenAt - g.startedAt)}${g.killable ? '' : ` · ${why(g)}`}`, null)

    const tone = said?.tone === 'ok' ? 'success' : said?.tone === 'failed' ? 'error' : 'subtle'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Box flexGrow={1} flexDirection="row" gap={1} alignItems="center">
            {pill('ghosts', ghosts.length ? plural(ghosts.length, 'ghost') : 'no ghosts', ghosts.length ? 'warning' : 'success')}
            {isWide || !isTerminal ? pill('here', `${hereCount} here`, 'success') : null}
            {isWide || !isTerminal ? pill('elsewhere', `${elsewhereCount} elsewhere`, 'subtle') : null}
          </Box>
          {canOpen && r.url ? <Button key="open" variant="primary" hotkey="d" label="Open dashboard" onPress={() => openDashboard($)} /> : null}
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => poll($)} />
        </Box>
        {!r.url ? <Text color="error" wrap="truncate-end">Dashboard off: {r.error}</Text> : null}
        {said ? <Text color={tone} wrap="truncate-end">{said.tone === 'ok' ? '✓ ' : said.tone === 'failed' ? '✗ ' : ''}{said.text}</Text> : null}

        {ghosts.length
          ? section('ghosts', 'Left by ended sessions', ghosts.length, ghosts.map(ghostCard))
          : section('ghosts', '✓ Nothing left by ended sessions', null, null)}

        {section('mine', 'This session', mine.length,
          mine.length ? mine.map(g => liveCard(g, 'success')) : <Text dimColor>Nothing running.</Text>)}

        {otherSessions.map(name => section(`s:${name}`, name, null,
          others.filter(g => who(g) === name).map(g => liveCard(g, 'subtle'))))}

        <Box marginTop={1} flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {attached.length
            ? <Button key="attached" plain label={isShowingAttached ? 'Hide attached processes' : `Show ${plural(attached.length, 'attached process')} (MCP servers)`} onPress={() => toggleAttached($)} />
            : null}
          <Text dimColor>Live sessions' processes are stopped from the dashboard.</Text>
        </Box>
      </Box>
    )
  })
}
