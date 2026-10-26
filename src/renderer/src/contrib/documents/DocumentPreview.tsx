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

class PreviewBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): ReactNode { return this.state.failed ? <PreviewMessage error="预览组件暂时无法加载。" onRetry={this.props.onRetry} /> : this.props.children }
}

function DocumentPreviewContent({ name, base64, size, identityKey }: Omit<DocumentPreviewProps, 'active'>): JSX.Element {
  const [attempt, retry] = useState(0)
  const kind = documentKindFor(name)
  const input = useMemo(() => {
    try { return { data: documentBytes(base64, size) } }
    catch (reason: unknown) { return { error: previewErrorMessage(reason) } }
  }, [base64, size])
  return <section className="document-preview" data-document-preview={kind || 'unsupported'} aria-label={`${name}文档预览`}>
    <div className="document-preview__content" key={attempt}>
      {input.error || !kind || !input.data ? <PreviewMessage error={input.error || '此格式暂不支持预览。'} /> :
        <PreviewBoundary onRetry={() => retry(value => value + 1)}><Suspense fallback={<PreviewMessage />}>
          {kind === 'pdf' ? <PdfPreview data={input.data} name={name} onRetry={() => retry(value => value + 1)} /> :
            kind === 'xlsx' ? <SpreadsheetPreview data={input.data} sessionKey={`${identityKey || name}:${attempt}`} onRetry={() => retry(value => value + 1)} /> : <OfficePreview data={input.data} kind={kind} name={name} onRetry={() => retry(value => value + 1)} />}
        </Suspense></PreviewBoundary>}
    </div>
  </section>
}
