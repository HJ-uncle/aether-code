/** Production React result reader + client over an isolated HTTP bridge. No user app/profile/model. */
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SubagentRunV1 } from '../src/shared/subagent'

const root = resolve(__dirname, '..')
const body = '开头：结果原文\n' + '接口核对🧠\n'.repeat(2500) + '完整结果最后一行：RESULT_FINAL_TAIL'
const bytes = Buffer.from(body), hash = createHash('sha256').update(bytes).digest('hex'), ref = `subagent-result:v1:${hash}`
const run: SubagentRunV1 = { schemaVersion: 1, runId: 'result-child', tenantId: 'fixture', rootSessionId: 'result-parent',
  parentSessionId: 'result-parent', parentConversationId: 'turn', parentMessageId: 'answer', parentToolCallId: 'dispatch',
  childSessionId: 'child-session', task: '核对结果', description: '', modelId: 'fixture', status: 'succeeded', lastSeq: 2,
  createdAt: 1, updatedAt: 2, toolCalls: [], usage: {}, resultSummary: '四千字节以内的结果预览',
  resultRef: ref, resultHash: hash, resultBytes: bytes.length, resultTruncated: true, resultKind: 'final' }
let browser: Browser, context: BrowserContext, page: Page, bundle: string, origin = ''
let requests: Array<{ path: string; parent: string | null; offset: number; limit: number }> = []
let errors: string[] = [], badIdentity = false, deferred = false
let delayed: (() => void) | undefined
const respond = (response: ServerResponse, data: unknown): void => { response.end(JSON.stringify({ code: 200, message: 'ok', data })) }
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json'); response.setHeader('access-control-allow-origin', '*')
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limitBytes'))
  requests.push({ path: url.pathname, parent: url.searchParams.get('parentSessionId'), offset, limit })
  const answer = (): void => {
    if (url.pathname !== '/api/v1/subagent/runs/result-child/result' || url.searchParams.get('parentSessionId') !== run.parentSessionId)
      return respond(response, null)
    let end = Math.min(bytes.length, offset + limit)
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--
    respond(response, { runId: badIdentity ? 'foreign-child' : run.runId, resultRef: ref, resultHash: hash, resultKind: 'final',
      encoding: 'utf8', offset, text: bytes.subarray(offset, end).toString('utf8'), totalBytes: bytes.length,
      hasMore: end < bytes.length, ...(end < bytes.length ? { nextOffset: end } : {}) })
  }
  if (deferred) delayed = answer
  else answer()
})

test.beforeAll(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port')
  origin = `http://127.0.0.1:${address.port}`
  const built = await build({ stdin: { sourcefile: 'subagent-result-fixture.tsx', resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { AppContext } from './src/renderer/src/core/app-context'
    import { DEFAULT_SETTINGS } from './src/shared/ipc'
    import { SubagentResultReader } from './src/renderer/src/features/conversation/shared/SubagentResultReader'
    import { publishEngineSource } from './src/renderer/src/core/engine/source'
    const root = createRoot(document.getElementById('fixture'))
    window.setFixtureSource = identity => publishEngineSource({ mode:'remote',baseUrl:${JSON.stringify(origin)},instanceId:identity,phase:'ready' })
    window.setFixtureSource('initial')
    window.aether = { engine: { request: async input => {
      const url = new URL('/api/v1' + input.path, ${JSON.stringify(origin)})
      Object.entries(input.query || {}).forEach(([key,value]) => url.searchParams.set(key,String(value)))
      const response = await fetch(url), envelope = await response.json()
      return {ok:envelope.code===200, ...envelope}
    } } }
    window.renderResult = ({ run, ready=true, visible=true }) => root.render(<AppContext.Provider value={{
      engine:{snapshot:{mode:'remote'}},settings:DEFAULT_SETTINGS,userSettings:DEFAULT_SETTINGS,ready,settingsLoaded:true,
      updateSettings:async()=>{throw Error('No writes')}
    }}><SubagentResultReader run={run} visible={visible}><p data-preview>{run.resultSummary}</p></SubagentResultReader></AppContext.Provider>)
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    tsconfig: resolve(root, 'tsconfig.web.json'), loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture-vite-imports', setup(build) {
      build.onResolve({ filter: /\?worker$/ }, args => ({ path: args.path, namespace: 'blocked-worker' }))
      build.onLoad({ filter: /.*/, namespace: 'blocked-worker' }, () => ({ contents: 'export default class { constructor(){throw Error("No editor in result fixture")} }' }))
      build.onResolve({ filter: /\?(?:inline|raw)$/ }, async args => ({ path: (await build.resolve(args.path.replace(/\?[^?]+$/, ''), { resolveDir: args.resolveDir, kind: args.kind })).path, namespace: 'raw-resource' }))
      build.onLoad({ filter: /.*/, namespace: 'raw-resource' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
    } }] })
  bundle = built.outputFiles[0].text
  const executablePath = [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
})
test.afterAll(async () => { await browser?.close(); await new Promise<void>(done => server.close(() => done())) })
test.beforeEach(async () => {
  requests = []; errors = []; badIdentity = false; deferred = false; delayed = undefined
  context = await browser.newContext({ viewport: { width: 420, height: 600 }, reducedMotion: 'reduce' })
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<html data-appearance="light"><body><main id="fixture"></main></body></html>')
  const css = ['assets/tokens.css', 'assets/base.css', 'assets/motion.css', 'features/conversation/shared/subagent-result-reader.css']
    .map(file => readFileSync(resolve(root, 'src/renderer/src', file), 'utf8')).join('\n')
  await page.addStyleTag({ content: css + '\nbody{padding:16px;overflow:auto}#fixture{width:360px;max-width:100%}' })
  await page.addScriptTag({ content: bundle })
})
test.afterEach(async () => { delayed?.(); delayed = undefined; try { expect(errors).toEqual([]) } finally { await context?.close() } })
async function render(patch: Partial<SubagentRunV1> = {}, ready = true) {
  await page.evaluate(value => (window as unknown as { renderResult: (props: unknown) => void }).renderResult(value), { run: { ...run, ...patch }, ready })
  await expect(page.locator('[data-preview]')).toBeVisible()
}

