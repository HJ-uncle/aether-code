export type PdfTextStatus = 'loading' | 'ready' | 'empty' | 'unavailable'
export interface PdfTextTask {
  render(): Promise<unknown>
  cancel(): void
  readonly textContentItemsStr: readonly string[]
}

/** Own just the visible page's text stream and DOM. Late work may never write
 * into a newer zoom, another page, or a hidden retained preview. */
export function startPdfTextLayer(
  target: HTMLElement,
  prepare: () => Promise<() => PdfTextTask>,
  status: (value: PdfTextStatus) => void,
  timeoutMs: number
): () => void {
  let disposed = false, task: PdfTextTask | undefined
  target.replaceChildren()
  status('loading')
  const fail = (): void => {
    if (disposed) return
    disposed = true
    task?.cancel()
    target.replaceChildren()
    status('unavailable')
  }
  const timeout = setTimeout(fail, timeoutMs)
  void (async () => {
    const create = await prepare()
    if (disposed) return
    task = create()
    await task.render()
    if (!disposed) status(task.textContentItemsStr.some(text => text.trim()) ? 'ready' : 'empty')
  })().catch(fail).finally(() => clearTimeout(timeout))
  return () => {
    disposed = true
    clearTimeout(timeout)
    task?.cancel()
    target.replaceChildren()
  }
}
