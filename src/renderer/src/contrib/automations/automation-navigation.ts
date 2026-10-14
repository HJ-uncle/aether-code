import { setAppMode } from '@renderer/core/platform/app-mode'

const EVENT = 'aether:open-automation'
export function openAutomationEditor(jobId: string): void {
  setAppMode('work')
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { jobId } }))
}
export function subscribeAutomationEditor(listener: (jobId: string) => void): () => void {
  const handle = (event: Event): void => {
    const detail: unknown = (event as CustomEvent).detail
    if (detail && typeof detail === 'object' && 'jobId' in detail && typeof detail.jobId === 'string') listener(detail.jobId)
  }
  window.addEventListener(EVENT, handle)
  return () => window.removeEventListener(EVENT, handle)
}
