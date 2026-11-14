export type UltraMode = boolean

declare module 'claude-code' {
  interface PluginState {
    'all-clear': { ultra: UltraMode }
  }
}
