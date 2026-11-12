import { useSyncExternalStore } from 'react'

export interface TerminalPreferences {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorBlink: boolean
  scrollback: number
}

export const DEFAULT_TERMINAL_PREFERENCES: Readonly<TerminalPreferences> = Object.freeze({
  fontFamily: 'Consolas, "Cascadia Mono", monospace',
  fontSize: 12,
  lineHeight: 1.2,
  cursorBlink: true,
  scrollback: 5000
})

const STORAGE_KEY = 'aether.terminal.preferences'
const listeners = new Set<() => void>()

function normalize(value: unknown): TerminalPreferences {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const number = (key: keyof TerminalPreferences, min: number, max: number, fallback: number): number => {
    const next = raw[key]
    return typeof next === 'number' && Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : fallback
  }
  return {
    fontFamily: typeof raw.fontFamily === 'string' && raw.fontFamily.trim() ? raw.fontFamily.trim().slice(0, 256) : DEFAULT_TERMINAL_PREFERENCES.fontFamily,
    fontSize: Math.round(number('fontSize', 8, 32, DEFAULT_TERMINAL_PREFERENCES.fontSize)),
    lineHeight: number('lineHeight', 1, 2.5, DEFAULT_TERMINAL_PREFERENCES.lineHeight),
    cursorBlink: typeof raw.cursorBlink === 'boolean' ? raw.cursorBlink : DEFAULT_TERMINAL_PREFERENCES.cursorBlink,
    scrollback: Math.round(number('scrollback', 500, 50000, DEFAULT_TERMINAL_PREFERENCES.scrollback))
  }
}

function load(): TerminalPreferences {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return { ...DEFAULT_TERMINAL_PREFERENCES }
  }
}

let preferences: Readonly<TerminalPreferences> = load()

export function getTerminalPreferences(): Readonly<TerminalPreferences> {
  return preferences
}

export function useTerminalPreferences(): Readonly<TerminalPreferences> {
  return useSyncExternalStore(onTerminalPreferencesChanged, getTerminalPreferences)
}

export function onTerminalPreferencesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setTerminalPreferences(patch: Partial<TerminalPreferences>): void {
  const next = normalize({ ...preferences, ...patch })
  if (JSON.stringify(next) === JSON.stringify(preferences)) return
  preferences = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)) } catch { /* 当前会话仍可使用 */ }
  for (const listener of listeners) listener()
}

export function resetTerminalPreferences(): void {
  setTerminalPreferences(DEFAULT_TERMINAL_PREFERENCES)
}
