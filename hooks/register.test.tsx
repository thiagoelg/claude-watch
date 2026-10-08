import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { WatchReport } from '../types'

const SESSION = '11111111-2222-3333-4444-555555555555'
const URL = 'http://127.0.0.1:7337/?t=tok'

const REPORT: WatchReport = {
  takenAt: 1_000_000,
  url: URL,
  ghosts: 1,
  groups: [
    { id: 'gone:300', sid: 300, sessionId: '99999999-2222-3333-4444-555555555555', sessionName: 'old-session', status: 'ghost', label: 'node vite on :5173', ports: [5173], startedAt: 1_000_000 - 3_600_000, killable: true, expect: '300:1300,301:1301' },
    { id: `${SESSION}:400`, sid: 400, sessionId: SESSION, status: 'active', label: 'npm run watch', ports: [], startedAt: 1_000_000 - 60_000, killable: true, expect: '400:1400' },
  ],
  userNote: `claude-watch: 1 ghost process group(s) left by ended sessions. Dashboard: ${URL}`,
  context: 'claude-watch: 1 ghost process group(s) left running',
}

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
/** What the engine answers beneath the plugin, in a session with a terminal. */
function engine(on: On) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  return clock
}

const START = { cwd: '/p', surface: 'terminal', isInteractive: true } as const

describe('process-watch', () => {
  test('a session start reads the CLI, pins the ghost count and tells Claude', { options: { cli: '/repo/src/cli.ts' } }, async ($, on) => {
    engine(on)
    const runs: (readonly string[])[] = []
    const statuses: (string | undefined)[] = []
    on('session.id', () => ({ value: SESSION }))
    on('process.run', ($, e) => { runs.push(e.argv); return ok(JSON.stringify(REPORT)) })
    on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })

    await $.session.start(START)

    expect(runs[0]).toEqual(['node', '/repo/src/cli.ts', 'list', '--json', '--ensure', '--session', SESSION])
    expect(statuses.at(-1)).toBe('claude-watch: 1 ghost · 1 running here · /process-watch')

    const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(composed.sections.at(-1)).toEqual({ id: 'process-watch:processes', text: REPORT.context, scope: 'session' })
  })

  test('with no cli option it runs the CLI the mod ships with', async ($, on) => {
    engine(on)
    const runs: (readonly string[])[] = []
    const asked: string[] = []
    on('session.id', () => ({ value: SESSION }))
    on('fs.exists', ($, e) => { asked.push(e.path); return { value: true } })
    on('process.run', ($, e) => { runs.push(e.argv); return ok(JSON.stringify(REPORT)) })
    on('ui.status', () => ({ value: undefined }))

    await $.session.start(START)

    expect(asked[0]).toMatch(/\/src\/cli\.ts$/)
    expect(runs[0]?.slice(0, 2)).toEqual(['node', asked[0]])
  })

  test('it looks again every 15 seconds, not more', async ($, on) => {
    const clock = engine(on)
    let looks = 0
    on('session.id', () => ({ value: SESSION }))
    on('fs.exists', () => ({ value: false }))
    on('ui.status', () => ({ value: undefined }))
    on('process.run', () => { looks += 1; return ok(JSON.stringify(REPORT)) })

    await $.session.start(START)
    await clock.advance(14_000)
    expect(looks).toBe(1)
    await clock.advance(1_000)
    expect(looks).toBe(2)
    await clock.advance(30_000)
    expect(looks).toBe(4)
  })

  test('a CLI that cannot run says so in the status line', async ($, on) => {
    engine(on)
    const statuses: (string | undefined)[] = []
    on('session.id', () => ({ value: SESSION }))
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'claude-watch: not found', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })

    await $.session.start(START)

    expect(statuses.at(-1)).toMatch(/cannot run the CLI \(claude-watch: not found\)/)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the pane kills a ghost after a second press (${surface})`, { options: { cli: 'claude-watch' } }, async ($, on) => {
    engine(on)
      const runs: (readonly string[])[] = []
      on('session.id', () => ({ value: SESSION }))
      on('ui.status', () => ({ value: undefined }))
      on('process.run', ($, e) => {
        runs.push(e.argv)
        return e.argv[1] === 'kill' ? ok('terminated:\n    300 node vite') : e.argv[1] === 'open' ? ok(URL) : ok(JSON.stringify(REPORT))
      })
      await $.session.start(START)
      const afterStart = runs.length

      const ui = await $.ui.mount({ plugin: 'process-watch', surface, component: 'Pane', requestId: 'process-watch', props: {} as never })
      const afterMount = runs.length
      await ui.press({ key: 'kill:gone:300' })
      expect([afterStart, afterMount, runs.length]).toEqual([1, 1, 1])
      expect(runs.some(argv => argv[1] === 'kill')).toBe(false)
      await ui.press({ key: 'yes:gone:300' })

      expect(runs.find(argv => argv[1] === 'kill')).toEqual(['claude-watch', 'kill', '300', '--expect', '300:1300,301:1301', '--execute', '--session', '99999999-2222-3333-4444-555555555555'])
      expect(await ui.find({ type: 'Text', text: /✓ terminated: node vite$/ })).toBeTruthy()

      const pressed = await ui.press({ key: 'open' })
      expect(runs.at(-1)).toEqual(['claude-watch', 'open'])
    })
  }
})
