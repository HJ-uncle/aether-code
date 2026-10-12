import { useEffect, useSyncExternalStore } from 'react'
import { resolveVisualEffects, type GraphicsSnapshot, type VisualEffects } from '@shared/graphics'

let snapshot: GraphicsSnapshot | null = null
const listeners = new Set<() => void>()
let disconnect: (() => void) | undefined
let revision = 0
function publish(next: GraphicsSnapshot): void {
  snapshot = next
  listeners.forEach((listener) => listener())
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!disconnect) {
    const requestRevision = ++revision
    disconnect = window.aether.graphics.onChanged((next) => {
      revision++
      publish(next)
    })
    void window.aether.graphics
      .getSnapshot()
      .then((next) => {
        if (revision === requestRevision) publish(next)
      })
      .catch(() => {
        /* The safe first-frame material remains opaque. */
      })
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      disconnect?.()
      disconnect = undefined
      revision++
    }
  }
}
export function useGraphicsSnapshot(): GraphicsSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** Apply at html so body portals and both application modes share the same budget. */
export function useVisualEffects(preference: VisualEffects): void {
  const graphics = useGraphicsSnapshot()
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const apply = (): void => {
      document.documentElement.dataset.visualEffects = resolveVisualEffects(
        preference,
        graphics?.hardwareAcceleration === true,
        media.matches
      )
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preference, graphics])
}