for (const theme of ['light', 'dark']) test(`${theme}: manual read pages preserve exact text, boundaries and bounded resident content`, async ({}, info) => {
  await page.evaluate(theme => document.documentElement.dataset.appearance = theme, theme)
  await render()
  expect(requests).toEqual([])
  await expect(page.getByText('当前仅显示结果预览，完整内容已单独保存。')).toBeVisible()
  const read = page.getByRole('button', { name: '读取完整结果' })
  const previewScreenshot = info.outputPath(`result-preview-${theme}.png`)
  await page.screenshot({ path: previewScreenshot, animations: 'disabled' })
  await info.attach(`result-preview-${theme}`, { path: previewScreenshot, contentType: 'image/png' })
  await read.focus(); await page.keyboard.press('Enter')
  const text = page.locator('.subagent-result-reader__text')
  await expect(text).toContainText('开头：结果原文')
  await expect(page.locator('[data-preview]')).toHaveCount(0)
  await expect(page.getByText('当前仅显示结果预览，完整内容已单独保存。')).toHaveCount(0)
  const pageScreenshot = info.outputPath(`result-page-${theme}.png`)
  await page.screenshot({ path: pageScreenshot, animations: 'disabled' })
  await info.attach(`result-page-${theme}`, { path: pageScreenshot, contentType: 'image/png' })
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ parent: 'result-parent', offset: 0, limit: 16384 })
  let assembled = await text.textContent() ?? ''
  const first = assembled
  while (await page.getByRole('button', { name: '下一页结果' }).isEnabled()) {
    const old = requests.length
    await page.getByRole('button', { name: '下一页结果' }).click()
    await expect.poll(() => requests.length).toBe(old + 1)
    await expect(page.locator('.subagent-result-reader')).toHaveAttribute('aria-busy', 'false')
    const chunk = await text.textContent() ?? ''
    expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(16384)
    expect(chunk).not.toContain('�')
    assembled += chunk
    expect(await text.count()).toBe(1)
  }
  expect(assembled).toBe(body)
  await expect(text).toContainText('RESULT_FINAL_TAIL')
  await page.getByRole('button', { name: '上一页结果' }).click()
  await expect(text).not.toContainText('RESULT_FINAL_TAIL')
  await page.getByRole('button', { name: '从头读取结果' }).click()
  await expect(text).toHaveText(first)
  expect(await page.locator('.subagent-result-reader').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '返回预览' }).click()
  await expect(text).toHaveCount(0)
  await expect(page.locator('[data-preview]')).toBeVisible()
  await expect(page.getByText('当前仅显示结果预览，完整内容已单独保存。')).toBeVisible()
})

test('foreign response shows an error and retains the preview; retry uses the owned run', async () => {
  await render(); badIdentity = true
  await page.getByRole('button', { name: '读取完整结果' }).click()
  await expect(page.getByRole('alert')).toContainText('分页协议无效')
  await expect(page.locator('[data-preview]')).toBeVisible()
  await expect(page.locator('.subagent-result-reader__text')).toHaveCount(0)
  badIdentity = false
  await page.getByRole('button', { name: '读取完整结果' }).click()
  await expect(page.locator('.subagent-result-reader__text')).toContainText('开头：结果原文')
})

test('offline and old summaries never fetch; connection changes discard in-flight results', async () => {
  await render({}, false)
  await expect(page.getByRole('button', { name: '读取完整结果' })).toBeDisabled()
  expect(requests).toEqual([])
  await render({ resultRef: undefined, resultHash: undefined, resultBytes: undefined, resultTruncated: undefined, resultKind: undefined })
  await expect(page.getByText('此记录未保存结果完整性信息。')).toBeVisible()
  await expect(page.getByRole('button', { name: '读取完整结果' })).toHaveCount(0)
  await render(); deferred = true
  await page.getByRole('button', { name: '读取完整结果' }).click()
  await expect.poll(() => requests.length).toBe(1)
  await expect(page.locator('.subagent-result-reader')).toHaveAttribute('aria-busy', 'true')
  await page.evaluate(() => (window as unknown as { setFixtureSource: (source: string) => void }).setFixtureSource('changed'))
  delayed?.(); delayed = undefined
  await render()
  await expect(page.locator('[data-preview]')).toBeVisible()
  await expect(page.locator('.subagent-result-reader__text')).toHaveCount(0)
  await expect(page.locator('.subagent-result-reader')).toHaveAttribute('aria-busy', 'false')
})
