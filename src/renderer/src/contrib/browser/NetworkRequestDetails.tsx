import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import type { BrowserNetworkEntry } from '@shared/browser'
import type {
  BrowserNetworkBody,
  BrowserNetworkDetail,
  BrowserNetworkHeader
} from '@shared/browser-network'
import { Icon } from '@renderer/workbench/icons'
import { networkDuration, networkSize, networkStatus } from './network-format'

type DetailTab =
  'overview' | 'headers' | 'payload' | 'response' | 'initiator' | 'timing' | 'cookies'
type BodyTarget = 'request' | 'response'
const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'headers', label: '标头' },
  { id: 'payload', label: '参数与载荷' },
  { id: 'response', label: '响应' },
  { id: 'initiator', label: '发起者' },
  { id: 'timing', label: '计时' },
  { id: 'cookies', label: 'Cookie' }
]
const BODY_LIMIT = 12000
const BODY_MESSAGES: Record<string, string> = {
  '另一方向正文仅预览 2048 字符；使用 bodyTarget=request 继续读取':
    '请求正文仅显示部分内容，可在「参数与载荷」中加载更多。',
  '另一方向正文仅预览 2048 字符；使用 bodyTarget=response 继续读取':
    '响应正文仅显示部分内容，可在「响应」中加载更多。',
  '正文尚未读取；指定 bodyTarget=request 读取': '点击下方按钮读取请求正文。',
  '正文尚未读取；指定 bodyTarget=response 读取': '点击下方按钮读取响应正文。'
}

function bodyMessage(message: string): string {
  return BODY_MESSAGES[message] ?? message
}

function preserveBody(
  previous: BrowserNetworkBody | undefined,
  incoming: BrowserNetworkBody
): BrowserNetworkBody {
  // A metadata refresh must not discard pages the user has already loaded.
  if (
    previous?.state === 'available' &&
    (incoming.state === 'unavailable' ||
      (incoming.text !== undefined &&
        previous.text?.startsWith(incoming.text) &&
        previous.returnedChars > incoming.returnedChars))
  )
    return previous
  return incoming
}

