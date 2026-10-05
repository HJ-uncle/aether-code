import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type JSX } from 'react'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { cssVar, watchTheme } from '@renderer/core/theme/palette'
import { monaco } from '@renderer/core/editor/monaco-setup'
import { openWorkspaceResource } from '@renderer/core/editor/monaco-workspace'
import { resolvePreviewResource } from '@renderer/core/editor/preview-resource-path'
import { toast } from '@renderer/core/toast'
import { buildSourcePreviewDocument } from './source-preview-document'
import bridgeSource from './preview-bridge.js?raw'
import './source-preview.css'

function toDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return `data:text/html;base64,${btoa(binary)}`
}

export interface SourcePreviewHandle {
  scrollToRatio: (ratio: number) => void
}

export const SourcePreview = forwardRef<SourcePreviewHandle, {
  filePath: string
  content: string
  kind: 'markdown' | 'html'
  onScroll: (ratio: number) => void
}>(function SourcePreview({ filePath, content, kind, onScroll }, ref): JSX.Element {
  const { root } = useWorkspace()
  const frame = useRef<HTMLIFrameElement>(null)
  const [channel] = useState(() => crypto.randomUUID())
  const [document, setDocument] = useState('')
  const [error, setError] = useState('')
  const [themeRevision, setThemeRevision] = useState(0)
  const previewSource = useMemo(() => document ? toDataUrl(document) : '', [document])
  const onScrollRef = useRef(onScroll)
  onScrollRef.current = onScroll
  const ratioRef = useRef(0)
  const sendScroll = (ratio: number): void => {
    ratioRef.current = Math.max(0, Math.min(1, ratio))
    frame.current?.contentWindow?.postMessage({ type: 'aether.preview.scrollTo', channel, ratio: ratioRef.current }, '*')
  }
  useImperativeHandle(ref, () => ({ scrollToRatio: sendScroll }))
  useEffect(() => watchTheme(() => setThemeRevision((value) => value + 1)), [])
  useEffect(() => {
    let cancelled = false
    // A short debounce prevents reparsing the entire document on every keystroke.
    const timer = setTimeout(() => {
      void buildSourcePreviewDocument({
        filePath, content, kind, workspaceRoot: root ?? '', channel,
        bridgeScript: bridgeSource.replace(/\r\n?/g, '\n'),
        colors: {
          background: cssVar('--bg-app'), foreground: cssVar('--fg'), muted: cssVar('--fg-muted'),
          border: cssVar('--border'), accent: cssVar('--accent')
        }
      }).then((html) => {
        if (!cancelled) { setDocument(html); setError('') }
      }).catch((reason: unknown) => {
        if (!cancelled) setError(`无法生成预览：${reason instanceof Error ? reason.message : String(reason)}`)
      })
    }, 180)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [filePath, content, kind, root, channel, themeRevision])
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== 'object' || !event.data || event.data.channel !== channel) return
      if (event.data.type === 'aether.preview.ready') sendScroll(ratioRef.current)
      if (event.data.type === 'aether.preview.scroll' && typeof event.data.ratio === 'number' && Number.isFinite(event.data.ratio)) {
        ratioRef.current = Math.max(0, Math.min(1, event.data.ratio))
        onScrollRef.current(ratioRef.current)
      }
      if (event.data.type === 'aether.preview.openFile' && typeof event.data.path === 'string') {
        const safePath = resolvePreviewResource(filePath, event.data.path, root ?? '')
        if (safePath) void openWorkspaceResource(monaco.Uri.file(safePath)).catch(() => toast.error('无法打开预览中的文件链接'))
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
    // The ref contains the current ratio, independent of render timing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, root, channel])
  return <section className="source-preview" aria-label={kind === 'markdown' ? 'Markdown 预览' : 'HTML 预览'}>
    {error ? <div className="source-preview__message" role="alert">{error}</div> : null}
    {!document && !error ? <div className="source-preview__message" role="status">正在生成预览…</div> : null}
    {previewSource ? <iframe ref={frame} title={kind === 'markdown' ? 'Markdown 预览内容' : 'HTML 预览内容'}
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" src={previewSource} /> : null}
  </section>
})
