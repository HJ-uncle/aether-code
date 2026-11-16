export interface FileMutationEvent {
  source: number
  sessionId: string
  workspacePath?: string
  path: string
  previousPath?: string
  operation: 'write' | 'create' | 'mkdir' | 'delete' | 'move' | 'copy' | 'revert'
}
const listeners = new Set<(event: FileMutationEvent) => void>()
export function publishFileMutation(event: FileMutationEvent): void {
  for (const listener of listeners) { try { listener(event) } catch { /* Observers cannot undo a committed write. */ } }
}
export function subscribeFileMutations(listener: (event: FileMutationEvent) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener) }
}
