import { Component, lazy, Suspense, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { useDocumentContextMenu } from '@renderer/core/editor/useDocumentContextMenu'
import { documentBytes, documentKindFor, previewErrorMessage } from './document-kind'
import { PreviewMessage } from './preview-controls'
import './document-preview.css'

const PdfPreview = lazy(() => import('./PdfDocumentPreview'))
const OfficePreview = lazy(() => import('./OfficeDocumentPreview'))
const SpreadsheetPreview = lazy(() => import('./SpreadsheetDocumentPreview'))

export interface DocumentPreviewProps {
  name: string
  /** Parser identity is independent of the user-visible delivery name. */
  formatName?: string
  base64?: string
  /** Direct preview bytes avoid a base64 round trip for Office and PDF. */
  data?: ArrayBuffer
  size: number
  /** Include the task/source epoch when the surrounding panel is reused. */
  identityKey?: string
  /** Hidden previews retain their bounded parser and page for instant Work tab reuse. */
  active?: boolean
}

export function DocumentPreview({ active = true, ...props }: DocumentPreviewProps): JSX.Element | null {
  const host = useRef<HTMLDivElement>(null)
  const { menu } = useDocumentContextMenu(host, { active,
    getContentRoot: target => target?.closest<HTMLElement>('.document-preview__notes-content') ??
      host.current?.querySelector<HTMLElement>('.document-preview__body') ?? null })
  return <><div ref={host} className="document-preview-host" hidden={!active} tabIndex={0}><DocumentPreviewContent key={JSON.stringify([props.identityKey, props.name, props.formatName])} {...props} active={active} /></div>{menu}</>
}

class PreviewBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): ReactNode { return this.state.failed ? <PreviewMessage error="预览组件暂时无法加载。" onRetry={this.props.onRetry} /> : this.props.children }
}

function DocumentPreviewContent({ name, formatName = name, base64, data, size, identityKey, active }: Omit<DocumentPreviewProps, 'active'> & { active: boolean }): JSX.Element {
  const [attempt, retry] = useState(0)
  const kind = documentKindFor(formatName)
  const input = useMemo(() => {
    try { return data ? { data } : base64 !== undefined ? { data: documentBytes(base64, size) } : { error: '文件内容不完整，请重新读取后再试。' } }
    catch (reason: unknown) { return { error: previewErrorMessage(reason) } }
  }, [base64, data, size])
  return <section className="document-preview" data-document-preview={kind || 'unsupported'} aria-label={`${name}文档预览`}>
    <div className="document-preview__content" key={attempt}>
      {input.error || !kind || !input.data ? <PreviewMessage error={input.error || '此格式暂不支持预览。'} /> :
        <PreviewBoundary onRetry={() => retry(value => value + 1)}><Suspense fallback={<PreviewMessage />}>
          {kind === 'pdf' ? <PdfPreview data={input.data} name={name} sessionKey={identityKey || name} active={active} onRetry={() => retry(value => value + 1)} /> :
            kind === 'xlsx' ? <SpreadsheetPreview data={input.data} sessionKey={`${identityKey || name}:${attempt}`} onRetry={() => retry(value => value + 1)} /> : <OfficePreview data={input.data} kind={kind} name={name} sessionKey={identityKey || name} active={active} onRetry={() => retry(value => value + 1)} />}
        </Suspense></PreviewBoundary>}
    </div>
  </section>
}
