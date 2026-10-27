import type { DocumentKind } from './document-kind'

type PrepareResponse = { ok: true; data: ArrayBuffer } | { ok: false; message: string }

/** ZIP expansion, XML normalization and JSZip serialization run off the UI
 * thread. docx-preview/pptx-to-html still require DOM work in the component. */
export function prepareOfficeArchiveOffThread(data: ArrayBuffer, kind: Exclude<DocumentKind, 'pdf'>, signal: AbortSignal): Promise<ArrayBuffer> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = new Worker(new URL('./office-archive.worker.ts', import.meta.url), { type: 'module', name: 'aether-document-office-archive' })
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      worker.onmessage = null; worker.onerror = null
      worker.terminate()
    }
    const abort = (): void => { cleanup(); reject(signal.reason || new DOMException('预览已取消', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<PrepareResponse>): void => {
      cleanup()
      if (event.data.ok) resolve(event.data.data)
      else reject(new Error(event.data.message))
    }
    worker.onerror = (): void => { cleanup(); reject(new Error('文档后台准备失败，请重试。')) }
    // Do not detach the prop buffer: React StrictMode replays the effect and
    // retry also needs the original immutable bytes.
    const copy = data.slice(0)
    worker.postMessage({ data: copy, kind }, [copy])
  })
}
