import { useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { Dialog } from '@renderer/workbench/Dialog'
import type { ToolBrowserSnapshot } from './browser-snapshot'
import { BrowserClickPosition } from './BrowserClickPosition'
import { BrowserPositionPreview } from './BrowserPositionPreview'

function WorkScreenshot({ screenshot, title = '页面截图' }: { screenshot: NonNullable<ToolBrowserSnapshot['screenshot']>; title?: string }): JSX.Element {
  const source = screenshot.dataUrl
  const [expanded, setExpanded] = useState(false)
  const [failedSource, setFailedSource] = useState('')
  return <figure className="tool-result__image">
    {failedSource === source ? <div className="tool-result__image-error" role="status">页面截图暂时无法显示</div> : (
      <button type="button" className="tool-result__preview" aria-label={`放大查看 ${title}`} onClick={() => setExpanded(true)}>
        <img src={source} width={screenshot.width} height={screenshot.height} alt={title} decoding="async" onError={() => setFailedSource(source)} />
      </button>
    )}
    <Dialog title={title} className="modal--tool-result-image" width={960} open={expanded && failedSource !== source} onClose={() => setExpanded(false)}>
      <div className="tool-result__expanded"><img src={source} alt={title} onError={() => setFailedSource(source)} /></div>
    </Dialog>
  </figure>
}

function WorkPageText({ text }: { text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const needsExpansion = text.length > 1200
  return <details className="tool-browser-snapshot__text">
    <summary>查看页面文字</summary>
    <p>{expanded || !needsExpansion ? text : `${text.slice(0, 1200)}…`}</p>
    {needsExpansion ? <button type="button" className="tool-result-data__expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? '收起页面文字' : '展开页面文字'}
    </button> : null}
  </details>
}

/** Render captured text as text; page content must never become executable HTML. */
export function BrowserSnapshotResult({ snapshot, clickResult = false, surfaceMode = 'code' }: {
  snapshot: ToolBrowserSnapshot
  clickResult?: boolean
  surfaceMode?: 'code' | 'work'
}): JSX.Element {
  if (surfaceMode === 'work') {
    // Click geometry belongs to the pre-dispatch viewport. Keep the same overlay
    // as Code; the post-click page may have moved or navigated to a different URL.
    const interaction = snapshot.interaction
    const screenshot = snapshot.screenshot
    const hasScreenshot = screenshot || interaction?.screenshot
    const screenshotUnavailable = snapshot.screenshotUnavailable ?? snapshot.interaction?.screenshotUnavailable
    const pageText = snapshot.text.trim()
    return <section className="tool-browser-snapshot tool-browser-snapshot--work" aria-label="浏览器页面快照">
      {snapshot.loading ? <div className="tool-browser-snapshot__status" role="status">正在加载</div> : null}
      {interaction ? <BrowserClickPosition click={interaction} compact /> : clickResult ? (
        <div className="tool-browser-click__missing">这条记录未保存点击位置</div>
      ) : null}
      {screenshot && interaction?.screenshot ? screenshot.dataUrl !== interaction.screenshot.dataUrl ? (
        <details className="tool-browser-snapshot__after"><summary>查看点击后页面</summary>
          <WorkScreenshot screenshot={screenshot} title="点击后页面截图" />
        </details>
      ) : null : screenshot ? <WorkScreenshot screenshot={screenshot} title={interaction || clickResult ? '点击后页面截图' : '页面截图'} /> : null}
      {!hasScreenshot ? <>
        {!interaction ? <div className="tool-browser-snapshot__empty" role="status">
          {screenshotUnavailable ?? (snapshot.snapshotUnavailable ? '页面内容暂不可用，未取得截图' : '这条记录未附截图')}
        </div> : null}
        {pageText ? <WorkPageText text={pageText} /> : null}
      </> : null}
      {interaction && snapshot.snapshotUnavailable ? <div className="tool-browser-snapshot__empty" role="status">
        操作已执行，页面快照暂不可用：{snapshot.snapshotUnavailable}
      </div> : null}
    </section>
  }
  // Older records can have real pixels without viewport metadata. Image size is
  // validated by the parser and is sufficient when no coordinates are overlaid.
  const viewport = snapshot.viewport ?? (snapshot.screenshot ? { width: snapshot.screenshot.width, height: snapshot.screenshot.height } : undefined)
  const canMap = !!viewport && [viewport.width, viewport.height].every(value => Number.isInteger(value) && value >= 1 && value < 2 ** 31)
  return (
    <section className="tool-browser-snapshot" aria-label="浏览器页面快照">
      <header className="tool-browser-snapshot__header">
        <Icon name="eye-outline" size={16} />
        <div className="tool-browser-snapshot__identity">
          <strong className="tool-browser-snapshot__title">{snapshot.title || '未命名页面'}</strong>
          <div className="tool-browser-snapshot__url" title={snapshot.url}>{snapshot.url || '无页面地址'}</div>
        </div>
      </header>
      <div className="tool-browser-snapshot__facts">
        {snapshot.loading !== undefined ? <span>{snapshot.loading ? '正在加载' : '加载完成'}</span> : null}
        {snapshot.viewport ? <span>{snapshot.viewport.width} × {snapshot.viewport.height}</span> : null}
        {snapshot.truncated ? <span>内容已截取</span> : null}
      </div>
      {snapshot.interaction ? <BrowserClickPosition click={snapshot.interaction} /> : clickResult ? (
        <div className="tool-browser-click__missing">这条记录未保存点击位置</div>
      ) : null}
      {!snapshot.interaction?.screenshot && canMap && snapshot.screenshot ? (
        <div className="tool-browser-page">
          <BrowserPositionPreview screenshot={snapshot.screenshot} viewport={viewport!} title="页面截图"
            description="页面截图" className="tool-browser-page__map" />
        </div>
      ) : null}
      {snapshot.snapshotUnavailable ? <div className="tool-browser-snapshot__empty" role="status">
        操作已执行，页面快照暂不可用：{snapshot.snapshotUnavailable}
      </div> : null}
    </section>
  )
}
