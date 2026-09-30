export interface EditorDisplayOptions {
  wordWrap: 'off' | 'on'
  minimapEnabled: boolean
}

// Monaco 实例随标签切换重建，显示偏好必须由实例之外的会话状态持有。
let options: Readonly<EditorDisplayOptions> = { wordWrap: 'off', minimapEnabled: true }
const listeners = new Set<(options: Readonly<EditorDisplayOptions>) => void>()

export function getEditorDisplayOptions(): Readonly<EditorDisplayOptions> {
  return options
}

export function setEditorDisplayOptions(patch: Partial<EditorDisplayOptions>): void {
  const next = { ...options, ...patch }
  if (next.wordWrap === options.wordWrap && next.minimapEnabled === options.minimapEnabled) return
  options = next
  for (const listener of listeners) listener(options)
}

export function onEditorDisplayOptionsChanged(
  listener: (options: Readonly<EditorDisplayOptions>) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
