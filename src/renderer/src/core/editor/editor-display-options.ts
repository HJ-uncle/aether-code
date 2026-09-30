import type { editor } from 'monaco-editor'

export interface EditorDisplayOptions {
  fontFamily: string
  fontSize: number
  /** 像素值，直接传给 Monaco，避免字号变化时行距含义改变。 */
  lineHeight: number
  fontLigatures: boolean
  tabSize: number
  wordWrap: 'off' | 'on'
  minimapEnabled: boolean
}

export const EDITOR_DISPLAY_STORAGE_KEY = 'aether.editor.displayOptions'
export const DEFAULT_EDITOR_DISPLAY_OPTIONS: Readonly<EditorDisplayOptions> = Object.freeze({
  fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
  tabSize: 2,
  wordWrap: 'off',
  minimapEnabled: true
})

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback
}

/** 存储可能来自旧版本或被手动改过，不能把坏字号/换行值直接交给 Monaco。 */
export function normalizeEditorDisplayOptions(value: unknown): EditorDisplayOptions {
  const defaults = DEFAULT_EDITOR_DISPLAY_OPTIONS
  const stored = typeof value === 'object' && value !== null ? value : {}
  const field = (key: keyof EditorDisplayOptions): unknown => Reflect.get(stored, key)
  const fontFamily = field('fontFamily')
  const fontSize = boundedInteger(field('fontSize'), 10, 32, defaults.fontSize)
  return {
    fontFamily: typeof fontFamily === 'string' && fontFamily.trim() && fontFamily.length <= 256
      ? fontFamily.trim()
      : defaults.fontFamily,
    fontSize,
    lineHeight: Math.max(fontSize, boundedInteger(field('lineHeight'), 16, 64, defaults.lineHeight)),
    fontLigatures: typeof field('fontLigatures') === 'boolean' ? field('fontLigatures') === true : defaults.fontLigatures,
    tabSize: boundedInteger(field('tabSize'), 1, 8, defaults.tabSize),
    wordWrap: field('wordWrap') === 'on' ? 'on' : defaults.wordWrap,
    minimapEnabled: typeof field('minimapEnabled') === 'boolean' ? field('minimapEnabled') === true : defaults.minimapEnabled
  }
}

export function parseEditorDisplayOptions(serialized: string | null): EditorDisplayOptions {
  try {
    return normalizeEditorDisplayOptions(serialized ? JSON.parse(serialized) : null)
  } catch {
    return { ...DEFAULT_EDITOR_DISPLAY_OPTIONS }
  }
}

function loadOptions(): EditorDisplayOptions {
  try {
    return parseEditorDisplayOptions(localStorage.getItem(EDITOR_DISPLAY_STORAGE_KEY))
  } catch {
    // 存储不可用时仍可编辑，当前会话的偏好由内存保存。
    return { ...DEFAULT_EDITOR_DISPLAY_OPTIONS }
  }
}

// 放在实例之外，切标签、重建编辑器与重启应用都沿用同一份偏好。
let options: Readonly<EditorDisplayOptions> = loadOptions()
const listeners = new Set<(options: Readonly<EditorDisplayOptions>) => void>()

export function getEditorDisplayOptions(): Readonly<EditorDisplayOptions> {
  return options
}

export function setEditorDisplayOptions(patch: Partial<EditorDisplayOptions>): void {
  const next = normalizeEditorDisplayOptions({ ...options, ...patch })
  if (JSON.stringify(next) === JSON.stringify(options)) return
  options = next
  try {
    localStorage.setItem(EDITOR_DISPLAY_STORAGE_KEY, JSON.stringify(options))
  } catch {
    // 偏好落盘失败不应中断 Monaco 的显示更新。
  }
  for (const listener of listeners) listener(options)
}

export function resetEditorDisplayOptions(): void {
  setEditorDisplayOptions(DEFAULT_EDITOR_DISPLAY_OPTIONS)
}

export function toMonacoEditorOptions(
  value: Readonly<EditorDisplayOptions> = getEditorDisplayOptions()
): editor.IEditorOptions & editor.IGlobalEditorOptions {
  return {
    fontFamily: value.fontFamily,
    fontSize: value.fontSize,
    lineHeight: value.lineHeight,
    fontLigatures: value.fontLigatures,
    tabSize: value.tabSize,
    wordWrap: value.wordWrap,
    // Git / diagnostics decorations use the same right-side overview ruler as VS Code.
    // Keep the ruler explicit so a future Monaco default change cannot hide those marks.
    overviewRulerLanes: 3,
    minimap: { enabled: value.minimapEnabled, maxColumn: 80 }
  }
}

export function onEditorDisplayOptionsChanged(
  listener: (options: Readonly<EditorDisplayOptions>) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
