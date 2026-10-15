import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'

const observed = new WeakSet<BrowserWindow>()

/** Chromium visibility can stay visible under debugging or an unthrottled guest.
 * Native ownership is authoritative for whether workbench probes should run. */
export function readWindowVisibility(owner: BrowserWindow): boolean {
  const visible = (): boolean => !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized()
  if (!observed.has(owner)) {
    observed.add(owner)
    let previous = visible()
    const changed = (): void => {
      const next = visible()
      if (next === previous || owner.webContents.isDestroyed()) return
      previous = next
      // A guest or a second workbench must never receive another owner's state.
      owner.webContents.send(IPC.event.windowVisibility, next)
    }
    owner.on('show', changed)
    owner.on('hide', changed)
    owner.on('minimize', changed)
    owner.on('restore', changed)
  }
  return visible()
}
