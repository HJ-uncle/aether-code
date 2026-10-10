/** Real Electron: user-message folding uses rendered height, preserves source text,
 * remains keyboard accessible, and reacts to the actual resizable chat panel.
 * History enters through the production remote snapshot API, without injected DOM. */
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'
import type { EngineHistoryRow } from '../src/renderer/src/core/engine/chat-history'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'
import { buildMentionMessage } from '../src/renderer/src/contrib/chat/mention-context'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const token = 'user-message-collapse-token'
const sessionId = 'user-message-collapse-session'
const longContent = [
  'LONG_MESSAGE_START：请保留下面的完整要求。',
  '',
  '# Markdown 标题仍作为用户原文显示',
  '**加粗标记** 与 `inline code` 不应因为折叠而丢失。',
  '```typescript',
  'const example = "ORIGINAL_CODE"',
  '```',
  ...Array.from({ length: 18 }, (_, index) => `${index + 1}. 检查功能 ${index + 1}，保留中英文原文。`),
  'LONG_MESSAGE_END：这是最后一条要求。'
].join('\n')
// Enough text to exceed eight wrapped lines in a 280px panel, but to fit in an 800px panel.
const wrappedContent = 'Responsive user message '.repeat(24).trim()
const shortContent = '简短消息：请检查这个按钮。'
const hiddenReference = Array.from({ length: 160 }, (_, index) => `INTERNAL_REFERENCE_${index}: ${'snapshot'.repeat(12)}`).join('\n')
const mentionContent = buildMentionMessage('请检查 @src/large.ts 的实现。', [{
  source: 'file', displayText: 'large.ts', path: 'src/large.ts', content: hiddenReference
}])
const urlContent = `请查看这个链接：https://example.test/${'long-path-segment/'.repeat(45)}end`
const history: EngineHistoryRow[] = [
  { id: 'long', role: 'user', content: longContent, conversationId: 'turn-long', metadata: { attachments: [{ name: '.ae/uploads/requirements.txt', type: 'text/plain', size: 128 }] } },
  { id: 'answer-long', role: 'assistant', content: '已收到完整要求。', conversationId: 'turn-long' },
  { id: 'short', role: 'user', content: shortContent, conversationId: 'turn-short' },
  { id: 'answer-short', role: 'assistant', content: '简短消息回复。', conversationId: 'turn-short' },
  { id: 'wrapped', role: 'user', content: wrappedContent, conversationId: 'turn-wrapped' },
  { id: 'answer-wrapped', role: 'assistant', content: '换行长度回复。', conversationId: 'turn-wrapped' },
  { id: 'mention', role: 'user', content: mentionContent, conversationId: 'turn-mention' },
  { id: 'answer-mention', role: 'assistant', content: '引用消息回复。', conversationId: 'turn-mention' },
  { id: 'url', role: 'user', content: urlContent, conversationId: 'turn-url' },
  { id: 'answer-url', role: 'assistant', content: '链接消息回复。', conversationId: 'turn-url' }
]
const snapshot: ChatRecoverySnapshot = {
  schemaVersion: 1, source: 'persisted', sessionId, eventId: null, finished: true,
  projection: [], runs: [], history, todos: [], changes: [], commandJobs: []
}
let fixture = ''
let server: Server | undefined
let app: ElectronApplication | undefined
let page: Page
const errors: string[] = []

function envelope(data: unknown): string { return JSON.stringify({ code: 200, message: 'ok', data }) }
function message(id: string): Locator { return page.locator(`.message--user[data-message-id="${id}"]`) }
function content(id: string): Locator { return message(id).locator('.message__bubble-content') }
function toggle(id: string): Locator { return message(id).locator('.message__collapse-toggle') }

async function metrics(id: string): Promise<{ height: number; fullHeight: number; lineHeight: number }> {
  return content(id).evaluate(element => ({
    height: element.getBoundingClientRect().height,
    fullHeight: element.scrollHeight,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight)
  }))
}

async function expectCollapsed(id: string): Promise<void> {
  await expect(toggle(id)).toHaveText('显示更多')
  await expect(toggle(id)).toHaveAttribute('aria-expanded', 'false')
  await expect(content(id)).toHaveClass(/is-collapsed/)
  await expect.poll(async () => {
    const box = await metrics(id)
    return Math.abs(box.height - box.lineHeight * 8)
  }, { message: '收起的用户正文应保留八行可读预览' }).toBeLessThanOrEqual(2)
  const box = await metrics(id)
  expect(box.fullHeight - box.height, '长正文应有实际被收起的内容').toBeGreaterThan(box.lineHeight)
}

async function expectExpanded(id: string): Promise<void> {
  await expect(toggle(id)).toHaveText('收起')
  await expect(toggle(id)).toHaveAttribute('aria-expanded', 'true')
  await expect(content(id)).not.toHaveClass(/is-collapsed/)
  await expect.poll(async () => {
    const box = await metrics(id)
    return Math.abs(box.height - box.fullHeight)
  }, { message: '展开应显示完整正文，不能仍被限高裁切' }).toBeLessThanOrEqual(2)
}

