import type { ParsedToolResult, ToolImageDocumentPage, ToolResultImage } from './tool-result'

export interface ToolImageGalleryItem {
  identity: string
  toolId: string
  imageIndex: number
  image: ToolResultImage
}
export interface ToolImageGalleryGroup { id: string; items: readonly ToolImageGalleryItem[] }
export interface ToolImageGalleryIndex {
  scope: string
  groups: ReadonlyMap<string, ToolImageGalleryGroup>
  images: ReadonlyMap<string, { groupId: string; identity: string }>
}
export const toolImageReference = (toolId: string, imageIndex: number): string => JSON.stringify([toolId, imageIndex])

function argumentsRecord(args: unknown): Record<string, unknown> | null | undefined {
  if (args === undefined) return undefined
  try {
    const value: unknown = typeof args === 'string' ? JSON.parse(args) : args
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function matchesPath(input: unknown, path: string): boolean {
  if (input === undefined) return true
  if (typeof input !== 'string' || !input || input.length > 4096) return false
  let candidate = input.replace(/\\/g, '/').replace(/^\.\//, ''), verified = path
  if (candidate.split('/').some(part => part === '.' || part === '..')) return false
  if (/^(?:[a-z]:\/|\/\/)/i.test(verified)) { candidate = candidate.toLowerCase(); verified = verified.toLowerCase() }
  return /^(?:[a-z]:\/|\/)/i.test(candidate) ? candidate === verified : verified.endsWith('/' + candidate)
}

/** Build from receipts, not mounted rows: collapsed tools and offscreen pages
 * remain available without opening their process panels or repeating a tool. */
export function buildToolImageGallery(results: readonly { toolId: string; toolName: string; args?: unknown; result: ParsedToolResult }[],
  owner: { source: number; sessionId: string }): ToolImageGalleryIndex {
  const scope = JSON.stringify([owner.source, owner.sessionId])
  const groups = new Map<string, ToolImageGalleryGroup>()
  const images = new Map<string, { groupId: string; identity: string }>()
  const pending = new Map<string, Map<string, ToolImageGalleryItem>>()
  // Replayed receipts can occur in both a loaded archive and its live tail.
  const tools = new Map(results.map(result => [result.toolId, result]))
  const candidates: { toolId: string; imageIndex: number; image: ToolResultImage; page?: ToolImageDocumentPage; legacy: boolean }[] = []
  const renderers = new Map<string, Map<string, ToolImageDocumentPage>>()
  const versionKey = (page: Pick<ToolImageDocumentPage, 'path' | 'sha256'>) => JSON.stringify([scope, page.path, page.sha256])
  for (const { toolId, toolName, args, result } of tools.values()) {
    const input = argumentsRecord(args)
    result.images.forEach((image, imageIndex) => {
      let page: ToolImageDocumentPage | undefined, legacy = false
      if (toolName === 'workbench_render' && owner.sessionId && input !== null) {
        const complete = image.documentPage
        if (complete?.sessionId === owner.sessionId && (input?.page === undefined || input.page === complete.page) && matchesPath(input?.path, complete.path)) {
          page = complete
          const key = versionKey(page), known = renderers.get(key) ?? new Map<string, ToolImageDocumentPage>()
          known.set(JSON.stringify([page.renderer, page.pageCount]), page)
          renderers.set(key, known)
        } else if (!complete && image.documentFileVersion && result.images.length === 1 &&
          typeof input?.page === 'number' && Number.isInteger(input.page) && input.page >= 1 && input.page <= 100 &&
          /\.pptx$/i.test(image.documentFileVersion.path) && matchesPath(input.path, image.documentFileVersion.path)) {
          page = { ...image.documentFileVersion, sessionId: owner.sessionId, page: input.page, renderer: 'legacy-workbench-render' }
          legacy = true
        }
      }
      candidates.push({ toolId, imageIndex, image, page, legacy })
    })
  }
  for (const candidate of candidates) {
    const { toolId, imageIndex, image, legacy } = candidate
    let page = candidate.page
    // A unique modern receipt supplies the renderer/count lost by old image
    // budgets. Conflicting versions of that evidence stay in separate groups.
    const known = page && legacy ? renderers.get(versionKey(page)) : undefined
    if (page && known?.size === 1) {
      const modern = [...known.values()][0]
      if (modern.pageCount === undefined || page.page <= modern.pageCount) page = { ...page, renderer: modern.renderer, pageCount: modern.pageCount }
    }
    const groupId = page ? JSON.stringify(['document', scope, page.path, page.sha256, page.renderer, page.pageCount])
      : JSON.stringify(['result', scope, toolId])
    const identity = page ? JSON.stringify([groupId, page.page]) : JSON.stringify([groupId, imageIndex])
    let entries = pending.get(groupId)
    if (!entries) { entries = new Map(); pending.set(groupId, entries) }
    // A repeated check of one unchanged page replaces its older receipt;
    // different pages always retain different identities, even with equal bytes.
    entries.set(identity, { identity, toolId, imageIndex, image: page && page !== image.documentPage ? { ...image, documentPage: page } : image })
    images.set(toolImageReference(toolId, imageIndex), { groupId, identity })
  }
  for (const [id, entries] of pending) {
    const items = [...entries.values()]
    if (items[0]?.image.documentPage && id.startsWith('["document",'))
      items.sort((left, right) => left.image.documentPage!.page - right.image.documentPage!.page)
    groups.set(id, { id, items })
  }
  return { scope, groups, images }
}
