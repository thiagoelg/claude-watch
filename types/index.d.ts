/** One process group, as `claude-watch list --json` reports it. */
export type WatchGroup = {
  id: string
  sid: number
  sessionId: string | null
  sessionName?: string
  status: 'active' | 'ghost' | 'unattributed'
  label: string
  ports: number[]
  startedAt: number
  killable: boolean
  refusal?: string
  /** `pid:starttime,...`, passed back to `kill --expect`. */
  expect: string
}

/** `claude-watch list --json`. */
export type WatchReport = {
  takenAt: number
  url: string | null
  error?: string
  ghosts: number
  groups: WatchGroup[]
  userNote: string
  context: string
}

declare module 'claude-code' {
  interface PluginState {
    'process-watch': {
      report: WatchReport | null
      /** This session's id when the report was taken. */
      sessionId: string | null
      /** The id of the group whose kill waits for a second press. */
      confirming: string | null
      /** The outcome of the last kill, shown in the pane: running, done or failed. */
      outcome: { text: string; tone: 'running' | 'ok' | 'failed' } | null
      /** Whether the pane lists processes attached to an editor or terminal (MCP servers), folded by default. */
      showAttached: boolean
    }
  }
}
