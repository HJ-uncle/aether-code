/** Pure CDP network collector tests: ordering, filters, redirect identity, body paging, redaction and bounded retention. */
import { expect, test } from '@playwright/test'
import { BrowserNetworkCollector, redactNetworkBody, redactNetworkUrl, validateNetworkQuery } from '../src/main/browser/network-collector'
import type { BrowserTabState } from '../src/shared/browser'

const tab: BrowserTabState = { tabId: 'tab', title: 'Test', url: 'http://localhost/page?token=private-tab-token', loading: false, canGoBack: false, canGoForward: false, zoomFactor: 1, viewport: null, navigationId: 1 }
function request(collector: BrowserNetworkCollector, id: string, url = `http://localhost/api/${id}`, extra: Record<string, unknown> = {}): void {
  collector.event('Network.requestWillBeSent', { requestId: id, timestamp: 10, wallTime: 1000, type: 'Fetch', request: { url, method: 'GET', headers: {} }, ...extra }, 1)
}
function response(collector: BrowserNetworkCollector, id: string, status = 200, mimeType = 'application/json', hasExtraInfo = false): void {
  collector.event('Network.responseReceived', { requestId: id, hasExtraInfo, response: { status, statusText: 'OK', mimeType, headers: { 'Content-Type': mimeType }, protocol: 'http/1.1', remoteIPAddress: '127.0.0.1', timing: { requestTime: 10, sendStart: 0.5, receiveHeadersEnd: 4 } } }, 1)
}
function finish(collector: BrowserNetworkCollector, id: string): void { collector.event('Network.loadingFinished', { requestId: id, timestamp: 10.25, encodedDataLength: 64 }, 1) }
function publicId(collector: BrowserNetworkCollector, url: string): string { return collector.list(tab, { url, limit: 100 }).entries[0].id }

test('filters precede stable forward pagination and pending/failed are explicit', () => {
  const collector = new BrowserNetworkCollector(async () => ({}))
  for (let index = 0; index < 65; index++) { request(collector, `batch-${index}`); response(collector, `batch-${index}`); finish(collector, `batch-${index}`) }
  request(collector, 'bad'); response(collector, 'bad', 503); finish(collector, 'bad')
  request(collector, 'pending')
  request(collector, 'broken'); collector.event('Network.loadingFailed', { requestId: 'broken', timestamp: 10.1, errorText: 'net::ERR_CONNECTION_RESET' }, 1)
  const first = collector.list(tab, { url: 'batch', status: '2xx', resourceType: 'fetch', method: 'get' })
  expect(first).toMatchObject({ total: 65, limit: 50, hasMore: true, nextOffset: 50 })
  expect(collector.list(tab, { url: 'batch', offset: 50 }).entries).toHaveLength(15)
  expect(collector.list(tab, { failedOnly: true }).entries).toHaveLength(2)
  expect(collector.list(tab, { status: 'pending' }).entries.map(entry => entry.url)).toEqual(['http://localhost/api/pending'])
  expect(collector.list(tab, { status: '5xx' }).entries).toHaveLength(1)
  expect(collector.list(tab, { minDurationMs: 300 }).entries.filter(entry => entry.finished)).toHaveLength(0)
  expect(JSON.stringify(first)).not.toContain('private-tab-token')
  expect(() => validateNetworkQuery({ status: 'oops' })).toThrow()
  expect(() => validateNetworkQuery({ limit: 101 })).toThrow()
  expect(() => validateNetworkQuery({ offset: -1 })).toThrow()
})

