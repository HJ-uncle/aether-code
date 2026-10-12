export type GraphicsMode = 'auto' | 'enabled' | 'software'
export type VisualEffects = 'auto' | 'full' | 'reduced' | 'solid'
export type EffectiveEffects = Exclude<VisualEffects, 'auto'>

export interface GraphicsRecovery {
  reason: 'gpu-process-failed' | 'startup-interrupted'
  at: string
  exitCode?: number
}

export interface GraphicsSnapshot {
  configuredMode: GraphicsMode
  bootMode: GraphicsMode
  hardwareAcceleration: boolean
  gpuCompositing: string
  environmentOverride: boolean
  restartRequired: boolean
  recovery: GraphicsRecovery | null
}

export function isGraphicsMode(value: unknown): value is GraphicsMode {
  return value === 'auto' || value === 'enabled' || value === 'software'
}

/** Existing Windows installations keep their proven compatibility path;
 * acceleration is an explicit, reversible rollout until validated in that environment. */
export function defaultGraphicsMode(platform: string): GraphicsMode {
  return platform === 'win32' ? 'software' : 'auto'
}

export function isVisualEffects(value: unknown): value is VisualEffects {
  return value === 'auto' || value === 'full' || value === 'reduced' || value === 'solid'
}

/** Explicit overrides support diagnostics without changing the saved preference. */
export function shouldUseHardware(
  mode: GraphicsMode,
  recovery: GraphicsRecovery | null,
  override?: string
): boolean {
  if (override === '0') return false
  if (override === '1') return true
  return mode === 'enabled' || (mode === 'auto' && recovery === null)
}

/** Software compositing must never pay for backdrop sampling, even with a saved full preference. */
export function resolveVisualEffects(
  preference: VisualEffects,
  accelerated: boolean,
  reduceTransparency: boolean
): EffectiveEffects {
  if (!accelerated || reduceTransparency || preference === 'solid') return 'solid'
  return preference === 'auto' ? 'reduced' : preference
}
