import { memo, useMemo, useState, type JSX } from 'react'
import { Dialog } from '@renderer/workbench/Dialog'
import { BrowserSnapshotResult } from './BrowserSnapshotResult'
import { parseToolResult, type ParsedToolResult, type ToolResultImage } from './tool-result'
import './tool-result.css'

function ResultImage({ image }: { image: ToolResultImage }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [failedSource, setFailedSource] = useState('')
  const failed = failedSource === image.src
  return (
    <figure className="tool-result__image">
      {failed ? <div className="tool-result__image-error" role="status">图片无法显示</div> : (
        <button type="button" className="tool-result__preview" aria-label={`放大查看 ${image.alt}`} onClick={() => setExpanded(true)}>
          <img src={image.src} alt={image.alt} decoding="async" onError={() => setFailedSource(image.src)} />
        </button>
      )}
      {expanded ? (
        <Dialog title={image.alt} className="modal--tool-result-image" width={960} onClose={() => setExpanded(false)}>
          <div className="tool-result__expanded"><img src={image.src} alt={image.alt} /></div>
        </Dialog>
      ) : null}
    </figure>
  )
}

/** The same renderer is used for parent tools, child tools and restored history. */
export const ToolResult = memo(function ToolResult({
  value,
  parsed,
  toolName,
  textClassName
}: {
  value?: unknown
  parsed?: ParsedToolResult
  toolName?: string
  textClassName?: string
}): JSX.Element {
  const result = useMemo(() => parsed ?? parseToolResult(value), [parsed, value])
  if (!result.images.length && !result.browserSnapshots?.length) return <pre className={textClassName}>{result.text}</pre>
  return (
    <div className="tool-result">
      <div className="tool-result__images">
        {result.images.map((image, index) => <ResultImage key={`${index}:${image.alt}`} image={image} />)}
        {result.browserSnapshots?.map((snapshot, index) => <BrowserSnapshotResult key={`${index}:${snapshot.url}`} snapshot={snapshot} clickResult={toolName === 'browser_click'} />)}
      </div>
      {result.text ? (
        <details className="tool-result__metadata">
          <summary>{result.browserSnapshots?.length ? '原始数据' : '结果详情'}</summary>
          <pre className={textClassName}>{result.text}</pre>
        </details>
      ) : null}
    </div>
  )
})
