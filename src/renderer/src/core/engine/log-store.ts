import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { onEngineLog } from './client'
import { createEngineLogBuffer, type EngineLogSnapshot } from './log-buffer'

const buffer = createEngineLogBuffer()
const EMPTY: EngineLogSnapshot = Object.freeze({ entries: Object.freeze([]), discarded: 0 })
const subscribeNothing = (): (() => void) => () => {}
let captureOwners = 0
let captureGeneration = 0
let stopCapture: (() => void) | undefined

/** The application owns capture; opening or hiding Output only owns rendering. */
export function captureEngineLogs(): () => void {
  captureOwners++
  if (captureOwners === 1) {
    const generation = ++captureGeneration
    try {
      stopCapture = onEngineLog((entry) => {
        if (captureOwners && generation === captureGeneration) buffer.append(entry)
      })
    } catch (error) {
      captureOwners--
      throw error
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--captureOwners) return
    captureGeneration++
    stopCapture?.()
    stopCapture = undefined
    buffer.flush()
  }
}

export const getEngineLogs = buffer.getSnapshot
export const subscribeEngineLogs = buffer.subscribe
export const clearEngineLogs = buffer.clear

export function useEngineLogs(visible: boolean): EngineLogSnapshot {
  // PanelArea keeps hidden views mounted. Freeze the last rendered snapshot
  // so hiding Output stops its updates without throwing away its scroll DOM.
  const rendered = useRef(EMPTY)
  const readSnapshot = useCallback(() => (visible ? getEngineLogs() : rendered.current), [visible])
  const snapshot = useSyncExternalStore(
    visible ? subscribeEngineLogs : subscribeNothing,
    readSnapshot
  )
  useLayoutEffect(() => {
    rendered.current = snapshot
  }, [snapshot])
  return snapshot
}
