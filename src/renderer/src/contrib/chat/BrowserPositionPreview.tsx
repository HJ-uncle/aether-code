import { useState, type JSX, type ReactNode } from 'react'
import { Dialog } from '@renderer/workbench/Dialog'
import type { ToolBrowserSnapshot } from './browser-snapshot'

/** The saved image and overlays share CSS viewport coordinates, including in the zoom dialog. */
export function BrowserPositionPreview({ screenshot, viewport, title, description, className, children }: {
  screenshot?: ToolBrowserSnapshot['screenshot']
  viewport: { width: number; height: number }
  title: string
  description: string
  className: string
  children?: ReactNode
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [failedSource, setFailedSource] = useState('')
  const source = screenshot?.dataUrl
  const hasImage = !!source && failedSource !== source
  const { width, height } = viewport
  const map = (large = false): JSX.Element => (
    <svg className={`${className} tool-browser-position__map${hasImage ? ' tool-browser-position__map--image' : ''}${large ? ' tool-browser-position__map--expanded' : ''}`}
      viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description}>
      <rect className="tool-browser-click__viewport" x={0} y={0} width={width} height={height} />
      {hasImage ? <image className="tool-browser-position__image" href={source} x={0} y={0} width={width} height={height}
        preserveAspectRatio="none" onError={() => { setFailedSource(source); setExpanded(false) }} /> : null}
      {children}
    </svg>
  )
  return (
    <>
      {hasImage ? (
        <button type="button" className="tool-browser-position__preview" aria-label={`放大查看 ${title}`}
          title={children ? '放大查看截图与位置' : '放大查看截图'} onClick={() => setExpanded(true)}>{map()}</button>
      ) : children ? map() : null}
      {!hasImage ? <div className="tool-browser-position__hint">
        {source ? '截图无法显示' : '此记录未保存截图'}{children ? '，已显示位置示意图' : ''}
      </div> : null}
      {expanded && hasImage ? (
        <Dialog title={title} className="modal--browser-position" width={1040} onClose={() => setExpanded(false)}>
          {map(true)}
          <div className="tool-browser-position__hint">{description}</div>
        </Dialog>
      ) : null}
    </>
  )
}
