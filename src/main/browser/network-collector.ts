import type { BrowserNetworkEntry, BrowserTabState } from '../../shared/browser'
import { randomUUID } from 'node:crypto'
import type { BrowserNetworkBody, BrowserNetworkDetail, BrowserNetworkDetailOptions, BrowserNetworkHeader, BrowserNetworkList, BrowserNetworkQuery } from '../../shared/browser-network'

const REDACTED = '[REDACTED]'
const MAX_RECORDS = 500
const MAX_BODY_CHARS = 2 * 1024 * 1024
const MAX_CACHE_CHARS = 8 * 1024 * 1024
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_HEADER_CHARS = 32768
const SECRET_NAME = /(?:authorization|cookie|password|passwd|secret|credential|token|apikey|session|csrf|xsrf|signature|^pwd$|^key$|^auth$|^sig$)/i

type ObjectValue = Record<string, unknown>
type Target = 'request' | 'response'
interface BodyValue { state: BrowserNetworkBody['state']; text?: string; mimeType?: string; reason?: string; redacted?: boolean; truncated?: boolean }
interface Capture {
  entry: BrowserNetworkEntry
  cdpId: string
  started?: number
  observedAt: number
  expectedExtra?: boolean
  requestExtra: boolean
  responseExtra: boolean
  requestHeaders: BrowserNetworkHeader[]
  responseHeaders: BrowserNetworkHeader[]
  query: BrowserNetworkHeader[]
  requestCookies: BrowserNetworkHeader[]
  responseCookies: BrowserNetworkHeader[]
  requestBody: BodyValue
  responseBody: BodyValue
  requestMime?: string
  hasPostData: boolean
  redirected: boolean
  response: BrowserNetworkDetail['response']
  timing: Record<string, number>
  initiator?: BrowserNetworkDetail['initiator']
  previousRequestId?: string
  nextRequestId?: string
  warnings: string[]
}
interface Chain { hops: Capture[]; requestExtras: ObjectValue[]; responseExtras: ObjectValue[] }

function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {} }
function string(value: unknown, length = 8192): string { return typeof value === 'string' ? value.slice(0, length) : value === undefined || value === null ? '' : String(value).slice(0, length) }
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function secretName(name: string): boolean { return SECRET_NAME.test(name.replace(/[-_.\s]/g, '')) }
function redactedHeader(name: string): BrowserNetworkHeader { return { name, value: REDACTED, redacted: true } }
/** Fragments do not create a new Document capture and must not split records. */
function documentUrl(raw: string): string {
  if (!raw) return ''
  try { const url = new URL(raw); url.hash = ''; return url.href }
  catch { return raw.split('#', 1)[0] }
}

function redactCookieHeader(value: string, response: boolean): string {
  if (response) return value.split(/\r?\n|,(?=\s*[^=;,\s]+=)/).map((line) => {
    const equals = line.indexOf('=')
    if (equals < 0) return REDACTED
    const attributes = line.indexOf(';', equals)
    return `${line.slice(0, equals).trim()}=${REDACTED}${attributes < 0 ? '' : line.slice(attributes)}`
  }).join('\n')
  return value.split(';').map((part) => { const equals = part.indexOf('='); return equals < 0 ? part.trim() : `${part.slice(0, equals).trim()}=${REDACTED}` }).join('; ')
}

/** Sanitization happens before caching or pagination, so secrets cannot straddle chunks. */
export function redactNetworkUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    for (const name of [...new Set(url.searchParams.keys())]) if (secretName(name)) url.searchParams.set(name, REDACTED)
    if (url.hash.includes('=')) {
      const hash = new URLSearchParams(url.hash.slice(1))
      for (const name of [...new Set(hash.keys())]) if (secretName(name)) hash.set(name, REDACTED)
      url.hash = hash.toString()
    }
    return url.href.slice(0, 8192)
  } catch { return redactText(raw).text.slice(0, 8192) }
}

