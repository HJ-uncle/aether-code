const listeners = new Set<(url: string) => void>()

/** Cross-mode references use Work's existing task-selection and link validation. */
export function requestOpenConversation(url: string): void {
  if (!listeners.size) throw new Error('会话导航尚未就绪，请稍后重试。')
  for (const listener of listeners) listener(url)
}

export function onOpenConversationRequest(listener: (url: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
