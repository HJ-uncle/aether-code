/** Fixed zoom depends on page size and pixel density, never on its container.
 * Fit-width retains the existing 32px gutter and 2x maximum logical scale. */
export function pdfPreviewRenderIdentity(zoom: number, width: number, pageWidth: number, pageHeight: number, deviceScale: number): { scale: number; key: string } {
  if (!pageWidth || !pageHeight || (!zoom && !width)) return { scale: 1, key: '' }
  const scale = zoom || Math.min(2, Math.max(32, width - 32) / pageWidth)
  const density = Math.min(Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1, 2)
  return { scale, key: `${pageWidth}:${pageHeight}:${scale}:${density}` }
}
