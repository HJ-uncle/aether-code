import type { BrowserContext, BrowserSettings, BrowserViewport } from '../../shared/browser'

/** Address input accepts a hostname, but never promotes executable/local protocols. */
export function normalizeBrowserUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('浏览器地址无效')
  const value = input.trim()
  if (!value || value === 'about:blank') return 'about:blank'
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error('浏览器地址不能包含空白或控制字符')
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)
  const withScheme = local ? `http://${value}` : /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
  let url: URL
  try { url = new URL(withScheme) } catch { throw new Error('请输入有效的网页地址') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('内置浏览器仅支持 HTTP、HTTPS 和 about:blank 地址')
  if (url.username || url.password) throw new Error('请在网页中登录，不要将账号密码放入地址')
  return url.href
}

export function validateViewport(value: BrowserViewport | null): BrowserViewport | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('浏览器视口参数无效')
  for (const dimension of [value.width, value.height]) {
    if (!Number.isInteger(dimension) || dimension < 240 || dimension > 3840) throw new Error('视口宽高应为 240–3840 像素之间的整数')
  }
  if (typeof value.mobile !== 'boolean' || !Number.isFinite(value.deviceScaleFactor) || value.deviceScaleFactor < 1 || value.deviceScaleFactor > 3) throw new Error('设备模拟参数无效')
  return { width: value.width, height: value.height, mobile: value.mobile, deviceScaleFactor: value.deviceScaleFactor }
}

export function validateZoom(value: number): number {
  if (!Number.isFinite(value) || value < 0.25 || value > 3) throw new Error('页面缩放应为 25%–300%')
  return value
}

export function validateContext(value: BrowserContext): BrowserContext {
  if (!value || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 500 || typeof value.engineId !== 'string' || !value.engineId || value.engineId.length > 1000) throw new Error('浏览器会话身份无效')
  return { sessionId: value.sessionId, engineId: value.engineId }
}

export function contextsMatch(left: BrowserContext | undefined, right: BrowserContext): boolean {
  return !!left && left.sessionId === right.sessionId && left.engineId === right.engineId
}

export function validateSettings(previous: BrowserSettings, patch: Partial<BrowserSettings>): BrowserSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('浏览器设置无效')
  const next = { ...previous }
  if (patch.homeUrl !== undefined) next.homeUrl = normalizeBrowserUrl(patch.homeUrl)
  if (patch.zoomFactor !== undefined) next.zoomFactor = validateZoom(patch.zoomFactor)
  if (patch.defaultViewport !== undefined) next.defaultViewport = validateViewport(patch.defaultViewport)
  for (const name of ['persistSession', 'aiEnabled'] as const) {
    if (patch[name] !== undefined) {
      if (typeof patch[name] !== 'boolean') throw new Error('浏览器设置开关无效')
      next[name] = patch[name]
    }
  }
  return next
}

export function clampBounds(bounds: { x: number; y: number; width: number; height: number }, window: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  if (!bounds || [bounds.x, bounds.y, bounds.width, bounds.height].some((value) => !Number.isFinite(value))) throw new Error('浏览器区域尺寸无效')
  const x = Math.min(window.width, Math.max(0, Math.round(bounds.x)))
  const y = Math.min(window.height, Math.max(0, Math.round(bounds.y)))
  return { x, y, width: Math.min(window.width - x, Math.max(0, Math.round(bounds.width))), height: Math.min(window.height - y, Math.max(0, Math.round(bounds.height))) }
}

export function browserError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