test('request/response/query/header/cookie secrets are removed before body pagination', async () => {
  const collector = new BrowserNetworkCollector(async () => ({ body: JSON.stringify({ message: '普通中文', access_token: 'response-secret', child: { password: 'nested-secret' } }) }))
  request(collector, 'post', undefined, { request: { url: 'http://localhost/echo?q=中文&token=query-secret', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer header-secret', Cookie: 'sid=cookie-secret; theme=dark', 'X-Aether-Instance-Token': 'engine-secret', 'X-Trace': 'trace-1' }, postData: JSON.stringify({ title: '提交中文', password: 'request-secret', count: 2 }), hasPostData: true } })
  response(collector, 'post', 201)
  finish(collector, 'post')
  const id = publicId(collector, '/echo')
  const detail = await collector.detail(tab, id)
  expect(JSON.parse(detail.request.body.text!)).toMatchObject({ title: '提交中文', count: 2, password: '[REDACTED]' })
  expect(JSON.parse(detail.response.body.text!)).toMatchObject({ message: '普通中文', access_token: '[REDACTED]' })
  expect(detail.request.cookies.map(cookie => cookie.name)).toEqual(['sid', 'theme'])
  expect(detail.request.headers.find(header => header.name === 'X-Trace')?.value).toBe('trace-1')
  expect(detail.request.query.find(query => query.name === 'q')?.value).toBe('中文')
  for (const secret of ['private-tab-token', 'response-secret', 'nested-secret', 'query-secret', 'header-secret', 'cookie-secret', 'engine-secret', 'request-secret']) expect(JSON.stringify(detail)).not.toContain(secret)
  const page = await collector.detail(tab, id, { bodyLimit: 7 })
  expect(page.response.body).toMatchObject({ returnedChars: 7, hasMore: true, nextOffset: 7 })
  const remainder = await collector.detail(tab, id, { bodyOffset: 7, bodyLimit: 60000 })
  expect(page.response.body.text! + remainder.response.body.text!).toBe(detail.response.body.text)
})

test('ExtraInfo arriving before request and after redirects remains bound to the correct hop', async () => {
  const collector = new BrowserNetworkCollector(async () => ({ body: 'done' }))
  collector.event('Network.requestWillBeSentExtraInfo', { requestId: 'chain', headers: { 'X-Request-Hop': 'first', Cookie: 'a=first-secret' } }, 1)
  request(collector, 'chain', 'http://localhost/start')
  collector.event('Network.responseReceivedExtraInfo', { requestId: 'chain', statusCode: 302, headers: { 'X-Response-Hop': 'first', 'Set-Cookie': 'login=response-secret; HttpOnly; Path=/' } }, 1)
  request(collector, 'chain', 'http://localhost/finish', { timestamp: 10.1, redirectHasExtraInfo: true, redirectResponse: { status: 302, mimeType: 'text/html', headers: { Location: '/finish' } } })
  collector.event('Network.requestWillBeSentExtraInfo', { requestId: 'chain', headers: { 'X-Request-Hop': 'last' } }, 1)
  response(collector, 'chain', 200, 'text/plain', true)
  collector.event('Network.responseReceivedExtraInfo', { requestId: 'chain', statusCode: 200, headers: { 'X-Response-Hop': 'last' } }, 1)
  finish(collector, 'chain')
  const first = await collector.detail(tab, publicId(collector, '/start'))
  const last = await collector.detail(tab, publicId(collector, '/finish'))
  expect(first.entry.id).not.toBe(last.entry.id)
  expect(first.nextRequestId).toBe(last.entry.id)
  expect(last.previousRequestId).toBe(first.entry.id)
  expect(first.entry.status).toBe(302)
  expect(first.request.headers).toContainEqual({ name: 'X-Request-Hop', value: 'first' })
  expect(last.request.headers).toContainEqual({ name: 'X-Request-Hop', value: 'last' })
  expect(first.response.headers).toContainEqual({ name: 'X-Response-Hop', value: 'first' })
  expect(last.response.headers).toContainEqual({ name: 'X-Response-Hop', value: 'last' })
  expect(first.response.body.state).toBe('unavailable')
  expect(last.response.body.text).toBe('done')
  expect(first.response.headers.find(header => header.name === 'Set-Cookie')?.value).toContain('HttpOnly')
  expect(JSON.stringify(first)).not.toContain('response-secret')
})

test('a redirect without ExtraInfo does not steal the following hop headers', async () => {
  const collector = new BrowserNetworkCollector(async () => ({ body: 'ok' }))
  request(collector, 'redirect', 'http://localhost/first')
  request(collector, 'redirect', 'http://localhost/second', { redirectHasExtraInfo: false, redirectResponse: { status: 302, headers: {} } })
  collector.event('Network.requestWillBeSentExtraInfo', { requestId: 'redirect', headers: { 'X-Only-Second': 'yes' } }, 1)
  response(collector, 'redirect', 200, 'text/plain', true)
  finish(collector, 'redirect')
  expect((await collector.detail(tab, publicId(collector, '/first'))).request.headers).not.toContainEqual({ name: 'X-Only-Second', value: 'yes' })
  expect((await collector.detail(tab, publicId(collector, '/second'))).request.headers).toContainEqual({ name: 'X-Only-Second', value: 'yes' })
})

test('base64 UTF-8 text, binary, empty, pending and failures have distinct body states', async () => {
  let reads = 0
  const collector = new BrowserNetworkCollector(async () => { reads += 1; return { body: Buffer.from('中文内容').toString('base64'), base64Encoded: true } })
  for (const [id, status, mime] of [['text', 200, 'text/plain'], ['binary', 200, 'image/png'], ['empty', 204, 'text/plain']] as const) { request(collector, id); response(collector, id, status, mime); finish(collector, id) }
  request(collector, 'pending')
  expect((await collector.detail(tab, publicId(collector, '/text'))).response.body.text).toBe('中文内容')
  expect((await collector.detail(tab, publicId(collector, '/binary'))).response.body.state).toBe('binary')
  expect((await collector.detail(tab, publicId(collector, '/empty'))).response.body.state).toBe('empty')
  expect((await collector.detail(tab, publicId(collector, '/pending'))).response.body.state).toBe('pending')
  expect(reads).toBe(1)
  const failed = new BrowserNetworkCollector(async () => { throw new Error('No resource with given identifier') })
  request(failed, 'expired'); response(failed, 'expired'); finish(failed, 'expired')
  expect((await failed.detail(tab, publicId(failed, '/expired'))).response.body).toMatchObject({ state: 'unavailable', hasMore: false, reason: expect.stringContaining('Chromium') })
})

test('an aborted no-body response stays empty without concealing its transport error', async () => {
  let reads = 0
  const collector = new BrowserNetworkCollector(async () => { reads += 1; return { body: 'unexpected' } })
  for (const [id, status, method] of [['empty', 204, 'GET'], ['reset', 205, 'GET'], ['head', 200, 'HEAD'], ['ordinary', 200, 'GET']] as const) {
    request(collector, id, undefined, { request: { url: `http://localhost/${id}`, method, headers: {} } })
    response(collector, id, status, 'text/plain')
    collector.event('Network.loadingFailed', { requestId: id, timestamp: 10.1, errorText: 'net::ERR_ABORTED' }, 1)
    const detail = await collector.detail(tab, publicId(collector, `/${id}`))
    expect(detail.entry.error).toBe('net::ERR_ABORTED')
    expect(detail.response.body.state).toBe(id === 'ordinary' ? 'unavailable' : 'empty')
    if (id !== 'ordinary') expect(detail.warnings).toContainEqual(expect.stringContaining('无正文'))
  }
  request(collector, 'head-before-response', undefined, { request: { url: 'http://localhost/head-before-response', method: 'HEAD', headers: {} } })
  collector.event('Network.loadingFailed', { requestId: 'head-before-response', errorText: 'net::ERR_CONNECTION_REFUSED' }, 1)
  expect((await collector.detail(tab, publicId(collector, '/head-before-response'))).response.body.state).toBe('unavailable')
  expect(collector.list(tab, { failedOnly: true }).total).toBe(5)
  expect(reads).toBe(0)
})

test('bounded record/body retention reports evictions and cross-tab IDs never collide', async () => {
  const collector = new BrowserNetworkCollector(async () => ({ body: 'hello!' }), { maxRecords: 2, maxCacheChars: 8, maxBodyChars: 100 })
  for (const id of ['one', 'two']) { request(collector, id); response(collector, id, 200, 'text/plain'); finish(collector, id) }
  const firstId = publicId(collector, '/one')
  await collector.detail(tab, firstId)
  await collector.detail(tab, publicId(collector, '/two'))
  const firstMetadata = await collector.detail(tab, firstId, { bodyTarget: 'request' })
  expect(firstMetadata.response.body).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('缓存已回收') })
  request(collector, 'three')
  expect(collector.list(tab)).toMatchObject({ captured: 3, dropped: 1, total: 2 })
  await expect(collector.detail(tab, firstId)).rejects.toThrow('回收')
  const other = new BrowserNetworkCollector(async () => ({})); request(other, 'two')
  await expect(other.detail(tab, publicId(collector, '/two'))).rejects.toThrow('不属于')
})

test('oversized body is explicit and cached request payload is independently pageable', async () => {
  const collector = new BrowserNetworkCollector(async () => ({ body: 'response'.repeat(20) }), { maxBodyChars: 100 })
  request(collector, 'post', undefined, { request: { url: 'http://localhost/post', method: 'POST', headers: { 'Content-Type': 'text/plain' }, postData: '0123456789'.repeat(5) } })
  response(collector, 'post', 200, 'text/plain'); finish(collector, 'post')
  const id = publicId(collector, '/post')
  expect((await collector.detail(tab, id)).response.body).toMatchObject({ state: 'too-large', truncated: true, hasMore: false })
  expect((await collector.detail(tab, id, { bodyTarget: 'request', bodyOffset: 10, bodyLimit: 12 })).request.body).toMatchObject({ text: '012345678901', offset: 10, nextOffset: 22, totalChars: 50 })
})

test('redaction preserves ordinary values and handles forms and secret-bearing URLs', () => {
  expect(redactNetworkBody('title=hello&api_key=private&count=2', 'application/x-www-form-urlencoded').text).toContain('title=hello')
  expect(redactNetworkBody('title=hello&api_key=private&count=2', 'application/x-www-form-urlencoded').text).not.toContain('private')
  expect(redactNetworkBody('Authorization: Bearer abcdef', 'text/plain').text).not.toContain('abcdef')
  expect(redactNetworkUrl('https://user:private@example.test/api?password=private&name=visible')).not.toContain('private')
  expect(redactNetworkUrl('https://example.test/api?name=visible')).toContain('name=visible')
})

test('top-level reset fences late old-loader events while retaining the new document redirect chain', () => {
  const collector = new BrowserNetworkCollector(async () => ({ body: 'ok' }))
  collector.beginNavigation(2, 'http://localhost/new')
  // A response from the old document can race Electron's navigation event. It
  // must not create a record while the collector waits for the new Document.
  collector.event('Network.requestWillBeSent', { requestId: 'old', loaderId: 'loader-old', frameId: 'frame-main', type: 'Fetch', request: { url: 'http://localhost/old.js', method: 'GET', headers: {} } }, 2)
  collector.event('Network.requestWillBeSent', { requestId: 'doc', loaderId: 'loader-new', frameId: 'frame-main', type: 'Document', request: { url: 'http://localhost/new', method: 'GET', headers: {} } }, 2)
  collector.event('Network.requestWillBeSent', { requestId: 'doc', loaderId: 'loader-new', frameId: 'frame-main', type: 'Document', timestamp: 10.1, redirectResponse: { status: 302, headers: {}, mimeType: 'text/html' }, request: { url: 'http://localhost/final', method: 'GET', headers: {} } }, 2)
  collector.event('Network.responseReceived', { requestId: 'doc', loaderId: 'loader-new', response: { status: 200, mimeType: 'text/html', headers: {} } }, 2)
  collector.event('Network.loadingFinished', { requestId: 'doc', loaderId: 'loader-new', timestamp: 10.2 }, 2)
  expect(collector.list(tab).entries.map(entry => entry.url)).toEqual(['http://localhost/new', 'http://localhost/final'])
  expect(collector.list(tab).entries.every(entry => entry.navigationId === 2)).toBe(true)
  // Late old-loader traffic remains fenced after the new document is active.
  collector.event('Network.requestWillBeSent', { requestId: 'old-late', loaderId: 'loader-old', frameId: 'frame-main', type: 'Fetch', request: { url: 'http://localhost/old-late.js', method: 'GET', headers: {} } }, 2)
  expect(collector.list(tab).total).toBe(2)
})

test('an in-flight body read from the previous page cannot write into the new capture', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const collector = new BrowserNetworkCollector(async () => { await blocked; return { body: 'old-page-body' } })
  request(collector, 'old-body', 'http://localhost/old-body')
  response(collector, 'old-body', 200, 'text/plain')
  finish(collector, 'old-body')
  const detailPromise = collector.detail(tab, publicId(collector, '/old-body'))
  collector.beginNavigation(2, 'http://localhost/new')
  release()
  await expect(detailPromise).rejects.toThrow('请求记录已回收')
  expect(collector.list(tab).total).toBe(0)
})