async function resizePanel(width: number): Promise<void> {
  const panel = page.locator('.workbench__chat')
  const currentWidth = await panel.evaluate(element => element.getBoundingClientRect().width)
  const separator = page.getByRole('separator', { name: '调整对话面板宽度', exact: true })
  const box = await separator.boundingBox()
  if (!box) throw new Error('Missing actual chat panel resizer')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + currentWidth - width, y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => Math.abs(await panel.evaluate(element => element.getBoundingClientRect().width) - width))
    .toBeLessThanOrEqual(1)
}

async function expectNoHorizontalOverflow(id: string): Promise<void> {
  const geometry = await message(id).evaluate(element => {
    const bubble = element.querySelector('.message__bubble')
    const body = element.querySelector('.message__bubble-content')
    if (!(bubble instanceof HTMLElement) || !(body instanceof HTMLElement)) throw new Error('Missing user bubble geometry')
    const bounds = element.getBoundingClientRect()
    const box = bubble.getBoundingClientRect()
    return { outside: Math.max(bounds.left - box.left, box.right - bounds.right, 0), bubbleOverflow: bubble.scrollWidth - bubble.clientWidth, bodyOverflow: body.scrollWidth - body.clientWidth }
  })
  expect(geometry.outside, '用户气泡应完整留在消息区内').toBeLessThanOrEqual(1)
  expect(geometry.bubbleOverflow, '气泡不应横向滚动').toBeLessThanOrEqual(1)
  expect(geometry.bodyOverflow, '长链接和正文应在气泡内部换行').toBeLessThanOrEqual(1)
}

