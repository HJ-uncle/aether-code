import { prepareOfficeArchive, prepareOfficeImage } from './office-archive'
import type { DocumentKind } from './document-kind'

interface PrepareRequest { data: ArrayBuffer; kind: Exclude<DocumentKind, 'pdf'> }
type PrepareResponse = { ok: true; data: ArrayBuffer } | { ok: false; message: string }

onmessage = (event: MessageEvent<PrepareRequest>): void => {
  void prepareOfficeArchive(event.data.data, event.data.kind, new AbortController().signal, { imageProcessor: prepareOfficeImage }).then(data => {
    const response: PrepareResponse = { ok: true, data }
    globalThis.postMessage(response, { transfer: [data] })
  }, (reason: unknown) => {
    postMessage({ ok: false, message: reason instanceof Error ? reason.message : '文档准备失败。' } satisfies PrepareResponse)
  })
}
