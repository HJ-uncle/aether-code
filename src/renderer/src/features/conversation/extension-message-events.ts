export interface ExtensionMessageState { seen: ReadonlyMap<string, string>; newest: number }
export interface ExtensionMessage { id: string; role: string; status: string; createdAt: number; content: string }
export interface ExtensionMessageEvent { name: 'message.created' | 'message.completed'; message: ExtensionMessage }
const terminal = (status: string): boolean => ['done', 'error', 'aborted', 'interrupted'].includes(status)

/** History hydration is a baseline, not a new message. Ignore newly paged older rows. */
export function observeExtensionMessages(previous: ExtensionMessageState | null, messages: readonly ExtensionMessage[]): { state: ExtensionMessageState; events: ExtensionMessageEvent[] } {
  const seen = new Map(previous?.seen), events: ExtensionMessageEvent[] = []
  let newest = previous?.newest ?? 0
  for (const message of messages) {
    const status = seen.get(message.id)
    if (previous && status === undefined && message.createdAt >= previous.newest) events.push({ name: 'message.created', message })
    if (previous && message.role === 'assistant' && terminal(message.status) &&
      (status !== undefined && !terminal(status) || status === undefined && message.createdAt >= previous.newest)) events.push({ name: 'message.completed', message })
    if (status !== message.status) { seen.delete(message.id); seen.set(message.id, message.status) }
    newest = Math.max(newest, message.createdAt || 0)
  }
  while (seen.size > 2000) seen.delete(seen.keys().next().value!)
  return { state: { seen, newest }, events }
}