test.describe.serial('用户长消息默认收起与完整原文', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'user-message-collapse-ui-'))
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) {
        response.writeHead(401).end(envelope(null)); return
      }
      const data = path === '/health' ? { status: 'ok' }
        : path === '/meta' ? { version: '1.0.0', buildId: `sha256:${'c'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['code'], subagentSchemaVersion: 1, instanceId: 'user-message-collapse-fixture' }
        : path === '/api/v1/chat/snapshot' ? snapshot
        : path === '/api/v1/conversation/history' ? history
        : path === '/api/v1/chat/runs' ? { runs: [] }
        : path === '/api/v1/workspace/directory' ? { root: '/remote/user-message-collapse', entries: [] }
        : []
      response.end(envelope(data))
    })
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done) })
    const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({
      engineMode: 'remote', remoteBaseUrl: remoteUrl, remoteWorkspaceRoot: '', autoStartEngine: true,
      lastFolder: '', lastSessionId: sessionId, appearance: 'dark', thinkingMode: 'off'
    }))
    app = await electron.launch({
      args: ['.', `--user-data-dir=${fixture}`], cwd: root,
      env: { ...process.env, AETHER_IDE_REMOTE_INSTANCE_TOKEN: token, AETHER_GLOBAL_DIR: join(fixture, 'global'), WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills'), ENABLE_LONG_TERM_MEMORY: 'false' }
    })
    page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 900))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    const selectionKey = sessionStorageKey('aether:lastSessionId', engineStorageKey({ mode: 'remote', baseUrl: remoteUrl }))
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key) ?? '', selectionKey)).not.toBe('')
    await page.evaluate(({ key, id }) => {
      localStorage.setItem(key, id)
      const layout = JSON.parse(localStorage.getItem('aether.ide.layout') ?? '{}') as Record<string, unknown>
      localStorage.setItem('aether.ide.layout', JSON.stringify({ ...layout, chatPanelVisible: true, chatPanelWidth: 380, chatOnLeft: false, sidebarVisible: false, panelVisible: false }))
    }, { key: selectionKey, id: sessionId })
    await page.reload()
    await expect(page.locator('.message--user')).toHaveCount(5)
    await expect(content('long')).toContainText('LONG_MESSAGE_END')
  })

  test.afterAll(async () => {
    await app?.close()
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())) }
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== fixtureRoot || !basename(absolute).startsWith('user-message-collapse-ui-')) throw new Error('Unsafe user-message fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('多行长消息默认显示八行，展开与收起保留全部换行和 Markdown 原文', async ({}, testInfo) => {
    await message('long').scrollIntoViewIfNeeded()
    await expectCollapsed('long')
    expect(await content('long').textContent()).toBe(longContent)
    await expect(content('long').locator('pre, code, h1, strong')).toHaveCount(0)
    const controls = await toggle('long').getAttribute('aria-controls')
    expect(controls).toBe(await content('long').getAttribute('id'))
    expect(await page.locator(`[id="${controls}"]`).count()).toBe(1)
    const screenshot = testInfo.outputPath('user-message-collapsed-dark.png')
    await message('long').screenshot({ path: screenshot })
    await testInfo.attach('用户长消息收起预览', { path: screenshot, contentType: 'image/png' })

    await toggle('long').click()
    await expectExpanded('long')
    expect(await content('long').textContent()).toBe(longContent)
    const finalLineVisible = await content('long').evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let tail: Text | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes('LONG_MESSAGE_END')) tail = node as Text
      }
      if (!tail) throw new Error('Missing final source text')
      const range = document.createRange()
      const offset = tail.textContent!.indexOf('LONG_MESSAGE_END')
      range.setStart(tail, offset); range.setEnd(tail, tail.textContent!.length)
      return range.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1
    })
    expect(finalLineVisible, '展开后的最后一条要求应落在正文容器内部').toBe(true)
    await toggle('long').click()
    await expectCollapsed('long')
    expect(errors).toEqual([])
  })

  test('收起按钮支持 Space 与 Enter，收起时复制仍包含完整原文', async () => {
    await toggle('long').scrollIntoViewIfNeeded()
    await toggle('long').focus()
    await page.keyboard.press('Space')
    await expectExpanded('long')
    await expect(toggle('long')).toBeFocused()
    await page.keyboard.press('Enter')
    await expectCollapsed('long')
    await expect(toggle('long')).toBeFocused()
    await message('long').hover()
    await message('long').getByRole('button', { name: '复制', exact: true }).click()
    // Windows 原生剪贴板会把 LF 规范成 CRLF，正文仍须逐字保留完整原文。
    await expect.poll(async () => (await app!.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')).toContain(longContent)
    expect(errors).toEqual([])
  })

  test('短消息不显示折叠控件，大引用快照只渲染 chip，附件一直在折叠正文之外', async () => {
    await message('short').scrollIntoViewIfNeeded()
    await expect(toggle('short')).toHaveCount(0)
    expect(await content('short').textContent()).toBe(shortContent)
    const short = await metrics('short')
    expect(Math.abs(short.height - short.fullHeight)).toBeLessThanOrEqual(2)
    await message('mention').scrollIntoViewIfNeeded()
    await expect(message('mention').locator('.mention-chip--file')).toHaveText('large.ts')
    await expect(toggle('mention')).toHaveCount(0)
    await expect(content('mention')).not.toContainText('INTERNAL_REFERENCE_')
    await expect(content('mention')).not.toContainText('<reference')
    await expect(content('mention')).toHaveText('请检查 large.ts 的实现。')

    const attachment = message('long').locator('.message__attachments .attach-chip')
    await attachment.scrollIntoViewIfNeeded()
    await expect(attachment).toBeVisible()
    await expect(attachment).toContainText('requirements.txt')
    expect(await attachment.evaluate(element => element.closest('.message__bubble') === null)).toBe(true)
    await expectCollapsed('long')
    await toggle('long').click()
    await attachment.scrollIntoViewIfNeeded()
    await expect(attachment).toBeVisible()
    await toggle('long').click()
    await attachment.scrollIntoViewIfNeeded()
    await expect(attachment).toBeVisible()
    expect(errors).toEqual([])
  })

  test('拖动真实面板宽度后重新判断折叠阈值，深浅主题下长链接与气泡不横向溢出', async () => {
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(appearance => window.aether.settings.update({ appearance }), appearance)
      // IPC 设置更新只写主进程；重载让 AppProvider 读取真实主题，不直接修改 DOM。
      await page.reload()
      await expect(page.locator('.message--user')).toHaveCount(5)
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      await resizePanel(280)
      await message('wrapped').scrollIntoViewIfNeeded()
      await expectCollapsed('wrapped')
      await expectNoHorizontalOverflow('wrapped')
      await message('url').scrollIntoViewIfNeeded()
      await expectCollapsed('url')
      await expectNoHorizontalOverflow('url')
      expect(await content('url').textContent()).toBe(urlContent)
      await resizePanel(800)
      await message('wrapped').scrollIntoViewIfNeeded()
      await expect(toggle('wrapped')).toHaveCount(0)
      const wide = await metrics('wrapped')
      expect(Math.abs(wide.height - wide.fullHeight), '放宽后可完整阅读，无需额外折叠按钮').toBeLessThanOrEqual(2)
      await expectNoHorizontalOverflow('wrapped')
      await message('url').scrollIntoViewIfNeeded()
      await expectNoHorizontalOverflow('url')
      await resizePanel(280)
      await message('wrapped').scrollIntoViewIfNeeded()
      await expectCollapsed('wrapped')
    }
    await resizePanel(380)
    expect(errors).toEqual([])
  })

  test('刷新后长消息默认重新收起，完整正文与附件均恢复', async () => {
    await toggle('long').click()
    await expectExpanded('long')
    await page.reload()
    await expect(page.locator('.message--user')).toHaveCount(5)
    await message('long').scrollIntoViewIfNeeded()
    await expectCollapsed('long')
    expect(await content('long').textContent()).toBe(longContent)
    await expect(message('long').locator('.message__attachments')).toContainText('requirements.txt')
    expect(errors).toEqual([])
  })
})
