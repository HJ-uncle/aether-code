import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettings } from './settings-store'
import { shouldUseHardware, type GraphicsMode, type GraphicsRecovery, type GraphicsSnapshot } from '../shared/graphics'

interface RecoveryRecord {
  version: 1
  pendingSince?: string
  failure?: GraphicsRecovery
}
const override = process.env.AETHER_ENABLE_GPU
let initialized = false
let recoveryPath = ''
let record: RecoveryRecord = { version: 1 }
let bootMode: GraphicsMode = 'auto'
let hardwareRequested = false
const listeners = new Set<(snapshot: GraphicsSnapshot) => void>()
let healthyTimer: NodeJS.Timeout | undefined

/** Resolve profile state lazily so a multi-instance launch can set userData first. */
function ensureState(): void {
  if (initialized) return
  recoveryPath = join(app.getPath('userData'), 'graphics-recovery.json')
  record = { version: 1 }
  try {
    const raw = JSON.parse(readFileSync(recoveryPath, 'utf8')) as Partial<RecoveryRecord>
    if (raw.version === 1) {
      const failure = raw.failure
      if (
        failure &&
        (failure.reason === 'gpu-process-failed' || failure.reason === 'startup-interrupted') &&
        typeof failure.at === 'string'
      ) {
        record.failure = failure
      }
      if (typeof raw.pendingSince === 'string') record.pendingSince = raw.pendingSince
    }
  } catch {
    /* A new/corrupt profile starts with the normal automatic policy. */
  }

  // A fatal native startup may exit before Electron emits child-process-gone.
  // Treat an unfinished attempt as uncertain; never report it as a confirmed GPU fault.
  if (!record.failure && record.pendingSince)
    record.failure = { reason: 'startup-interrupted', at: record.pendingSince }
  delete record.pendingSince
  bootMode = getSettings().graphicsMode
  hardwareRequested = shouldUseHardware(bootMode, record.failure ?? null, override)
  initialized = true
}

function save(): void {
  ensureState()
  const temporary = `${recoveryPath}.${process.pid}.tmp`
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(temporary, JSON.stringify(record), 'utf8')
    renameSync(temporary, recoveryPath)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* best effort diagnostics */
    }
  }
}

/** Must run before ready; an intentional software path also avoids the Windows GPU child retry loop. */
export function configureGraphics(): void {
  ensureState()
  if (hardwareRequested) return
  if (process.platform === 'win32') app.commandLine.appendSwitch('in-process-gpu')
  app.disableHardwareAcceleration()
}

export function getGraphicsSnapshot(): GraphicsSnapshot {
  ensureState()
  const gpuCompositing = app.isReady()
    ? (app.getGPUFeatureStatus().gpu_compositing ?? 'unavailable')
    : 'unavailable'
  return {
    configuredMode: getSettings().graphicsMode,
    bootMode,
    hardwareAcceleration: hardwareRequested && gpuCompositing === 'enabled',
    gpuCompositing,
    environmentOverride: override === '0' || override === '1',
    restartRequired:
      getSettings().graphicsMode !== bootMode ||
      hardwareRequested !==
        shouldUseHardware(getSettings().graphicsMode, record.failure ?? null, override),
    recovery: record.failure ?? null
  }
}

export function publishGraphicsSnapshot(): void {
  const snapshot = getGraphicsSnapshot()
  listeners.forEach((listener) => listener(snapshot))
}

export function onGraphicsChanged(listener: (snapshot: GraphicsSnapshot) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Only the owning instance may record a startup attempt; a second launch must not poison it. */
export function initializeGraphicsRecovery(): void {
  ensureState()
  if (hardwareRequested) record.pendingSince = new Date().toISOString()
  save()
  // Feature status can be empty at ready and changes again after driver loss.
  app.on('gpu-info-update', publishGraphicsSnapshot)
  app.on('child-process-gone', (_event, details) => {
    if (
      !hardwareRequested ||
      details.type !== 'GPU' ||
      !['crashed', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'oom'].includes(
        details.reason
      )
    )
      return
    record.failure = {
      reason: 'gpu-process-failed',
      at: new Date().toISOString(),
      exitCode: details.exitCode
    }
    delete record.pendingSince
    if (healthyTimer) clearTimeout(healthyTimer)
    save()
    publishGraphicsSnapshot()
  })
  app.on('will-quit', () => {
    if (healthyTimer) clearTimeout(healthyTimer)
    delete record.pendingSince
    save()
  })
}

export function confirmGraphicsStartup(): void {
  ensureState()
  if (!hardwareRequested || healthyTimer) return
  healthyTimer = setTimeout(() => {
    healthyTimer = undefined
    delete record.pendingSince
    if (app.getGPUFeatureStatus().gpu_compositing === 'enabled') delete record.failure
    save()
    publishGraphicsSnapshot()
  }, 5_000)
  healthyTimer.unref()
}

export function resetGraphicsRecovery(): GraphicsSnapshot {
  ensureState()
  delete record.failure
  // Retain an in-flight startup sentinel until the window has proved healthy.
  save()
  publishGraphicsSnapshot()
  return getGraphicsSnapshot()
}
