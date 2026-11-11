import type { EngineRequestInput } from './ipc'

export const OFFICE_RENDER_IPC = 'office:render-page'
export type OfficeRenderFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export interface OfficePageRenderInput {
  html: string
  format: OfficeRenderFormat
  sessionId: string
  expectedEngine: NonNullable<EngineRequestInput['expectedEngine']>
  path: string
  sha256: string
  page: number
  pageCount: number
}
export interface OfficePageRenderResult { dataUrl: string; width: 960; height: 540 }

export type XlsxPreviewRegion = { sheet: number; name: string } & (
  { kind: 'cells'; range: string } | { kind: 'chart'; title: string }
)
export interface XlsxPreviewSheet {
  sheet: number
  name: string
  firstPage: number
  lastPage: number
  chartPages: number[]
}
export interface XlsxPreviewNavigation { sheets: XlsxPreviewSheet[] }
export interface XlsxRenderedDocument {
  pages: string[]
  regions: XlsxPreviewRegion[]
  navigation: XlsxPreviewNavigation
}

export function validateOfficePageRender(input: OfficePageRenderInput): void {
  if (!input || typeof input.html !== 'string' || input.html.length > 16 * 1024 * 1024 || !input.html.trim() ||
    (input.format !== 'docx' && input.format !== 'xlsx' && input.format !== 'pptx' && input.format !== 'pdf') ||
    typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128 ||
    typeof input.path !== 'string' || !new RegExp(`\\.${input.format}$`, 'i').test(input.path) || input.path.length > 4096 ||
    !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isInteger(input.page) || input.page < 1 ||
    !Number.isInteger(input.pageCount) || input.pageCount < input.page || input.pageCount > 100 || !input.expectedEngine)
    throw new Error('办公文件渲染参数无效。')
  // The input is produced by our trusted passive document renderer, never a model-authored
  // URL. Keep defense in depth here even though only the trusted main frame calls IPC.
  if (/<\s*(?:script|iframe|frame|object|embed|link|meta|base|form|input|button|video|audio)\b/i.test(input.html) ||
    /<[^>]*\son[a-z]+\s*=/i.test(input.html) || /<[^>]*\s(?:src|href)\s*=\s*["']\s*(?:https?:|file:|javascript:)/i.test(input.html))
    throw new Error('办公文件包含不能用于离线画面检查的活动内容。')
}
