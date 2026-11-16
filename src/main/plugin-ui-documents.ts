import { randomUUID } from 'node:crypto'
import { PLUGIN_UI_SCHEME } from '../shared/plugin-ui'

interface Entry { ownerId: number; html: string; bytes: number }
/** Opaque URLs are owned and released by the window; none resolve against a filesystem. */
export class PluginUiDocuments {
  private readonly documents = new Map<string, Entry>()
  create(ownerId: number, html: unknown): { url: string } {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || typeof html !== 'string') throw new Error('插件页面参数无效。')
    const bytes = Buffer.byteLength(html)
    if (!bytes) throw new Error('插件页面不能为空。')
    const url = `${PLUGIN_UI_SCHEME}://document/${randomUUID()}`
    this.documents.set(url, { ownerId, html, bytes }); return { url }
  }
  read(url: string): Readonly<Entry> | undefined {
    // Exact-key lookup rejects traversal, encoded separators, queries, foreign hosts and arbitrary paths.
    return this.documents.get(url)
  }
  release(ownerId: number, url: unknown): void {
    if (typeof url !== 'string' || this.documents.get(url)?.ownerId !== ownerId) return
    this.documents.delete(url)
  }
  releaseOwner(ownerId: number): void { for (const [url, entry] of this.documents) if (entry.ownerId === ownerId) this.documents.delete(url) }
}
