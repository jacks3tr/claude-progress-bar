export type Progress = {
  label: string
  percent: number
  note: string | null
  startedAt: number
  updatedAt: number
  etaAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'progress-eta': { progress: Shaped<Progress | null>; tick: number }
  }
}
