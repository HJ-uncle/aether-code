import type { BrowserContext, BrowserSurfaceOwner, BrowserTabPresentation } from '../../shared/browser'

export function validatePresentation(value: BrowserTabPresentation): BrowserTabPresentation {
  if (!value || !['code', 'work'].includes(value.mode)
    || value.sessionId !== null && (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 500)
    || value.engineId !== undefined && (typeof value.engineId !== 'string' || !value.engineId || value.engineId.length > 1000)
    || value.pendingSourceId !== undefined && (typeof value.pendingSourceId !== 'string' || !value.pendingSourceId || value.pendingSourceId.length > 2000)
    || value.engineId !== undefined && value.pendingSourceId !== undefined)
    throw new Error('浏览器展示归属无效')
  return { mode: value.mode, sessionId: value.sessionId, ...(value.engineId ? { engineId: value.engineId } : {}),
    ...(value.pendingSourceId ? { pendingSourceId: value.pendingSourceId } : {}) }
}

export function presentationsMatch(left: BrowserTabPresentation | undefined, right: BrowserTabPresentation | undefined): boolean {
  return Boolean(left && right && left.mode === right.mode && left.sessionId === right.sessionId && left.engineId === right.engineId
    && left.pendingSourceId === right.pendingSourceId)
}

/** A context may gain a presentation after its background native tab exists. */
export class BrowserPresentationRegistry {
  private readonly presentations = new Map<string, BrowserTabPresentation>()
  private key(context: BrowserContext): string { return JSON.stringify([context.engineId, context.sessionId]) }
  remember(context: BrowserContext, mode: 'code' | 'work'): BrowserTabPresentation {
    const value = validatePresentation({ mode, sessionId: context.sessionId, engineId: context.engineId })
    const previous = this.presentations.get(this.key(context))
    if (previous && !presentationsMatch(previous, value)) throw new Error('浏览器会话已有不同的展示模式')
    this.presentations.set(this.key(context), value)
    return { ...value }
  }
  get(context: BrowserContext | undefined): BrowserTabPresentation | undefined {
    const value = context && this.presentations.get(this.key(context))
    return value ? { ...value } : undefined
  }
  clear(): void { this.presentations.clear() }
}

/** Presentation is separate from tab/session lifetime and background tool access. */
export class BrowserSurfaceOwnership {
  private owner: BrowserSurfaceOwner | null = null
  private controlled = false

  activate(value: BrowserSurfaceOwner): boolean {
    if (!value || !['code', 'work'].includes(value.mode) || !Number.isSafeInteger(value.generation) || value.generation < 0) {
      throw new Error('浏览器展示模式或代次无效')
    }
    if (this.owner && value.generation <= this.owner.generation) return false
    this.controlled = true
    this.owner = { ...validatePresentation({ ...value, sessionId: value.sessionId ?? null }), generation: value.generation }
    return true
  }

  accepts(value?: BrowserSurfaceOwner): boolean {
    // Standalone native hosts can own geometry directly. The desktop IPC host
    // calls reset before admitting a renderer, making an owner mandatory.
    if (!this.controlled) return value === undefined
    return Boolean(value && this.owner && value.generation === this.owner.generation
      && presentationsMatch({ ...value, sessionId: value.sessionId ?? null }, this.currentPresentation()))
  }

  currentPresentation(): BrowserTabPresentation | undefined {
    if (!this.owner) return undefined
    const { generation: _generation, ...value } = this.owner
    return { ...value, sessionId: value.sessionId ?? null }
  }

  canPresent(tab: BrowserTabPresentation | undefined): boolean {
    return !this.controlled || presentationsMatch(tab, this.currentPresentation())
  }

  reset(): void { this.controlled = true; this.owner = null }
}
