import type { BrowserViewport } from '@shared/browser'

export const PHONE_VIEWPORT: BrowserViewport = {
  width: 390,
  height: 844,
  mobile: true,
  deviceScaleFactor: 2
}
export const DESKTOP_VIEWPORT: BrowserViewport = {
  width: 1280,
  height: 800,
  mobile: false,
  deviceScaleFactor: 1
}

/** A mobile flag alone does not identify a size preset; AI can set any viewport. */
export function viewportPreset(
  viewport: BrowserViewport | null | undefined
): 'fit' | 'phone' | 'desktop' | 'custom' {
  if (!viewport) return 'fit'
  const matches = (preset: BrowserViewport): boolean =>
    viewport.width === preset.width &&
    viewport.height === preset.height &&
    viewport.mobile === preset.mobile &&
    viewport.deviceScaleFactor === preset.deviceScaleFactor
  return matches(PHONE_VIEWPORT) ? 'phone' : matches(DESKTOP_VIEWPORT) ? 'desktop' : 'custom'
}

export function customViewportLabel(viewport: BrowserViewport | null | undefined): string {
  return viewport ? `自定义 · ${viewport.width} × ${viewport.height}` : '自定义尺寸…'
}
