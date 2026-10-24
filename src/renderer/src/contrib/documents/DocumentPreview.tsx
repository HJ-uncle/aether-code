import { Component, lazy, Suspense, useMemo, useState, type JSX, type ReactNode } from 'react'
import { documentBytes, documentKindFor, previewErrorMessage } from './document-kind'
import { PreviewMessage } from './preview-controls'
import './document-preview.css'

const PdfPreview = lazy(() => import('./PdfDocumentPreview'))
const OfficePreview = lazy(() => import('./OfficeDocumentPreview'))
const SpreadsheetPreview = lazy(() => import('./SpreadsheetDocumentPreview'))

export interface DocumentPreviewProps {
  name: string
  base64: string
  size: number
  /** Include the task/source epoch when the surrounding panel is reused. */
  identityKey?: string
  /** Hidden previews unmount parsers, frames and workers. */
  active?: boolean
}

export function DocumentPreview({ active = true, ...props }: DocumentPreviewProps): JSX.Element | null {
  return active ? <DocumentPreviewContent key={JSON.stringify([props.identityKey, props.name])} {...props} /> : null
}

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): ReactNode { return this.state.failed ? <PreviewMessage error="预览组件暂时无法加载，请重新预览。" /> : this.props.children }
}

function DocumentPreviewContent({ name, base64, size }: Omit<DocumentPreviewProps, 'active'>): JSX.Element {
  const [attempt, retry] = useState(0)
  const kind = documentKindFor(name)
  const input = useMemo(() => {
    try { return { data: documentBytes(base64, size) } }
    catch (reason: unknown) { return { error: previewErrorMessage(reason) } }
  }, [base64, size])
  return <section className="document-preview" data-document-preview={kind || 'unsupported'} aria-label={`${name}文档预览`}>
    <div className="document-preview__content" key={attempt}>
      {input.error || !kind || !input.data ? <PreviewMessage error={input.error || '此格式暂不支持预览。'} /> :
        <PreviewBoundary><Suspense fallback={<PreviewMessage />}>
          {kind === 'pdf' ? <PdfPreview data={input.data} name={name} /> :
            kind === 'xlsx' ? <SpreadsheetPreview data={input.data} /> : <OfficePreview data={input.data} kind={kind} name={name} />}
        </Suspense></PreviewBoundary>}
    </div>
    <footer className="document-preview__footer">
      <span title={kind === 'pptx' ? '部分复杂图形、动画及字体可能与原件不同。' : '原件保持不变；复杂排版和公式显示可能与本机办公软件不同。'}>只读预览 · 原件保持不变</span>
      <button type="button" onClick={() => retry(value => value + 1)}>重新预览</button>
    </footer>
  </section>
}
