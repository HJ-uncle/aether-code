import type { BrowserSurfaceOwner } from '../../shared/browser'

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
    this.owner = { mode: value.mode, generation: value.generation }
    return true
  }

  accepts(value?: BrowserSurfaceOwner): boolean {
    // Standalone native hosts can own geometry directly. The desktop IPC host
    // calls reset before admitting a renderer, making an owner mandatory.
    if (!this.controlled) return value === undefined
    return Boolean(value && this.owner && value.mode === this.owner.mode && value.generation === this.owner.generation)
  }

  reset(): void { this.controlled = true; this.owner = null }
}