function HeaderTable({
  title,
  rows,
  empty = '无'
}: {
  title: string
  rows: BrowserNetworkHeader[]
  empty?: string
}): JSX.Element {
  return (
    <section className="network-detail-section">
      <h4>
        {title}
        <span>{rows.length}</span>
      </h4>
      {rows.length ? (
        <table className="network-kv" aria-label={title}>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.name}:${index}`}>
                <th scope="row">{row.name}</th>
                <td>
                  {row.value}
                  {row.redacted ? <span className="network-badge">已脱敏</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="network-muted">{empty}</p>
      )}
    </section>
  )
}

function BodyView({
  body,
  target,
  loading,
  onLoadMore,
  onRetry
}: {
  body: BrowserNetworkBody
  target: BodyTarget
  loading: boolean
  onLoadMore: () => void
  onRetry: () => void
}): JSX.Element {
  const [formatted, setFormatted] = useState(true)
  const pretty = useMemo(() => {
    if (body.state !== 'available' || !body.text || body.hasMore || body.truncated) return null
    try {
      return JSON.stringify(JSON.parse(body.text), null, 2)
    } catch {
      return null
    }
  }, [body])
  const name = target === 'response' ? '响应正文' : '请求正文'
  const states: Record<BrowserNetworkBody['state'], string> = {
    available: '',
    pending: '响应尚未完成',
    unavailable: '正文不可用',
    binary: '二进制正文',
    'too-large': '正文超出捕获范围',
    empty: '无正文'
  }
  return (
    <section className="network-body" aria-label={name + '内容'} aria-busy={loading}>
      <div className="network-body__toolbar">
        <span>{body.mimeType || name}</span>
        {body.redacted ? <span className="network-badge">敏感信息已脱敏</span> : null}
        <div className="browser-spacer" />
        {pretty !== null ? (
          <button
            type="button"
            className="browser-text-tool"
            aria-pressed={formatted}
            onClick={() => setFormatted((value) => !value)}
          >
            {formatted ? '查看原文' : '格式化 JSON'}
          </button>
        ) : null}
      </div>
      {body.state === 'available' ? (
        <pre className="network-body__text" aria-label={name}>
          {formatted && pretty !== null ? pretty : body.text}
        </pre>
      ) : (
        <div className="network-body__state">
          <strong>{loading ? '正在读取正文…' : states[body.state]}</strong>
          <p>
            {(body.reason ? bodyMessage(body.reason) : '') ||
              (body.state === 'binary'
                ? '当前面板仅显示文本内容。'
                : body.state === 'pending'
                  ? '请求完成后可重新读取。'
                  : body.state === 'empty'
                    ? '此请求未携带可显示的正文。'
                    : '浏览器未能保留这段正文。')}
          </p>
          {body.state === 'pending' || body.state === 'unavailable' ? (
            <button type="button" className="btn" disabled={loading} onClick={onRetry}>
              重新读取{name}
            </button>
          ) : null}
        </div>
      )}
      {body.hasMore || body.truncated ? (
        <div className="network-body__continuation">
          <span>
            {body.hasMore
              ? `已读取 ${body.returnedChars.toLocaleString()}${body.totalChars === undefined ? '' : ` / ${body.totalChars.toLocaleString()}`} 字符`
              : '正文未完整捕获'}
            {body.truncated ? ' · 捕获内容已截断' : ''}
          </span>
          {body.hasMore ? (
            <button
              type="button"
              className="btn"
              aria-label={`加载更多${name}`}
              disabled={loading}
              onClick={onLoadMore}
            >
              {loading ? '正在读取…' : '加载更多'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function Timing({ detail }: { detail: BrowserNetworkDetail }): JSX.Element {
  const phases: Array<[string, string, string]> = [
    ['代理协商', 'proxyStart', 'proxyEnd'],
    ['DNS 查询', 'dnsStart', 'dnsEnd'],
    ['建立连接', 'connectStart', 'connectEnd'],
    ['TLS 握手', 'sslStart', 'sslEnd'],
    ['发送请求', 'sendStart', 'sendEnd'],
    ['等待响应', 'sendEnd', 'receiveHeadersStart'],
    ['接收响应头', 'receiveHeadersStart', 'receiveHeadersEnd']
  ]
  const rows = phases.flatMap(([name, start, end]) => {
    const from = detail.timing[start]
    const to = detail.timing[end]
    return typeof from === 'number' && typeof to === 'number' && from >= 0 && to >= from
      ? [{ name, start: from, duration: to - from }]
      : []
  })
  const total = Math.max(
    detail.entry.durationMs ?? 0,
    ...rows.map((row) => row.start + row.duration),
    1
  )
  return (
    <section className="network-detail-section">
      <h4>
        请求计时<span>{networkDuration(detail.entry.durationMs)}</span>
      </h4>
      {rows.length ? (
        <div className="network-timing">
          {rows.map((row) => (
            <div className="network-timing__row" key={row.name}>
              <span>{row.name}</span>
              <div className="network-timing__track">
                <span
                  style={{
                    marginLeft: `${(row.start / total) * 100}%`,
                    width: `${Math.max(0.5, (row.duration / total) * 100)}%`
                  }}
                />
              </div>
              <span>{networkDuration(row.duration)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="network-muted">浏览器未提供分阶段计时。</p>
      )}
      <p className="network-muted">各阶段由浏览器记录，TLS 握手可能包含在连接时间内。</p>
    </section>
  )
}

export function NetworkRequestDetails({
  tabId,
  requestId,
  entry,
  refreshRevision,
  onSelect,
  onClose
}: {
  tabId: string
  requestId: string
  entry?: BrowserNetworkEntry
  refreshRevision: number
  onSelect: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const [detail, setDetail] = useState<BrowserNetworkDetail | null>(null)
  const [active, setActive] = useState<DetailTab>('overview')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState({ request: false, response: false })
  const mounted = useRef(false)
  const sequence = useRef({ request: 0, response: 0 })
  const manualReading = useRef({ request: false, response: false })
  const prefix = useId()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let alive = true
    let complete = false
    let reading = false
    const read = async (): Promise<void> => {
      if (reading || complete || manualReading.current.response) return
      reading = true
      const generation = ++sequence.current.response
      try {
        const next = await window.aether.browser.networkRequest(tabId, requestId, {
          bodyTarget: 'response',
          bodyLimit: BODY_LIMIT
        })
        if (!alive || generation !== sequence.current.response) return
        complete = next.entry.finished === true
        setDetail((previous) => ({
          ...next,
          request: {
            ...next.request,
            body: preserveBody(previous?.request.body, next.request.body)
          },
          response: {
            ...next.response,
            body: preserveBody(previous?.response.body, next.response.body)
          }
        }))
        setError('')
      } catch (reason) {
        if (alive && generation === sequence.current.response) setError(String(reason))
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
  }, [tabId, requestId, entry?.finished, entry?.status, refreshRevision])
  const readBody = async (target: BodyTarget, append = false): Promise<void> => {
    if (manualReading.current[target]) return
    const previousBody = detail?.[target].body
    const offset = append ? previousBody?.nextOffset : 0
    if (append && offset === undefined) return
    const generation = ++sequence.current[target]
    manualReading.current[target] = true
    setLoading((value) => ({ ...value, [target]: true }))
    try {
      const next = await window.aether.browser.networkRequest(tabId, requestId, {
        bodyTarget: target,
        bodyOffset: offset,
        bodyLimit: BODY_LIMIT
      })
      if (!mounted.current || generation !== sequence.current[target]) return
      setDetail((previous) => {
        const before = previous?.[target].body
        const page = next[target].body
        const body =
          append &&
          before?.state === 'available' &&
          page.state === 'available' &&
          page.offset === before.returnedChars
            ? {
                ...page,
                offset: 0,
                text: (before.text ?? '') + (page.text ?? ''),
                returnedChars: before.returnedChars + page.returnedChars,
                redacted: before.redacted || page.redacted
              }
            : page
        return {
          ...next,
          request: {
            ...next.request,
            body:
              target === 'request' ? body : preserveBody(previous?.request.body, next.request.body)
          },
          response: {
            ...next.response,
            body:
              target === 'response'
                ? body
                : preserveBody(previous?.response.body, next.response.body)
          }
        }
      })
      setError('')
    } catch (reason) {
      if (mounted.current && generation === sequence.current[target]) setError(String(reason))
    } finally {
      manualReading.current[target] = false
      if (mounted.current && generation === sequence.current[target])
        setLoading((value) => ({ ...value, [target]: false }))
    }
  }
  const selectTab = (value: DetailTab): void => {
    setActive(value)
    if (value === 'payload' && detail?.request.body.state === 'unavailable')
      void readBody('request')
  }
  return (
    <section className="network-detail" aria-label="网络请求详情">
      <div className="network-detail__tabs" role="tablist" aria-label="请求详情">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            id={`${prefix}-${item.id}`}
            role="tab"
            aria-controls={`${prefix}-panel`}
            aria-selected={active === item.id}
            tabIndex={active === item.id ? 0 : -1}
            className={active === item.id ? 'is-active' : ''}
            onClick={() => selectTab(item.id)}
            onKeyDown={(event) => {
              const target =
                event.key === 'ArrowRight'
                  ? (index + 1) % TABS.length
                  : event.key === 'ArrowLeft'
                    ? (index - 1 + TABS.length) % TABS.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? TABS.length - 1
                        : -1
              if (target < 0) return
              event.preventDefault()
              selectTab(TABS[target].id)
              document.getElementById(`${prefix}-${TABS[target].id}`)?.focus()
            }}
          >
            {item.label}
          </button>
        ))}
        <div className="browser-spacer" />
        <button
          type="button"
          className="browser-tool"
          aria-label="关闭请求详情"
          title="关闭请求详情"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div
        className="network-detail__content"
        id={`${prefix}-panel`}
        role="tabpanel"
        aria-labelledby={`${prefix}-${active}`}
        tabIndex={0}
      >
        {error ? (
          <p className="network-message is-error" role="alert">
            {error}
          </p>
        ) : null}
        {!detail ? (
          <p className="network-empty">{error ? '无法读取请求详情。' : '正在读取请求详情…'}</p>
        ) : (
          <>
            {detail.entry.error ? (
              <p className="network-message is-error">{detail.entry.error}</p>
            ) : null}
            {detail.warnings.length ? (
              <div className="network-message">
                {detail.warnings.map((warning, index) => (
                  <p key={index}>{bodyMessage(warning)}</p>
                ))}
              </div>
            ) : null}
            {active === 'overview' ? (
              <section className="network-detail-section">
                <h4>请求信息</h4>
                <dl className="network-overview">
                  <dt>完整 URL</dt>
                  <dd>{detail.entry.url}</dd>
                  <dt>请求方法</dt>
                  <dd>{detail.entry.method}</dd>
                  <dt>状态</dt>
                  <dd>
                    {networkStatus(detail.entry)} {detail.response.statusText}
                  </dd>
                  <dt>资源类型</dt>
                  <dd>{detail.entry.resourceType ?? '—'}</dd>
                  <dt>内容类型</dt>
                  <dd>{detail.response.mimeType || detail.entry.mimeType || '—'}</dd>
                  <dt>协议</dt>
                  <dd>{detail.response.protocol || '—'}</dd>
                  <dt>远程地址</dt>
                  <dd>
                    {detail.response.remoteIPAddress
                      ? `${detail.response.remoteIPAddress}${detail.response.remotePort ? `:${detail.response.remotePort}` : ''}`
                      : '—'}
                  </dd>
                  <dt>传输大小</dt>
                  <dd>{networkSize(detail.entry.transferredBytes)}</dd>
                  <dt>总耗时</dt>
                  <dd>{networkDuration(detail.entry.durationMs)}</dd>
                  <dt>来源</dt>
                  <dd>
                    {detail.response.fromServiceWorker
                      ? 'Service Worker'
                      : detail.response.fromDiskCache
                        ? '磁盘缓存'
                        : '网络'}
                  </dd>
                  <dt>请求时间</dt>
                  <dd>{new Date(detail.entry.timestamp).toLocaleString()}</dd>
                </dl>
                {detail.previousRequestId || detail.nextRequestId ? (
                  <div className="network-redirects">
                    {detail.previousRequestId ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => onSelect(detail.previousRequestId!)}
                      >
                        上一个重定向请求
                      </button>
                    ) : null}
                    {detail.nextRequestId ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => onSelect(detail.nextRequestId!)}
                      >
                        下一个重定向请求
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}
            {active === 'headers' ? (
              <>
                <HeaderTable
                  title="常规信息"
                  rows={[
                    { name: 'Request URL', value: detail.entry.url },
                    { name: 'Request Method', value: detail.entry.method },
                    {
                      name: 'Status Code',
                      value: `${networkStatus(detail.entry)} ${detail.response.statusText ?? ''}`
                    }
                  ]}
                />
                <HeaderTable
                  title="响应标头"
                  rows={detail.response.headers}
                  empty="浏览器未提供响应标头。"
                />
                <HeaderTable
                  title="请求标头"
                  rows={detail.request.headers}
                  empty="浏览器未提供请求标头。"
                />
              </>
            ) : null}
            {active === 'payload' ? (
              <>
                <HeaderTable
                  title="查询参数"
                  rows={detail.request.query}
                  empty="此 URL 没有查询参数。"
                />
                <section className="network-detail-section">
                  <h4>请求载荷</h4>
                  <BodyView
                    body={detail.request.body}
                    target="request"
                    loading={loading.request}
                    onLoadMore={() => void readBody('request', true)}
                    onRetry={() => void readBody('request')}
                  />
                </section>
              </>
            ) : null}
            {active === 'response' ? (
              <BodyView
                body={detail.response.body}
                target="response"
                loading={loading.response}
                onLoadMore={() => void readBody('response', true)}
                onRetry={() => void readBody('response')}
              />
            ) : null}
            {active === 'initiator' ? (
              <section className="network-detail-section">
                <h4>请求发起者</h4>
                {detail.initiator ? (
                  <>
                    <dl className="network-overview">
                      <dt>类型</dt>
                      <dd>{detail.initiator.type}</dd>
                      {detail.initiator.url ? (
                        <>
                          <dt>来源</dt>
                          <dd>
                            {detail.initiator.url}
                            {detail.initiator.lineNumber !== undefined
                              ? `:${detail.initiator.lineNumber + 1}`
                              : ''}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                    {detail.initiator.stack?.length ? (
                      <ol className="network-stack">
                        {detail.initiator.stack.map((frame, index) => (
                          <li key={index}>
                            <strong>{frame.functionName || '(匿名函数)'}</strong>
                            <span>
                              {frame.url}:{frame.lineNumber + 1}:{frame.columnNumber + 1}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="network-muted">浏览器未提供调用栈。</p>
                    )}
                  </>
                ) : (
                  <p className="network-muted">浏览器未提供发起者信息。</p>
                )}
              </section>
            ) : null}
            {active === 'timing' ? <Timing detail={detail} /> : null}
            {active === 'cookies' ? (
              <>
                <p className="network-muted">Cookie 值中的敏感信息会自动脱敏。</p>
                <HeaderTable
                  title="请求 Cookie"
                  rows={detail.request.cookies}
                  empty="此请求没有可显示的 Cookie。"
                />
                <HeaderTable
                  title="响应 Cookie"
                  rows={detail.response.cookies}
                  empty="此响应没有设置 Cookie。"
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
