import type { JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import type { ToolBrowserSnapshot } from './browser-snapshot'
import { BrowserClickPosition } from './BrowserClickPosition'
import { BrowserPositionPreview } from './BrowserPositionPreview'

/** Render the captured state as text; page content must never become executable HTML. */
export function BrowserSnapshotResult({ snapshot, clickResult = false }: { snapshot: ToolBrowserSnapshot; clickResult?: boolean }): JSX.Element {
  const viewport = snapshot.viewport
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
      {!snapshot.interaction && canMap && snapshot.screenshot ? (
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