function redactText(raw: string): { text: string; redacted: boolean } {
  let changed = false
  const replace = (_match: string, prefix: string): string => { changed = true; return `${prefix}${REDACTED}` }
  let result = raw.replace(/((?:Bearer|Basic)\s+)[A-Za-z\d+/_.=~-]+/gi, replace)
  result = result.replace(/((?:["']?)(?:[\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|session|csrf|xsrf|signature)[\w.-]*|pwd|auth|key)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;}]+)/gi, replace)
  result = result.replace(/(<(?:password|token|secret|api[_-]?key)>)[\s\S]*?(?=<\/(?:password|token|secret|api[_-]?key)>)/gi, replace)
  result = result.replace(/(\bname="(?:[^"\r\n]*(?:password|token|secret|api[_-]?key|credential)[^"\r\n]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)[\s\S]*?(?=\r?\n--)/gi, replace)
  return { text: result, redacted: changed }
}

export function redactNetworkBody(raw: string, mimeType = ''): { text: string; redacted: boolean } {
  if (/json/i.test(mimeType) || /^\s*[\[{]/.test(raw)) {
    try {
      let changed = false
      const parsed: unknown = JSON.parse(raw, (name: string, value: unknown) => {
        if (name && secretName(name)) { changed = true; return REDACTED }
        if (typeof value === 'string') { const safe = redactText(value); changed ||= safe.redacted; return safe.text }
        return value
      })
      // Keep unmodified payloads byte-for-character stable for pagination and debugging.
      return { text: changed ? JSON.stringify(parsed, null, 2) : raw, redacted: changed }
    } catch { /* Invalid JSON remains inspectable through the conservative text scrubber. */ }
  }
  if (/x-www-form-urlencoded/i.test(mimeType)) {
    const params = new URLSearchParams(raw)
    let changed = false
    for (const name of [...new Set(params.keys())]) if (secretName(name)) { params.set(name, REDACTED); changed = true }
    return { text: changed ? params.toString() : raw, redacted: changed }
  }
  return redactText(raw)
}

function headers(raw: unknown, rawText?: unknown): BrowserNetworkHeader[] {
  const pairs = Object.entries(object(raw)).map(([name, value]) => [name, string(value, MAX_HEADER_CHARS)] as const)
  if (typeof rawText === 'string') {
    for (const line of rawText.slice(0, MAX_HEADER_CHARS * 2).split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon > 0) pairs.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
    }
  }
  const merged = new Map<string, BrowserNetworkHeader>()
  let length = 0
  for (const [name, value] of pairs) {
    if (merged.size >= 150 || length >= MAX_HEADER_CHARS) break
    const lower = name.toLowerCase()
    const safe = lower === 'cookie' || lower === 'set-cookie'
      ? { name: name.slice(0, 256), value: redactCookieHeader(value, lower === 'set-cookie').slice(0, Math.min(8192, MAX_HEADER_CHARS - length)), redacted: true }
      : secretName(name) ? redactedHeader(name) : { name: name.slice(0, 256), value: redactText(value).text.slice(0, Math.min(8192, MAX_HEADER_CHARS - length)) }
    merged.set(lower, safe)
    length += safe.name.length + safe.value.length
  }
  return [...merged.values()]
}

function mergeHeaders(previous: BrowserNetworkHeader[], next: BrowserNetworkHeader[]): BrowserNetworkHeader[] {
  const map = new Map(previous.map((item) => [item.name.toLowerCase(), item]))
  for (const item of next) map.set(item.name.toLowerCase(), item)
  return [...map.values()].slice(0, 150)
}

function rawHeader(raw: unknown, name: string): string {
  const entry = Object.entries(object(raw)).find(([key]) => key.toLowerCase() === name)
  return entry ? string(entry[1], MAX_HEADER_CHARS) : ''
}

function cookieNames(raw: unknown, response = false, associated?: unknown): BrowserNetworkHeader[] {
  const names = new Set<string>()
  const value = rawHeader(raw, response ? 'set-cookie' : 'cookie')
  if (response) {
    for (const match of value.matchAll(/(?:^|[\n,])\s*([^=;,\s]+)=/g)) names.add(match[1])
  } else for (const piece of value.split(';')) {
    const equals = piece.indexOf('=')
    if (equals > 0) names.add(piece.slice(0, equals).trim())
  }
  if (Array.isArray(associated)) for (const item of associated) {
    const name = string(object(object(item).cookie).name, 256)
    if (name) names.add(name)
  }
  return [...names].slice(0, 150).map(redactedHeader)
}

function queryParams(rawUrl: string): BrowserNetworkHeader[] {
  try {
    let remaining = 8192
    const result: BrowserNetworkHeader[] = []
    for (const [name, value] of new URL(rawUrl).searchParams) {
      if (remaining <= 0 || result.length >= 150) break
      const item = secretName(name) ? redactedHeader(name) : { name: name.slice(0, 256), value: redactText(value).text.slice(0, Math.min(4096, remaining)) }
      remaining -= item.name.length + item.value.length
      result.push(item)
    }
    return result
  }
  catch { return [] }
}

function isTextMime(mime: string): boolean { return !mime || /^(text\/)|json|javascript|ecmascript|xml|svg|x-www-form-urlencoded|graphql|multipart\/form-data/i.test(mime) }
function emptyBody(mimeType?: string): BodyValue { return { state: 'empty', mimeType } }
function unavailable(reason: string, mimeType?: string): BodyValue { return { state: 'unavailable', reason, mimeType } }

function integer(value: number | undefined, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label}无效`)
  return value
}

export function validateNetworkQuery(query: BrowserNetworkQuery = {}): Required<Pick<BrowserNetworkQuery, 'offset' | 'limit'>> & BrowserNetworkQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('网络筛选条件无效')
  for (const name of ['url', 'method', 'resourceType', 'status'] as const) if (query[name] !== undefined && (typeof query[name] !== 'string' || query[name]!.length > 2048)) throw new Error('网络筛选文本无效')
  if (query.failedOnly !== undefined && typeof query.failedOnly !== 'boolean') throw new Error('失败请求筛选无效')
  if (query.minDurationMs !== undefined && (!Number.isFinite(query.minDurationMs) || query.minDurationMs < 0)) throw new Error('最短耗时无效')
  if (query.status && !/^(?:[1-5]\d\d|[1-5]xx|failed|pending)$/i.test(query.status)) throw new Error('状态应为状态码、1xx–5xx、failed 或 pending')
  const limit = integer(query.limit, 50, 100, '网络列表每页数量')
  if (!limit) throw new Error('网络列表每页至少一条')
  return { ...query, offset: integer(query.offset, 0, Number.MAX_SAFE_INTEGER, '网络列表偏移'), limit }
}

function matches(entry: BrowserNetworkEntry, query: BrowserNetworkQuery): boolean {
  if (query.url && !entry.url.toLowerCase().includes(query.url.toLowerCase())) return false
  if (query.method && entry.method.toLowerCase() !== query.method.toLowerCase()) return false
  if (query.resourceType && entry.resourceType?.toLowerCase() !== query.resourceType.toLowerCase()) return false
  if (query.failedOnly && !entry.error && !(entry.status && entry.status >= 400)) return false
  if (query.minDurationMs !== undefined && (entry.durationMs === undefined || entry.durationMs < query.minDurationMs)) return false
  if (query.status) {
    const status = query.status.toLowerCase()
    if (status === 'pending') { if (entry.finished) return false }
    else if (status === 'failed') { if (!entry.error && !(entry.status && entry.status >= 400)) return false }
    else if (status.endsWith('xx')) { if (entry.status === undefined || Math.floor(entry.status / 100) !== Number(status[0])) return false }
    else if (entry.status !== Number(status)) return false
  }
  return true
}

function pageBody(body: BodyValue, offset: number, limit: number): BrowserNetworkBody {
  if (body.state !== 'available' || body.text === undefined) return { ...body, text: undefined, offset, returnedChars: 0, hasMore: false }
  const text = body.text.slice(offset, offset + limit)
  const next = offset + text.length
  const hasMore = next < body.text.length
  return { state: 'available', text, mimeType: body.mimeType, offset, totalChars: body.text.length, returnedChars: text.length, hasMore, ...(hasMore ? { nextOffset: next } : {}), redacted: body.redacted }
}

/** CDP requestId is a transport identity and is reused for redirects; UI IDs never are. */
export class BrowserNetworkCollector {
  private readonly idPrefix = randomUUID()
  private readonly records = new Map<string, Capture>()
  private readonly chains = new Map<string, Chain>()
  private readonly bodyCache = new Map<string, BodyValue>()
  private readonly bodyPending = new Map<string, Promise<void>>()
  private sequence = 0
  private captured = 0
  private dropped = 0
  private cachedChars = 0
  private disposed = false
  /** The active document loader fence prevents late CDP events from the old page
   * repopulating a list after a top-level navigation. */
  private awaitingDocument = false
  private expectedDocumentUrl = ''
  private activeDocumentUrl = ''
  private mainFrameId = ''
  private mainLoaderId = ''
  private readonly loaderIds = new Set<string>()
  private navigationId = 0
  private startedByDocument = false

  constructor(private readonly send: (method: string, params: Record<string, unknown>) => Promise<unknown>, private readonly options: { maxRecords?: number; maxBodyChars?: number; maxCacheChars?: number } = {}) {}

  clear(): void {
    this.disposed = true
    this.clearState()
  }

  /**
   * Starts a new top-level document capture. UI request IDs intentionally keep
   * their monotonic sequence across pages, so a stale detail request can never
   * resolve to a new page's request after this reset.
   */
  beginNavigation(navigationId: number, url: string): void {
    if (this.disposed) return
    const expected = documentUrl(url)
    // CDP can deliver the new Document request just before Electron emits
    // did-start-navigation. In that order event() already fenced and reset the
    // collector; only relabel the records instead of clearing them a second time.
    if (this.startedByDocument && this.activeDocumentUrl === expected) {
      this.navigationId = navigationId
      for (const capture of this.records.values()) capture.entry.navigationId = navigationId
      this.startedByDocument = false
      return
    }
    this.clearState()
    this.navigationId = navigationId
    this.expectedDocumentUrl = expected
    this.activeDocumentUrl = ''
    this.mainFrameId = ''
    this.mainLoaderId = ''
    this.loaderIds.clear()
    this.awaitingDocument = true
    this.startedByDocument = false
  }

  private clearState(): void {
    this.records.clear(); this.chains.clear(); this.bodyCache.clear(); this.bodyPending.clear(); this.cachedChars = 0
    this.captured = 0
    this.dropped = 0
    this.awaitingDocument = false
    this.expectedDocumentUrl = ''
    this.activeDocumentUrl = ''
    this.mainFrameId = ''
    this.mainLoaderId = ''
    this.loaderIds.clear()
  }

  event(method: string, params: ObjectValue, navigationId: number): void {
    if (this.disposed || !method.startsWith('Network.')) return
    const cdpId = string(params.requestId, 512)
    if (!cdpId) return
    if (method === 'Network.requestWillBeSent') {
      const request = object(params.request)
      const type = string(params.type, 80)
      const url = documentUrl(string(request.url, 65536))
      const loaderId = string(params.loaderId, 512)
      const frameId = string(params.frameId, 512)
      if (type === 'Document') {
        // A navigation can race did-start-navigation. Detect a new main-frame
        // loader here so the old page is fenced before its late events arrive.
        if (!this.awaitingDocument && this.mainLoaderId && loaderId && loaderId !== this.mainLoaderId && frameId === this.mainFrameId) {
          this.clearState()
          this.navigationId = navigationId
          this.startedByDocument = true
        }
        if (this.awaitingDocument) {
          if (this.expectedDocumentUrl && url && url !== this.expectedDocumentUrl) return
          this.awaitingDocument = false
        }
        if (!this.mainFrameId && frameId) this.mainFrameId = frameId
        if (frameId === this.mainFrameId || !this.mainLoaderId) {
          if (!this.mainLoaderId) { this.mainLoaderId = loaderId; this.activeDocumentUrl = url }
        }
        if (loaderId) this.loaderIds.add(loaderId)
      } else if (!this.acceptsLoader(loaderId)) return
      this.request(cdpId, params, this.navigationId || navigationId); return
    }
    // loadingFinished/loadingFailed do not carry a loaderId in the CDP
    // protocol. Their requestId is the only identity available, so let them
    // complete a capture that was admitted in this document epoch.
    if (
      method !== 'Network.loadingFinished' &&
      method !== 'Network.loadingFailed' &&
      method !== 'Network.requestServedFromCache' &&
      !this.acceptsLoader(string(params.loaderId, 512))
    )
      return
    if (method.endsWith('ExtraInfo')) {
      const chain = this.chain(cdpId)
      const events = method === 'Network.requestWillBeSentExtraInfo' ? chain.requestExtras : method === 'Network.responseReceivedExtraInfo' ? chain.responseExtras : undefined
      if (!events) return
      // ExtraInfo can arrive before the base event. Retain only a bounded, sanitized packet.
      events.push(this.safeExtra(method, params))
      if (events.length > 16) events.shift()
      this.flushExtra(chain)
      this.trimChains()
      return
    }
    const chain = this.chains.get(cdpId)
    const capture = chain?.hops.at(-1)
    if (!capture) return
    if (method === 'Network.responseReceived') {
      if (typeof params.hasExtraInfo === 'boolean') capture.expectedExtra = params.hasExtraInfo
      this.response(capture, object(params.response))
      this.flushExtra(chain!)
    } else if (method === 'Network.requestServedFromCache') capture.response.fromDiskCache = true
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      capture.entry.finished = true
      const ended = finite(params.timestamp)
      if (ended !== undefined && capture.started !== undefined) capture.entry.durationMs = Math.max(0, (ended - capture.started) * 1000)
      else capture.entry.durationMs = Math.max(0, performance.now() - capture.observedAt)
      capture.timing.durationMs = capture.entry.durationMs
      const bytes = finite(params.encodedDataLength)
      if (bytes !== undefined) capture.entry.transferredBytes = bytes
      if (method === 'Network.loadingFailed') {
        capture.entry.error = redactText(string(params.errorText)).text || '网络请求失败'
        if (this.hasNoResponseBody(capture)) {
          // Chromium can emit ERR_ABORTED after a valid 204 response. Preserve
          // the transport signal while representing the HTTP body semantics accurately.
          capture.responseBody = emptyBody(capture.response.mimeType)
          this.warning(capture, `已收到无正文的 HTTP 响应，随后 Chromium 报告 ${capture.entry.error}；传输错误仍保留在请求记录中`)
        } else capture.responseBody = unavailable(`请求失败：${capture.entry.error}`, capture.response.mimeType)
      } else if (capture.responseBody.state === 'pending') capture.responseBody = this.initialResponseBody(capture)
      capture.expectedExtra ??= true
      this.flushExtra(chain!)
    }
  }

  private acceptsLoader(loaderId: string): boolean {
    if (this.awaitingDocument) return false
    return !loaderId || !this.loaderIds.size || this.loaderIds.has(loaderId)
  }

  list(tab: BrowserTabState, query: BrowserNetworkQuery = {}): BrowserNetworkList {
    const normalized = validateNetworkQuery(query)
    const matching = [...this.records.values()].map((capture) => capture.entry.finished ? capture.entry : { ...capture.entry, durationMs: Math.max(0, performance.now() - capture.observedAt) }).filter((entry) => matches(entry, normalized))
    const entries = matching.slice(normalized.offset, normalized.offset + normalized.limit).map((entry) => structuredClone(entry))
    const nextOffset = normalized.offset + entries.length
    return { tab: { ...tab, url: redactNetworkUrl(tab.url) }, entries, total: matching.length, captured: this.captured, dropped: this.dropped, offset: normalized.offset, limit: normalized.limit, hasMore: nextOffset < matching.length, ...(nextOffset < matching.length ? { nextOffset } : {}) }
  }

  async detail(tab: BrowserTabState, id: string, options: BrowserNetworkDetailOptions = {}): Promise<BrowserNetworkDetail> {
    if (typeof id !== 'string' || !id) throw new Error('请选择网络列表返回的请求 ID')
    const capture = this.records.get(id)
    if (!capture) throw new Error('请求记录已回收或不属于此标签，请刷新网络列表')
    const target = options.bodyTarget ?? 'response'
    if (target !== 'request' && target !== 'response') throw new Error('正文方向无效')
    const offset = integer(options.bodyOffset, 0, Number.MAX_SAFE_INTEGER, '正文偏移')
    const limit = integer(options.bodyLimit, 12000, 60000, '正文分页数量')
    if (!limit) throw new Error('正文每页至少一个字符')
    await this.loadBody(capture, target)
    if (this.disposed || !this.records.has(id)) throw new Error('请求记录已回收，请刷新网络列表')
    const otherBodyLength = (target === 'request' ? capture.responseBody.text : capture.requestBody.text)?.length ?? 0
    return {
      tab: { ...tab, url: redactNetworkUrl(tab.url) }, entry: structuredClone(capture.entry),
      request: { headers: structuredClone(capture.requestHeaders), query: structuredClone(capture.query), cookies: structuredClone(capture.requestCookies), body: pageBody(capture.requestBody, target === 'request' ? offset : 0, target === 'request' ? limit : Math.min(limit, 2048)) },
      response: { ...structuredClone(capture.response), headers: structuredClone(capture.responseHeaders), cookies: structuredClone(capture.responseCookies), body: pageBody(capture.responseBody, target === 'response' ? offset : 0, target === 'response' ? limit : Math.min(limit, 2048)) },
      timing: structuredClone(capture.timing), initiator: structuredClone(capture.initiator), previousRequestId: capture.previousRequestId, nextRequestId: capture.nextRequestId,
      warnings: [...capture.warnings, ...(otherBodyLength > 2048 ? [`另一方向正文仅预览 2048 字符；使用 bodyTarget=${target === 'request' ? 'response' : 'request'} 继续读取`] : [])]
    }
  }

  private chain(cdpId: string): Chain {
    let chain = this.chains.get(cdpId)
    if (!chain) { chain = { hops: [], requestExtras: [], responseExtras: [] }; this.chains.set(cdpId, chain) }
    return chain
  }

  private request(cdpId: string, params: ObjectValue, navigationId: number): void {
    const chain = this.chain(cdpId)
    const previous = chain.hops.at(-1)
    const redirect = object(params.redirectResponse)
    if (previous && Object.keys(redirect).length) {
      this.response(previous, redirect)
      previous.redirected = true
      previous.entry.finished = true
      previous.expectedExtra = typeof params.redirectHasExtraInfo === 'boolean' ? params.redirectHasExtraInfo : true
      const now = finite(params.timestamp)
      if (now !== undefined && previous.started !== undefined) {
        previous.entry.durationMs = Math.max(0, (now - previous.started) * 1000)
        previous.timing.durationMs = previous.entry.durationMs
      }
      previous.responseBody = unavailable('重定向响应正文无法由 Chromium 在复用请求 ID 后读取', previous.response.mimeType)
    }
    const request = object(params.request)
    const rawUrl = string(request.url, 65536)
    const started = finite(params.timestamp)
    const requestMime = rawHeader(request.headers, 'content-type')
    const capture: Capture = {
      cdpId, started, observedAt: performance.now(), entry: { id: `request-${this.idPrefix}-${++this.sequence}`, timestamp: (finite(params.wallTime) ?? Date.now() / 1000) * 1000, method: string(request.method, 40), url: redactNetworkUrl(rawUrl), resourceType: string(params.type, 80), navigationId, finished: false },
      requestExtra: false, responseExtra: false, requestHeaders: headers(request.headers), responseHeaders: [], query: queryParams(rawUrl), requestCookies: cookieNames(request.headers), responseCookies: [],
      requestMime, hasPostData: request.hasPostData === true || typeof request.postData === 'string', requestBody: typeof request.postData === 'string' ? unavailable('请求正文等待缓存') : request.hasPostData ? unavailable('正文尚未读取；指定 bodyTarget=request 读取') : emptyBody(requestMime),
      responseBody: { state: 'pending', reason: '请求尚未完成' }, response: { headers: [], cookies: [], body: { state: 'pending', offset: 0, returnedChars: 0, hasMore: false } },
      timing: started !== undefined ? { requestTime: started } : {}, redirected: false, warnings: []
    }
    if (rawUrl.length > 8192 || rawUrl.slice(rawUrl.indexOf('?') + 1).length > 8192) capture.warnings.push('URL 或查询参数超过展示预算，部分内容已截断')
    try { if (new URL(rawUrl).searchParams.size > 150) this.warning(capture, '查询参数超过 150 项，部分内容已截断') } catch { /* The entry already retains the sanitized address. */ }
    this.warnHeaders(capture, request.headers)
    const initiator = object(params.initiator)
    if (typeof initiator.type === 'string') {
      const frames = object(initiator.stack).callFrames
      capture.initiator = { type: string(initiator.type, 80), ...(typeof initiator.url === 'string' ? { url: redactNetworkUrl(initiator.url) } : {}), ...(finite(initiator.lineNumber) !== undefined ? { lineNumber: finite(initiator.lineNumber) } : {}),
        ...(Array.isArray(frames) ? { stack: frames.slice(0, 30).map((frame) => { const item = object(frame); return { functionName: string(item.functionName, 200), url: redactNetworkUrl(string(item.url)), lineNumber: finite(item.lineNumber) ?? 0, columnNumber: finite(item.columnNumber) ?? 0 } }) } : {}) }
    }
    if (previous?.redirected && Object.keys(redirect).length) { capture.previousRequestId = previous.entry.id; previous.nextRequestId = capture.entry.id }
    chain.hops.push(capture)
    this.records.set(capture.entry.id, capture)
    this.captured += 1
    if (typeof request.postData === 'string') this.cacheBody(capture, 'request', request.postData, requestMime)
    this.flushExtra(chain)
    while (this.records.size > (this.options.maxRecords ?? MAX_RECORDS)) {
      const oldest = this.records.values().next().value as Capture
      this.records.delete(oldest.entry.id); this.dropped += 1
      this.removeBody(oldest, 'request'); this.removeBody(oldest, 'response')
      const oldChain = this.chains.get(oldest.cdpId)
      if (oldChain) oldChain.hops = oldChain.hops.filter((item) => item !== oldest)
      if (oldChain && !oldChain.hops.length) this.chains.delete(oldest.cdpId)
    }
    this.trimChains()
  }

  private response(capture: Capture, response: ObjectValue): void {
    capture.entry.status = finite(response.status)
    capture.entry.mimeType = string(response.mimeType, 256)
    capture.response.statusText = string(response.statusText, 200)
    capture.response.mimeType = capture.entry.mimeType
    capture.response.protocol = string(response.protocol, 80)
    capture.response.remoteIPAddress = string(response.remoteIPAddress, 100)
    capture.response.remotePort = finite(response.remotePort)
    capture.response.fromDiskCache = response.fromDiskCache === true
    capture.response.fromServiceWorker = response.fromServiceWorker === true
    capture.responseHeaders = mergeHeaders(capture.responseHeaders, headers(response.headers))
    this.warnHeaders(capture, response.headers)
    capture.responseCookies = mergeHeaders(capture.responseCookies, cookieNames(response.headers, true))
    for (const [key, value] of Object.entries(object(response.timing))) { const numeric = finite(value); if (numeric !== undefined) capture.timing[key.slice(0, 80)] = numeric }
  }

  private safeExtra(method: string, params: ObjectValue): ObjectValue {
    const response = method === 'Network.responseReceivedExtraInfo'
    const blocked = response ? params.blockedCookies : params.associatedCookies
    return { headers: headers(params.headers, params.headersText), cookies: cookieNames(params.headers, response, params.associatedCookies), statusCode: finite(params.statusCode), connectTiming: object(params.connectTiming), truncatedHeaders: this.headersTruncated(params.headers), blockedCookies: Array.isArray(blocked) ? blocked.slice(0, 20).flatMap((item) => { const reasons = object(item).blockedReasons; return Array.isArray(reasons) ? reasons.map((value) => string(value, 80)) : [] }) : [] }
  }

  private flushExtra(chain: Chain): void {
    for (const capture of chain.hops) {
      if (capture.expectedExtra === undefined) break
      if (!capture.expectedExtra) continue
      if (!capture.requestExtra && chain.requestExtras.length) {
        const extra = chain.requestExtras.shift()!
        capture.requestExtra = true
        capture.requestHeaders = mergeHeaders(capture.requestHeaders, extra.headers as BrowserNetworkHeader[])
        capture.requestCookies = mergeHeaders(capture.requestCookies, extra.cookies as BrowserNetworkHeader[])
        capture.requestMime ||= capture.requestHeaders.find((header) => header.name.toLowerCase() === 'content-type')?.value
        capture.requestBody.mimeType ||= capture.requestMime
        if (extra.truncatedHeaders) this.warning(capture, '请求头超过展示预算，部分内容已截断')
        if (Array.isArray(extra.blockedCookies) && extra.blockedCookies.length) this.warning(capture, `部分请求 Cookie 被 Chromium 阻止：${extra.blockedCookies.join(', ')}`)
        for (const [key, value] of Object.entries(object(extra.connectTiming))) { const number = finite(value); if (number !== undefined) capture.timing[key.slice(0, 80)] = number }
      }
      if (!capture.responseExtra && chain.responseExtras.length) {
        const extra = chain.responseExtras.shift()!
        capture.responseExtra = true
        capture.responseHeaders = mergeHeaders(capture.responseHeaders, extra.headers as BrowserNetworkHeader[])
        capture.responseCookies = mergeHeaders(capture.responseCookies, extra.cookies as BrowserNetworkHeader[])
        if (extra.truncatedHeaders) this.warning(capture, '响应头超过展示预算，部分内容已截断')
        if (Array.isArray(extra.blockedCookies) && extra.blockedCookies.length) this.warning(capture, `部分响应 Cookie 被 Chromium 阻止：${extra.blockedCookies.join(', ')}`)
        if (finite(extra.statusCode) !== undefined) capture.entry.status = finite(extra.statusCode)
      }
    }
  }

  private initialResponseBody(capture: Capture): BodyValue {
    const mime = capture.response.mimeType
    if (this.hasNoResponseBody(capture)) return emptyBody(mime)
    if (!isTextMime(mime ?? '')) return { state: 'binary', mimeType: mime, reason: '二进制响应不按文本返回；可在页面或下载文件中查看' }
    const length = Number(capture.responseHeaders.find((header) => header.name.toLowerCase() === 'content-length')?.value)
    if (length > MAX_BODY_BYTES) return { state: 'too-large', mimeType: mime, reason: '响应超过 8 MiB 的正文读取上限', truncated: true }
    return unavailable('正文尚未读取；指定 bodyTarget=response 读取', mime)
  }

  private hasNoResponseBody(capture: Capture): boolean {
    return capture.entry.status !== undefined && (capture.entry.method === 'HEAD' || [204, 205, 304].includes(capture.entry.status))
  }

  private async loadBody(capture: Capture, target: Target): Promise<void> {
    const body = target === 'request' ? capture.requestBody : capture.responseBody
    if (body.state !== 'unavailable') return
    if (target === 'request' && !capture.hasPostData || target === 'response' && (!capture.entry.finished || !!capture.entry.error)) return
    if (this.chains.get(capture.cdpId)?.hops.at(-1) !== capture || capture.redirected) {
      body.reason = 'Chromium 请求 ID 已用于后续请求，此正文无法再读取'
      return
    }
    const key = `${capture.entry.id}:${target}`
    if (this.bodyPending.has(key)) return this.bodyPending.get(key)
    const task = (async (): Promise<void> => {
      try {
        const result = object(await this.send(target === 'response' ? 'Network.getResponseBody' : 'Network.getRequestPostData', { requestId: capture.cdpId }))
        if (this.disposed || !this.records.has(capture.entry.id)) return
        // A redirect/reused CDP id during the await must not bind the next response to this request.
        if (this.chains.get(capture.cdpId)?.hops.at(-1) !== capture) { body.reason = '请求在读取正文时发生重定向或 ID 复用，请读取后续请求'; return }
        const received = target === 'response' ? result.body : result.postData
        if (typeof received !== 'string') { body.reason = 'Chromium 未返回正文'; return }
        let raw: string = received
        if (target === 'response' && result.base64Encoded === true) {
          if (raw.length > MAX_BODY_BYTES * 4 / 3 + 8) { this.setBody(capture, target, { state: 'too-large', reason: '响应正文超过 8 MiB 读取上限', mimeType: capture.response.mimeType, truncated: true }); return }
          raw = Buffer.from(raw, 'base64').toString('utf8')
        }
        this.cacheBody(capture, target, raw, target === 'request' ? capture.requestMime : capture.response.mimeType)
      } catch (error) {
        if (this.disposed) return
        const reason = error instanceof Error ? error.message : String(error)
        body.reason = `Chromium 无法提供此正文（可能已被缓存回收、请求失败或跨进程导航）：${redactText(reason).text.slice(0, 500)}`
      }
    })()
    this.bodyPending.set(key, task)
    try { await task } finally { this.bodyPending.delete(key) }
  }

  private cacheBody(capture: Capture, target: Target, raw: string, mime?: string): void {
    if (raw.length > (this.options.maxBodyChars ?? MAX_BODY_CHARS)) { this.setBody(capture, target, { state: 'too-large', mimeType: mime, reason: '正文超过单请求 2 Mi 字符读取上限', truncated: true }); return }
    if (!raw) { this.setBody(capture, target, emptyBody(mime)); return }
    if (!isTextMime(mime ?? '') || raw.includes('\u0000')) { this.setBody(capture, target, { state: 'binary', mimeType: mime, reason: '正文是二进制数据，不按文本返回' }); return }
    const safe = redactNetworkBody(raw, mime)
    if (safe.text.length > (this.options.maxBodyChars ?? MAX_BODY_CHARS)) { this.setBody(capture, target, { state: 'too-large', mimeType: mime, reason: '脱敏后的正文超过单请求字符上限', truncated: true }); return }
    this.setBody(capture, target, { state: 'available', mimeType: mime, text: safe.text, redacted: safe.redacted })
  }

  private setBody(capture: Capture, target: Target, body: BodyValue): void {
    this.removeBody(capture, target)
    if (target === 'request') capture.requestBody = body
    else capture.responseBody = body
    if (body.text === undefined) return
    const budget = this.options.maxCacheChars ?? MAX_CACHE_CHARS
    if (body.text.length > budget) { body.text = undefined; body.state = 'too-large'; body.reason = '正文超过当前缓存预算'; body.truncated = true; return }
    while (this.cachedChars + body.text.length > budget && this.bodyCache.size) {
      const [key, value] = this.bodyCache.entries().next().value as [string, BodyValue]
      this.cachedChars -= value.text?.length ?? 0
      value.text = undefined; value.state = 'unavailable'; value.reason = '正文缓存已回收，可重新请求读取'
      this.bodyCache.delete(key)
    }
    this.bodyCache.set(`${capture.entry.id}:${target}`, body)
    this.cachedChars += body.text.length
  }

  private removeBody(capture: Capture, target: Target): void {
    const key = `${capture.entry.id}:${target}`
    const cached = this.bodyCache.get(key)
    this.cachedChars -= cached?.text?.length ?? 0
    this.bodyCache.delete(key)
  }

  private trimChains(): void {
    if (this.chains.size <= (this.options.maxRecords ?? MAX_RECORDS) + 32) return
    for (const [id, chain] of this.chains) {
      if (!chain.hops.length) this.chains.delete(id)
      if (this.chains.size <= (this.options.maxRecords ?? MAX_RECORDS) + 32) break
    }
  }

  private headersTruncated(raw: unknown): boolean {
    const entries = Object.entries(object(raw))
    return entries.length > 150 || entries.reduce((sum, [name, value]) => sum + name.length + String(value).length, 0) > MAX_HEADER_CHARS || entries.some(([, value]) => String(value).length > 8192)
  }

  private warning(capture: Capture, message: string): void { if (!capture.warnings.includes(message) && capture.warnings.length < 20) capture.warnings.push(message) }
  private warnHeaders(capture: Capture, raw: unknown): void { if (this.headersTruncated(raw)) this.warning(capture, '请求或响应头超过展示预算，部分内容已截断') }
}
