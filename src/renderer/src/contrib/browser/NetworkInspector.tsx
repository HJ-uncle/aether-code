import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import type { BrowserTabState } from '@shared/browser'
import type { BrowserNetworkList, BrowserNetworkQuery } from '@shared/browser-network'
import { Icon } from '@renderer/workbench/icons'
import { Select } from '@renderer/workbench/Select'
import { NetworkRequestDetails } from './NetworkRequestDetails'
import { networkDuration, networkSize, networkStatus, requestName } from './network-format'
import './network-inspector.css'

const PAGE_SIZE = 50
const MIN_PAGE_HEIGHT = 96
const PREFERRED_MIN_DRAWER_HEIGHT = 200
const resourceTypes = [
  'Document',
  'Stylesheet',
  'Script',
  'XHR',
  'Fetch',
  'Image',
  'Font',
  'Media',
  'Other'
]

export function NetworkInspector({
  tab,
  onClose
}: {
  tab: BrowserTabState
  onClose: () => void
}): JSX.Element {
  const root = useRef<HTMLElement>(null)
  const [height, setHeight] = useState(380)
  const [maximumHeight, setMaximumHeight] = useState(0)
  const minimumHeight = Math.min(PREFERRED_MIN_DRAWER_HEIGHT, maximumHeight)
  const drawerHeight = Math.max(minimumHeight, Math.min(height, maximumHeight))
  const [query, setQuery] = useState<BrowserNetworkQuery>({ offset: 0, limit: PAGE_SIZE })
  const [result, setResult] = useState<{ key: string; data: BrowserNetworkList } | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const queryKey = JSON.stringify(query)
  useEffect(() => {
    const panel = root.current
    const parent = panel?.parentElement
    if (!parent || !panel) return
    let frame = 0
    const pixels = (value: string): number => Number.parseFloat(value) || 0
    const fixedSiblings = (): Element[] =>
      [...parent.children].filter(
        (child) => child !== panel && !child.matches('.browser-surface, .browser-empty')
      )
    const measure = (): void => {
      const parentStyle = getComputedStyle(parent)
      let fixedHeight = 0
      let flowChildren = 2
      for (const sibling of fixedSiblings()) {
        const style = getComputedStyle(sibling)
        if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed')
          continue
        fixedHeight +=
          sibling.getBoundingClientRect().height +
          pixels(style.marginTop) +
          pixels(style.marginBottom)
        flowChildren++
      }
      // Toolbars wrap independently when editor columns or IDE zoom change.
      // Measuring them avoids shrinking the native webpage out of existence.
      const available =
        parent.clientHeight -
        pixels(parentStyle.paddingTop) -
        pixels(parentStyle.paddingBottom) -
        pixels(parentStyle.rowGap) * Math.max(0, flowChildren - 1) -
        fixedHeight
      setMaximumHeight(Math.max(0, Math.floor(available - MIN_PAGE_HEIGHT)))
    }
    const observer = new ResizeObserver(measure)
    const observe = (): void => {
      observer.disconnect()
      observer.observe(parent)
      for (const sibling of fixedSiblings()) observer.observe(sibling)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const children = new MutationObserver(observe)
    children.observe(parent, { childList: true })
    observe()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      children.disconnect()
    }
  }, [])
  useEffect(() => {
    let alive = true
    let reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      try {
        const data = await window.aether.browser.network(
          tab.tabId,
          JSON.parse(queryKey) as BrowserNetworkQuery
        )
        if (alive) {
          setResult({ key: queryKey, data })
          setError('')
        }
      } catch (reason) {
        if (alive) setError(String(reason))
      } finally {
        reading = false
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [tab.tabId, tab.navigationId, queryKey, revision])
  const data = result?.key === queryKey ? result.data : null
  const hasFilters = Boolean(
    query.url ||
    query.method ||
    query.resourceType ||
    query.status ||
    query.failedOnly ||
    query.minDurationMs
  )
  const filter = (change: Partial<BrowserNetworkQuery>): void => {
    setQuery((previous) => ({ ...previous, ...change, offset: 0 }))
    setSelectedId(null)
  }
  const resize = (event: PointerEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    const bounds = root.current?.getBoundingClientRect()
    if (!bounds) return
    event.preventDefault()
    element.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const move = (next: globalThis.PointerEvent): void =>
      setHeight(
        Math.max(minimumHeight, Math.min(maximumHeight, bounds.height + startY - next.clientY))
      )
    const end = (): void => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', end)
      element.removeEventListener('pointercancel', end)
      element.removeEventListener('lostpointercapture', end)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', end)
    element.addEventListener('pointercancel', end)
    element.addEventListener('lostpointercapture', end)
  }
  const selected = data?.entries.find((entry) => entry.id === selectedId)
  const offset = data?.offset ?? query.offset ?? 0
  return (
    <section
      ref={root}
      className="network-inspector"
      aria-label="浏览器网络请求"
      style={{ flexBasis: drawerHeight, borderTopWidth: drawerHeight === 0 ? 0 : undefined }}
    >
      <div
        className="network-inspector__resize"
        role="separator"
        aria-label="调整网络面板高度"
        aria-orientation="horizontal"
        aria-valuemin={minimumHeight}
        aria-valuemax={maximumHeight}
        aria-valuenow={Math.round(drawerHeight)}
        tabIndex={0}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          setHeight(
            Math.max(
              minimumHeight,
              Math.min(maximumHeight, drawerHeight + (event.key === 'ArrowUp' ? 24 : -24))
            )
          )
        }}
      />
      <div className="network-inspector__heading">
        <strong>网络请求</strong>
        <span className="network-inspector__counts" role="status">
          {data
            ? `${data.total} 条匹配 · 已捕获 ${data.captured}${data.dropped ? ` · 已移出 ${data.dropped}` : ''}`
            : '正在读取…'}
        </span>
        <div className="browser-spacer" />
        <button
          type="button"
          className="browser-tool"
          aria-label="刷新网络请求"
          title="刷新网络请求"
          onClick={() => setRevision((value) => value + 1)}
        >
          <Icon name="restart" size={15} />
        </button>
        <button
          type="button"
          className="browser-tool"
          aria-label="关闭调试面板"
          title="关闭调试面板"
          onClick={onClose}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="network-inspector__workspace">
        <div className="network-inspector__filters">
          <div className="network-inspector__search">
            <Icon name="search" size={14} />
            <input
              className="field__input"
              aria-label="过滤网络请求"
              placeholder="搜索请求 URL"
              value={query.url ?? ''}
              onChange={(event) => filter({ url: event.target.value })}
            />
          </div>
          <Select
            value={query.method ?? ''}
            ariaLabel="网络请求方法"
            title="网络请求方法"
            width={140}
            options={[
              { value: '', label: '所有方法' },
              ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((value) => ({
                value,
                label: value
              }))
            ]}
            onChange={(method) => filter({ method })}
          />
          <Select
            value={query.resourceType ?? ''}
            ariaLabel="网络资源类型"
            title="网络资源类型"
            width={160}
            options={[
              { value: '', label: '所有类型' },
              ...resourceTypes.map((value) => ({ value, label: value }))
            ]}
            onChange={(resourceType) => filter({ resourceType })}
          />
          <Select
            value={query.status ?? ''}
            ariaLabel="网络状态码"
            title="网络状态码"
            width={150}
            options={[
              { value: '', label: '所有状态' },
              { value: 'pending', label: '进行中' },
              { value: '1xx', label: '1xx · 信息' },
              { value: '2xx', label: '2xx · 成功' },
              { value: '3xx', label: '3xx · 重定向' },
              { value: '4xx', label: '4xx · 客户端错误' },
              { value: '5xx', label: '5xx · 服务端错误' }
            ]}
            onChange={(status) => filter({ status })}
          />
          <Select
            value={String(query.minDurationMs ?? 0)}
            ariaLabel="网络请求耗时"
            title="网络请求耗时"
            width={160}
            options={[
              { value: '0', label: '不限耗时' },
              { value: '500', label: '≥ 500 毫秒' },
              { value: '1000', label: '≥ 1 秒' },
              { value: '3000', label: '≥ 3 秒' }
            ]}
            onChange={(value) => filter({ minDurationMs: Number(value) || undefined })}
          />
          <label className="network-inspector__failed">
            <input
              type="checkbox"
              checked={query.failedOnly ?? false}
              onChange={(event) => filter({ failedOnly: event.target.checked })}
            />
            仅失败请求
          </label>
          {hasFilters ? (
            <button
              type="button"
              className="browser-tool"
              title="清除网络筛选"
              aria-label="清除网络筛选"
              onClick={() => {
                setQuery({ offset: 0, limit: PAGE_SIZE })
                setSelectedId(null)
              }}
            >
              <Icon name="filter-remove" size={15} />
            </button>
          ) : null}
        </div>
        {data?.warnings?.length ? (
          <div className="network-message" role="status">
            {data.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="network-message is-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className={`network-inspector__content${selectedId ? ' has-detail' : ''}`}>
          <div className="network-list">
            <div className="network-list__scroll" aria-busy={!data}>
              <table className="network-list__table" aria-label="网络请求列表">
                <thead>
                  <tr>
                    <th>请求</th>
                    <th>方法</th>
                    <th>状态</th>
                    <th>类型</th>
                    <th>耗时</th>
                    <th>大小</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.entries.map((entry) => (
                    <tr
                      key={entry.id}
                      className={`${entry.id === selectedId ? 'is-selected' : ''}${entry.error || (entry.status ?? 0) >= 400 ? ' is-error' : ''}`}
                      onClick={() => setSelectedId(entry.id)}
                    >
                      <td>
                        <button
                          type="button"
                          className="network-list__request"
                          aria-label={`查看请求 ${entry.method} ${entry.url}`}
                          title={entry.url}
                          aria-pressed={entry.id === selectedId}
                          onClick={() => setSelectedId(entry.id)}
                        >
                          <span>{requestName(entry.url)}</span>
                          <small>{entry.url}</small>
                        </button>
                      </td>
                      <td>{entry.method}</td>
                      <td title={entry.error}>{networkStatus(entry)}</td>
                      <td>{entry.resourceType ?? '—'}</td>
                      <td>{networkDuration(entry.durationMs)}</td>
                      <td>{networkSize(entry.transferredBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data?.entries.length === 0 ? (
                <p className="network-empty">
                  {hasFilters
                    ? '没有匹配的请求，试试调整筛选条件。'
                    : '暂无网络请求。加载网页后，请求将显示在这里。'}
                </p>
              ) : null}
            </div>
            <div className="network-list__pagination">
              <span>
                {data?.total
                  ? `${offset + 1}–${offset + data.entries.length} / ${data.total}`
                  : '0 条请求'}
              </span>
              <div className="browser-spacer" />
              <button
                type="button"
                className="browser-text-tool"
                aria-label="上一页请求"
                disabled={offset === 0 || !data}
                onClick={() =>
                  setQuery((value) => ({ ...value, offset: Math.max(0, offset - PAGE_SIZE) }))
                }
              >
                上一页
              </button>
              <button
                type="button"
                className="browser-text-tool"
                aria-label="下一页请求"
                disabled={!data?.hasMore}
                onClick={() =>
                  setQuery((value) => ({
                    ...value,
                    offset: data?.nextOffset ?? offset + PAGE_SIZE
                  }))
                }
              >
                下一页
              </button>
            </div>
          </div>
          {selectedId ? (
            <NetworkRequestDetails
              key={`${tab.tabId}:${selectedId}`}
              tabId={tab.tabId}
              requestId={selectedId}
              entry={selected}
              refreshRevision={revision}
              onSelect={setSelectedId}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}
