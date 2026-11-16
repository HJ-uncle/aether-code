import { randomUUID } from 'node:crypto'

/** One outstanding payload per stream. Slow consumers apply backpressure, never a deadline. */
export class StreamAcknowledgement {
  private pending?: { id: string; finish: (error?: unknown) => void }

  async deliver(send: (ackId: string) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.pending) throw new Error('Stream delivery must await its previous acknowledgement')
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID()
      const finish = (error?: unknown): void => {
        if (this.pending?.id !== id) return
        this.pending = undefined; signal.removeEventListener('abort', aborted)
        if (error !== undefined) reject(error); else resolve()
      }
      const aborted = (): void => finish(signal.reason ?? new Error('Stream cancelled'))
      this.pending = { id, finish }
      signal.addEventListener('abort', aborted, { once: true })
      try { send(id) } catch (error) { finish(error) }
    })
  }

  acknowledge(id: string): boolean {
    if (this.pending?.id !== id) return false
    this.pending.finish(); return true
  }
}
