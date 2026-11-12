import type { BrowserNetworkEntry } from '@shared/browser'

export function networkDuration(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`
}

export function networkSize(value?: number): string {
  if (value === undefined) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function networkStatus(entry: BrowserNetworkEntry): string {
  if (entry.error) return entry.status ? `${entry.status} · 失败` : '失败'
  return entry.status ? String(entry.status) : entry.finished ? '—' : '等待中'
}

export function requestName(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname.split('/').filter(Boolean).pop() || parsed.host}${parsed.search}`
  } catch {
    return url
  }
}
