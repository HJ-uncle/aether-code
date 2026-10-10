import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { BrowserBoundsInput, BrowserTabState, BrowserViewport } from '@shared/browser'
import type { BrowserConnectionState } from '@shared/browser-api'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { Select } from '@renderer/workbench/Select'
import { ActionMenu } from '@renderer/workbench/ActionMenu'
import { NetworkInspector } from './NetworkInspector'
import { isBrowserSurfaceOccluded } from './browser-occlusion'
import { openViewToRight } from '@renderer/core/editor/editor-groups'
import { openAppSettings } from '../settings/app-settings-navigation'
import {
  browserAction,
  initializeBrowser,
  openBrowser,
  refreshBrowserSettings,
  selectBrowserTab,
  useBrowserState
} from './browser-store'
import './browser.css'
import {
  PHONE_VIEWPORT as PHONE,
  DESKTOP_VIEWPORT as DESKTOP,
  viewportPreset,
  customViewportLabel
} from './viewport-display'

type Inspector = 'console' | 'network' | null

function ToolButton({
  label,
  icon,
  disabled,
  onClick,
  className = ''
}: {
  label: string
  icon: IconName
  disabled?: boolean
  onClick: () => void
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={`browser-tool ${className}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
    </button>
  )
}

function BrowserSurface({
  tab,
  revealRequestId
}: {
  tab: BrowserTabState
  revealRequestId?: string
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewportWidth = tab.viewport?.width ?? 0
  const viewportHeight = tab.viewport?.height ?? 0
  const viewportMobile = tab.viewport?.mobile ?? false
  const viewportScale = tab.viewport?.deviceScaleFactor ?? 1
  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    let frame = 0
    let last = ''
    let resizing = false
    let disposed = false
    const send = (): void => {
      frame = 0
      if (disposed) return
      const rect = element.getBoundingClientRect()
      const clip = element.closest('.browser-view')?.getBoundingClientRect() ?? rect
      const x = Math.max(0, rect.x, clip.x)
      const y = Math.max(0, rect.y, clip.y)
      const width = Math.max(0, Math.min(window.innerWidth, rect.right, clip.right) - x)
      const height = Math.max(0, Math.min(window.innerHeight, rect.bottom, clip.bottom) - y)
      const hostZoom = window.aether.browser.getHostZoomFactor()
      const viewport =
        viewportWidth && viewportHeight
          ? {
              width: viewportWidth,
              height: viewportHeight,
              mobile: viewportMobile,
              deviceScaleFactor: viewportScale
            }
          : null
      const input: BrowserBoundsInput = {
        tabId: tab.tabId,
        revealRequestId,
        bounds: { x, y, width, height },
        visible:
          !document.hidden &&
          !resizing &&
          width > 0 &&
          height > 0 &&
          !isBrowserSurfaceOccluded({ x, y, width, height }, viewport, document, hostZoom)
      }
      const key = JSON.stringify({ ...input, hostZoom })
      if (key === last) return
      last = key
      // Main IPC converts these CSS pixels with sender.getZoomFactor(); DPR is
      // deliberately not multiplied here because native bounds already use DIP.
      void window.aether.browser.setBounds(input).catch(() => undefined)
    }
    const schedule = (): void => {
      if (!frame && !disposed) frame = requestAnimationFrame(send)
    }
    const down = (event: PointerEvent): void => {
      if ((event.target as Element).closest?.('[role="separator"], .sash, .resize-handle')) {
        resizing = true
        schedule()
      }
    }
    const up = (): void => {
      resizing = false
      schedule()
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const mutation = new MutationObserver(schedule)
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open']
    })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('lostpointercapture', up, true)
    send()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('lostpointercapture', up, true)
      void window.aether.browser
        .setBounds({
          tabId: tab.tabId,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          visible: false
        })
        .catch(() => undefined)
    }
  }, [tab.tabId, viewportWidth, viewportHeight, viewportMobile, viewportScale, revealRequestId])
  return (
    <div ref={host} className="browser-surface" aria-label="网页内容区域">
      <div className="browser-surface__placeholder">
        <Icon name="eye-outline" size={28} />
        <span>
          {tab.loading
            ? '正在加载网页…'
            : tab.url === 'about:blank'
              ? '在地址栏输入网址，或打开项目的开发服务。'
              : '网页将在这里显示'}
        </span>
      </div>
    </div>
  )
}

function InspectorDrawer({
  tab,
  kind,
  onClose
}: {
  tab: BrowserTabState
  kind: Exclude<Inspector, null>
  onClose: () => void
}): JSX.Element {
  const [output, setOutput] = useState<unknown>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    // A document navigation starts a new console stream. Clear the previous
    // snapshot immediately so the drawer never presents old-page messages while
    // the first log from the new document is still arriving.
    setOutput(null)
    setError('')
  }, [tab.tabId, tab.navigationId, kind])
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.aether.browser
        .read(tab.tabId, kind)
        .then((result) => {
          if (!alive) return
          if (!result.success) {
            setError(result.error ?? '无法读取页面记录')
            return
          }
          setOutput(result.output)
          setError('')
        })
        .catch((reason: unknown) => {
          if (alive) setError(String(reason))
        })
    }
    read()
    const timer = window.setInterval(read, 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [tab.tabId, tab.navigationId, kind, revision])
  const rows = Array.isArray(output)
    ? output
    : output && typeof output === 'object' && 'entries' in output && Array.isArray(output.entries)
      ? output.entries
      : null
  return (
    <section
      className="browser-inspector"
      aria-label={kind === 'console' ? '浏览器控制台' : '浏览器网络请求'}
    >
      <header>
        <strong>{kind === 'console' ? '控制台' : '网络请求'}</strong>
        <span>{rows ? `${rows.length} 条记录` : '当前网页'}</span>
        <div className="browser-spacer" />
        <ToolButton
          label="刷新记录"
          icon="restart"
          onClick={() => setRevision((value) => value + 1)}
        />
        <ToolButton label="关闭调试面板" icon="close" onClick={onClose} />
      </header>
      <div className="browser-inspector__body">
        {error ? (
          <p role="alert">{error}</p>
        ) : rows?.length === 0 ? (
          <p className="browser-empty-copy">暂无{kind === 'console' ? '控制台消息' : '网络请求'}</p>
        ) : rows ? (
          rows.map((entry, index) => <LogRow key={index} entry={entry} kind={kind} />)
        ) : (
          <pre>{output === null ? '正在读取…' : JSON.stringify(output, null, 2)}</pre>
        )}
      </div>
    </section>
  )
}

function LogRow({ entry, kind }: { entry: unknown; kind: Exclude<Inspector, null> }): JSX.Element {
  const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
  const failure =
    Boolean(record.error) ||
    record.level === 'error' ||
    (typeof record.status === 'number' && record.status >= 400)
  return (
    <div className={`browser-log${failure ? ' is-error' : ''}`}>
      <span className="browser-log__kind">
        {String(
          kind === 'console' ? (record.level ?? '日志') : (record.status ?? record.method ?? '请求')
        )}
      </span>
      <span className="browser-log__message" title={String(record.url ?? record.message ?? '')}>
        {String(
          kind === 'console'
            ? (record.message ?? JSON.stringify(entry))
            : (record.url ?? JSON.stringify(entry))
        )}
      </span>
      {record.error ? <span>{String(record.error)}</span> : null}
      {typeof record.durationMs === 'number' ? (
        <small>{Math.round(record.durationMs)} ms</small>
      ) : null}
    </div>
  )
}

export function BrowserView(): JSX.Element {
  const state = useBrowserState()
  const tab = state.tabs.find((item) => item.tabId === state.activeTabId) ?? state.tabs[0]
  const [address, setAddress] = useState('')
  const addressRef = useRef<HTMLInputElement>(null)
  const [inspector, setInspector] = useState<Inspector>(null)
  const [custom, setCustom] = useState(false)
  const [width, setWidth] = useState('1280')
  const [height, setHeight] = useState('800')
  const [connection, setConnection] = useState<BrowserConnectionState>({ status: 'disconnected' })
  useEffect(() => {
    void initializeBrowser().then(refreshBrowserSettings)
  }, [])
  const locationKey = `${tab?.tabId ?? ''}:${tab?.url ?? ''}`
  const [observedLocation, setObservedLocation] = useState('')
  if (observedLocation !== locationKey) {
    setObservedLocation(locationKey)
    setAddress(tab?.url === 'about:blank' ? '' : (tab?.url ?? ''))
  }
  useEffect(() => {
    if (!state.addressFocusRequest) return
    const frame = requestAnimationFrame(() => {
      addressRef.current?.focus()
      addressRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [state.addressFocusRequest])
  useEffect(() => {
    let alive = true
    void window.aether.browser
      .getConnection()
      .then((value) => {
        if (alive) setConnection(value)
      })
      .catch(() => undefined)
    const off = window.aether.browser.onConnection(setConnection)
    return () => {
      alive = false
      off()
    }
  }, [])
  const run = (action: 'back' | 'forward' | 'reload' | 'stop' | 'devtools'): void => {
    if (tab) browserAction(() => window.aether.browser.action({ tabId: tab.tabId, action }))
  }
  const viewport = (value: BrowserViewport | null): void => {
    if (tab)
      browserAction(() =>
        window.aether.browser.action({ tabId: tab.tabId, action: 'viewport', viewport: value })
      )
  }
  const navigate = (): void => {
    if (!address.trim()) return
    if (tab)
      browserAction(() =>
        window.aether.browser.action({ tabId: tab.tabId, action: 'navigate', url: address.trim() })
      )
    else browserAction(() => openBrowser(address.trim()))
  }
  const mode = viewportPreset(tab?.viewport)
  const aiReady =
    state.settings.aiEnabled &&
    connection.status === 'connected' &&
    tab?.context?.sessionId === connection.sessionId &&
    tab?.context?.engineId === connection.engineId

  return (
    <section
      className="browser-view"
      aria-label="内置浏览器"
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey)) return
        if (event.key.toLowerCase() === 'l') {
          event.preventDefault()
          addressRef.current?.focus()
          addressRef.current?.select()
        }
        if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          run('reload')
        }
        if (event.key.toLowerCase() === 't') {
          event.preventDefault()
          browserAction(() => window.aether.browser.create({}))
        }
        if (event.key.toLowerCase() === 'w' && tab) {
          event.preventDefault()
          event.stopPropagation()
          browserAction(() => window.aether.browser.close(tab.tabId))
        }
      }}
    >
      <div className="browser-tabs" role="tablist" aria-label="网页标签">
        {state.tabs.map((item, index) => (
          <div
            key={item.tabId}
            className={`browser-tab${item.tabId === tab?.tabId ? ' is-active' : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={item.tabId === tab?.tabId}
              tabIndex={item.tabId === tab?.tabId ? 0 : -1}
              title={item.url}
              onClick={() => selectBrowserTab(item.tabId)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % state.tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index - 1 + state.tabs.length) % state.tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? state.tabs.length - 1
                          : -1
                if (next < 0) return
                event.preventDefault()
                selectBrowserTab(state.tabs[next].tabId)
                const target = event.currentTarget
                  .closest('[role="tablist"]')
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
                target?.focus()
              }}
            >
              <Icon
                name={item.loading ? 'sync' : 'eye-outline'}
                size={14}
                className={item.loading ? 'browser-loading-icon' : undefined}
              />
              <span>{item.title || (item.url === 'about:blank' ? '新标签页' : item.url)}</span>
            </button>
            <button
              type="button"
              className="browser-tab__close"
              aria-label={`关闭网页 ${item.title || item.url}`}
              onClick={() => browserAction(() => window.aether.browser.close(item.tabId))}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <ToolButton
          label="新建网页标签（Ctrl+T）"
          icon="plus"
          onClick={() => browserAction(() => window.aether.browser.create({}))}
        />
        <div className="browser-spacer" />
        <ToolButton
          label="在右侧分栏显示浏览器"
          icon="layout-sidebar"
          onClick={() => openViewToRight('browser')}
        />
      </div>
      <form
        className="browser-navigation"
        onSubmit={(event) => {
          event.preventDefault()
          navigate()
        }}
      >
        <ToolButton
          label="后退"
          icon="chevron-right"
          className="browser-tool--back"
          disabled={!tab?.canGoBack}
          onClick={() => run('back')}
        />
        <ToolButton
          label="前进"
          icon="chevron-right"
          disabled={!tab?.canGoForward}
          onClick={() => run('forward')}
        />
        <ToolButton
          label={tab?.loading ? '停止加载' : '刷新网页（Ctrl+R）'}
          icon={tab?.loading ? 'stop' : 'restart'}
          disabled={!tab}
          onClick={() => run(tab?.loading ? 'stop' : 'reload')}
        />
        <input
          ref={addressRef}
          className="browser-address field__input"
          aria-label="网页地址"
          placeholder="输入网址或 localhost:端口"
          value={address}
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="submit" className="browser-tool" aria-label="打开网址" title="打开网址">
          <Icon name="play" size={15} />
        </button>
        <ActionMenu
          label="浏览器更多操作"
          items={[
            {
              id: 'settings',
              label: '浏览器设置',
              icon: 'settings',
              onSelect: () => openAppSettings('browser')
            },
            {
              id: 'devtools',
              label: '开发者工具',
              icon: 'terminal',
              disabled: !tab,
              onSelect: () => run('devtools')
            }
          ]}
        />
      </form>
      {tab ? (
        <div className="browser-options">
          <Select
            value={custom ? 'custom' : mode}
            title="网页视口"
            ariaLabel="网页视口"
            width={180}
            options={[
              { value: 'fit', label: '适应区域' },
              { value: 'desktop', label: '桌面 · 1280 × 800' },
              { value: 'phone', label: '手机 · 390 × 844' },
              {
                value: 'custom',
                label: mode === 'custom' ? customViewportLabel(tab.viewport) : '自定义尺寸…'
              }
            ]}
            onChange={(value) => {
              setCustom(value === 'custom')
              if (value === 'custom') {
                setWidth(String(tab.viewport?.width ?? 1280))
                setHeight(String(tab.viewport?.height ?? 800))
              }
              if (value !== 'custom')
                viewport(value === 'phone' ? PHONE : value === 'desktop' ? DESKTOP : null)
            }}
          />
          <Select
            value={String(tab.zoomFactor)}
            title="网页缩放"
            ariaLabel="网页缩放"
            width={130}
            options={[...new Set([0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, tab.zoomFactor])]
              .sort((a, b) => a - b)
              .map((factor) => ({ value: String(factor), label: `${Math.round(factor * 100)}%` }))}
            onChange={(value) =>
              browserAction(() =>
                window.aether.browser.action({
                  tabId: tab.tabId,
                  action: 'zoom',
                  zoomFactor: Number(value)
                })
              )
            }
          />
          <div className="browser-spacer" />
          <button
            type="button"
            className={`browser-text-tool${inspector === 'console' ? ' is-active' : ''}`}
            aria-pressed={inspector === 'console'}
            onClick={() => setInspector(inspector === 'console' ? null : 'console')}
          >
            控制台
          </button>
          <button
            type="button"
            className={`browser-text-tool${inspector === 'network' ? ' is-active' : ''}`}
            aria-pressed={inspector === 'network'}
            onClick={() => setInspector(inspector === 'network' ? null : 'network')}
          >
            网络
          </button>
        </div>
      ) : null}
      {custom ? (
        <form
          className="browser-viewport-form"
          onSubmit={(event) => {
            event.preventDefault()
            viewport({
              width: Number(width),
              height: Number(height),
              mobile: false,
              deviceScaleFactor: 1
            })
            setCustom(false)
          }}
        >
          <label>
            宽{' '}
            <input
              className="field__input"
              aria-label="视口宽度"
              type="number"
              min={240}
              max={3840}
              value={width}
              onChange={(event) => setWidth(event.target.value)}
            />
          </label>
          <span>×</span>
          <label>
            高{' '}
            <input
              className="field__input"
              aria-label="视口高度"
              type="number"
              min={240}
              max={3840}
              value={height}
              onChange={(event) => setHeight(event.target.value)}
            />
          </label>
          <button type="submit" className="btn">
            应用
          </button>
          <ToolButton label="取消自定义视口" icon="close" onClick={() => setCustom(false)} />
        </form>
      ) : null}
      {tab?.error || state.error ? (
        <div className="browser-error" role="alert">
          <Icon name="warning" size={16} />
          <span>{tab?.error || state.error}</span>
          <button type="button" className="btn" onClick={() => run('reload')}>
            重试
          </button>
        </div>
      ) : null}
      {/* 同级网页和调试面板必须使用不同 key，避免更新时残留旧网页容器。 */}
      {tab ? (
        <BrowserSurface
          key={`surface:${tab.tabId}`}
          tab={tab}
          revealRequestId={
            state.revealRequest?.tabId === tab.tabId ? state.revealRequest.requestId : undefined
          }
        />
      ) : (
        <div className="browser-empty">
          <Icon name="eye-outline" size={36} />
          <h2>在编辑器旁打开网页</h2>
          <p>运行项目后，输入开发服务地址，即可操作和检查页面。</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => browserAction(() => openBrowser())}
          >
            {state.ready ? '打开新标签页' : '正在准备…'}
          </button>
        </div>
      )}
      {tab && inspector === 'network' ? (
        <NetworkInspector
          key={`network:${tab.tabId}`}
          tab={tab}
          onClose={() => setInspector(null)}
        />
      ) : tab && inspector === 'console' ? (
        <InspectorDrawer
          key={`${tab.tabId}:${inspector}`}
          tab={tab}
          kind={inspector}
          onClose={() => setInspector(null)}
        />
      ) : null}
      <footer className="browser-status">
        <span className={`browser-status__dot${aiReady ? ' is-ready' : ''}`} />
        <span title={connection.message}>
          {!state.settings.aiEnabled
            ? 'AI 浏览器已关闭'
            : aiReady
              ? 'AI 可操作当前网页'
              : connection.status === 'connecting'
                ? '正在连接 AI…'
                : connection.status === 'error'
                  ? `AI 连接失败${connection.message ? `：${connection.message}` : ''}`
                  : connection.status === 'connected'
                    ? '网页尚未交给当前对话'
                    : '打开对话并连接引擎后，AI 可操作网页'}
        </span>
        {tab && !aiReady && state.settings.aiEnabled && connection.status === 'connected' ? (
          <button
            type="button"
            className="browser-text-tool"
            title="将当前网页分配给当前对话，允许 AI 读取和操作"
            onClick={() => browserAction(() => window.aether.browser.share(tab.tabId))}
          >
            交给当前会话
          </button>
        ) : null}
        <div className="browser-spacer" />
        {tab?.viewport ? (
          <span>
            {tab.viewport.width} × {tab.viewport.height}
          </span>
        ) : (
          <span>自适应</span>
        )}
      </footer>
    </section>
  )
}
