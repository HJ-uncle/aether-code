import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { parseLaunchInstance } from '../shared/instance-profile'

/**
 * A normal launch keeps the historical profile and single-instance behavior.
 * `--new-instance` gets a fresh profile, while `--aether-instance=<id>` gives
 * a repeatable profile that can be used by a launcher or a test harness.
 */
export interface LaunchInstanceProfile {
  readonly mode: 'default' | 'named' | 'new'
  readonly id: string | null
  readonly userDataPath: string
}

/** Configure a profile before any module starts reading settings or engine state. */
export function configureLaunchInstance(
  argv: readonly string[] = process.argv
): LaunchInstanceProfile {
  const requested = parseLaunchInstance(
    argv,
    `instance-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  const base = app.getPath('userData')
  const userDataPath = requested.id ? join(base, 'instances', requested.id) : base
  if (requested.id) {
    // Isolating the Chromium profile also isolates settings, credentials and
    // engine SQLite state. Port leases intentionally live in a shared temp
    // directory so separate profiles can coordinate automatic port selection.
    app.setPath('userData', userDataPath)
    process.env.AETHER_DESKTOP_INSTANCE_ID = requested.id
  }
  return { ...requested, userDataPath }
}
