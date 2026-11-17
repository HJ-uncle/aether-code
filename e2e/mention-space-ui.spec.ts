/** Electron regression for intentional @/slash completion, atomic chips while editing
 * adjacent spaces, and committing Chinese IME text. Uses an isolated HTTP fixture
 * and never sends a model request, uploads a file, or runs the legacy composer suite. Build first. */
import { _electron as electron, expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { engineStorageKey, sessionStorageKey } from '../src/renderer/src/core/engine/source'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/mention-space')
const token = 'mention-space-fixture', sessionId = 'work-mention-space-session', modelId = 'mention-space-model'
const title = '@ 标签空格与输入法回归', workspace = '/remote/mention-space'
const errors: string[] = [], mutations: string[] = []
let app: ElectronApplication | undefined, page: Page, cdp: CDPSession, fixture = '', storageKey = ''
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1'), path = url.pathname
  const id = url.searchParams.get('sessionId') ?? ''
  response.setHeader('content-type', 'application/json')
  if (path.startsWith('/api/') && request.headers['x-aether-instance-token'] !== token) throw new Error(`Unauthenticated ${path}`)
  if (['/api/v1/workbench/clients', '/api/v1/browser/clients', '/api/v1/browser/hosts', '/api/v1/terminal/create', '/api/v1/lsp/request', '/api/v1/cron/capabilities'].includes(path)) {
    response.writeHead(404).end(envelope(null)); return
  }
  if (request.method !== 'GET' && !['/api/v1/workspace/bind', '/api/v1/chat/admission/receipt'].includes(path)) {
    mutations.push(`${request.method} ${path}`); throw new Error(`Editing references must not invoke ${path}`)
  }
  if (path === '/api/v1/chat/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: [DONE]\n\n'); return }
  const data = path === '/health' ? { status: 'ok' }
    : path === '/meta' ? { version: '2.0.0', buildId: `sha256:${'f'.repeat(64)}`, protocolVersion: 1, toolProfiles: ['general', 'code'], subagentSchemaVersion: 1, instanceId: token }
    : path === '/api/v1/models' ? [{ id: modelId, modelId, provider: 'openai', displayName: '引用回归模型', isEnabled: true, capabilities: { toolCalling: true } }]
    : path === '/api/v1/chat/snapshot' ? { schemaVersion: 1, sessionId: id, source: 'persisted', eventId: null, finished: true, history: [], projection: [], runs: [], subagentRuns: [], todos: [], changes: [], commandJobs: [] }
    : path === '/api/v1/chat/status' ? { running: false, finished: true, lastEventId: null }
    : path === '/api/v1/chat/runs' ? { runs: [] }
    : path === '/api/v1/conversation/display' ? { schemaVersion: 1, grouping: 'root', turns: [], messages: [], loadedTurnIds: [], revision: 'empty', mutationRevision: 'stable', backend: 'jsonl', completeness: 'complete' }
    : path === '/api/v1/chat/admission/context' ? { protocolVersion: 1, tenantId: token, sessionId: id, namespace: { id: token, generation: 'one' }, transport: { toolProfile: request.headers['x-aether-tool-profile'] === 'code' ? 'code' : 'general', runLifetime: 'durable', subagentProtocol: 2 }, root: null, predecessor: null }
    : path === '/api/v1/subagent/runs' ? { schemaVersion: 2, runs: [], listComplete: true, hasMore: false, revision: 'empty' }
    : path === '/api/v1/subagent/capabilities' ? { schemaVersion: 2, eventVersions: [1, 2], views: ['legacy', 'summary'], toolPagination: true, eventPagination: true, detailChunks: true, exactWatermarks: true }
    : path === '/api/v1/collaboration/capabilities' ? { protocolVersion: 1, userControllerMutation: false, rootUserControllerMutation: false }
    : /\/sessions\/[^/]+\/binding$/.test(path) ? { started: true, agentId: null, metadata: null, agent: null }
    : /\/sessions\/[^/]+\/toolkits$/.test(path) ? { toolkits: [] }
    : path === '/api/v1/toolkits' ? { toolkits: [{ id: 'plugin-management', name: '插件管理', description: '创建和管理插件', toolNames: ['plugin_create'], available: true }] }
    : path === '/api/v1/skills' ? { list: [{ id: 'fixture-review', name: '需求审查', description: '核对当前需求', enabled: true }] }
    : path === '/api/v1/security/mode' ? { mode: 'standard', sessionId: id }
    : path === '/api/v1/memory/settings' ? { memoryScope: 'off', effectiveScope: 'off', enabled: false, sessionId: id }
    : path === '/api/v1/workspace/directory' ? { root: workspace, entries: [], bindingEpoch: 'one' }
    : path === '/api/v1/workspace/bind' ? { workspaceRoot: workspace }
    : path === '/api/v1/codegraph/status' ? { initialized: false, indexing: false }
    : path === '/api/v1/command-jobs' ? { jobs: [] }
    : path === '/api/v1/plugins' ? { plugins: [] } : []
  response.end(envelope(data))
})().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) }) })

const editor = () => page.locator('.work-view .input-composer__input')
const chip = () => editor().locator('.mention-chip--toolkit')
interface SavedDraft { draft: string; mentions: Array<{ source: string; path?: string; textOffset?: number }>; resources?: { toolkits?: string[] } }
async function savedDraft(): Promise<SavedDraft> {
  return page.evaluate(({ key, id }) => {
    window.dispatchEvent(new Event('blur'))
    return JSON.parse(localStorage.getItem(key) ?? '{}').tasks?.find((task: { id: string }) => task.id === id)
  }, { key: storageKey, id: sessionId })
}
async function assertReference(): Promise<void> {
  await expect(chip()).toHaveCount(1)
  await expect(chip()).toHaveText('插件管理')
  await expect(chip()).toHaveAttribute('contenteditable', 'false')
  await expect(editor()).not.toContainText('@toolkit:')
  await expect.poll(async () => (await savedDraft()).mentions.filter(item => item.source === 'toolkit')).toHaveLength(1)
  const draft = await savedDraft(), mention = draft.mentions.find(item => item.source === 'toolkit')!
  expect(mention.path).toBe('plugin-management')
  expect(draft.draft.slice(mention.textOffset, (mention.textOffset ?? 0) + '@toolkit:plugin-management'.length)).toBe('@toolkit:plugin-management')
  expect(draft.resources?.toolkits).toEqual(['plugin-management'])
}
async function insertReference(): Promise<void> {
  await editor().fill('')
  await page.keyboard.insertText('@插件管理')
  const picker = page.locator('.mention-ref-picker:visible')
  const option = picker.locator('[data-toolkit-id="plugin-management"]')
  await expect(option).toBeVisible()
  await expect(option).not.toHaveAttribute('aria-disabled', 'true')
  await option.click()
  await expect(picker).toHaveCount(0)
  await expect(editor()).toBeFocused()
  await assertReference()
}
async function caretAtChip(side: 'before' | 'after'): Promise<void> {
  // Test both native element boundaries explicitly. These are the caret
  // positions Chromium also produces when users click beside an atomic chip.
  await chip().evaluate((element, side) => {
    (element.closest('[contenteditable="true"]') as HTMLElement).focus()
    const range = document.createRange()
    if (side === 'before') range.setStartBefore(element); else range.setStartAfter(element)
    range.collapse(true)
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
  }, side)
}

async function clickQueryEnd(): Promise<void> {
  const point = await editor().evaluate(element => {
    const node = element.lastChild
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent) throw new Error('Expected plain mention query')
    const range = document.createRange()
    range.setStart(node, node.textContent.length - 1); range.setEnd(node, node.textContent.length)
    const rect = range.getBoundingClientRect()
    return { x: rect.right + 3, y: rect.top + rect.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(editor()).toBeFocused()
}

async function expectCompletionClosed(): Promise<void> {
  // Native selectionchange is queued after pointer/keyboard dispatch. Observe
  // the next paint before asserting so an immediate absent DOM cannot pass.
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await expect(page.locator('.mention-ref-picker:visible, .resource-picker:visible')).toHaveCount(0)
}

test.describe.serial('@ 标签相邻编辑', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'profile-'))
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    storageKey = sessionStorageKey('aether.work.state.v1', engineStorageKey({ mode: 'remote', baseUrl: origin }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'remote', remoteBaseUrl: origin, autoStartEngine: true,
      remoteWorkspaceRoot: workspace, lastSessionId: '', lastFolder: '', lastModelId: modelId, appearance: 'dark', thinkingMode: 'off' }))
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
    for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_REMOTE_API_KEY', 'AETHER_IDE_REMOTE_BEARER_TOKEN', 'AETHER_IDE_REMOTE_AUTH_URL'].includes(key.toUpperCase())) delete env[key]
    env.AETHER_IDE_REMOTE_INSTANCE_TOKEN = token; env.AETHER_GLOBAL_DIR = join(fixture, 'global')
    app = await electron.launch({ args: [process.env.AETHER_E2E_APP_ENTRY || join(root, 'out/main/index.js'), `--user-data-dir=${fixture}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); page.on('crash', () => errors.push('Renderer crashed'))
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 900); window.show(); window.focus() })
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await page.evaluate(({ key, sessionId, title, workspace, modelId }) => {
      const now = Date.now()
      localStorage.setItem(key, JSON.stringify({ tasks: [{ id: sessionId, title, status: 'draft', draft: '', mentions: [], createdAt: now, updatedAt: now,
        workspacePath: workspace, modelId, attachments: [], sources: [], resources: { toolkits: [], skills: [], mcpServers: [], knowledgeBases: [] } }], activeTaskId: sessionId }))
      localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: false, tab: 'files', pane: 'conversation', ratio: 50 }))
    }, { key: storageKey, sessionId, title, workspace, modelId })
    await page.reload(); await expect(page.locator('.status-bar')).toContainText('引擎：就绪')
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
    cdp = await page.context().newCDPSession(page)
  })
  test.afterEach(async ({}, info) => {
    if (page && !page.isClosed()) {
      const capture = info.outputPath(info.status === info.expectedStatus ? 'mention-space.png' : 'mention-space-failure.png')
      await page.screenshot({ path: capture, animations: 'disabled' })
      await info.attach('输入框状态', { path: capture, contentType: 'image/png' })
      await info.attach('draft-and-dom', { body: JSON.stringify({ draft: await savedDraft(), html: await editor().innerHTML() }, null, 2), contentType: 'application/json' })
    }
    expect(errors).toEqual([]); expect(mutations).toEqual([])
  })
  test.afterAll(async () => {
    try { await app?.close() } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
      if (fixture) {
        const target = resolve(fixture)
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith('profile-')) throw new Error(`Unsafe fixture cleanup: ${target}`)
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })

  for (const { trigger, keyword, selector, source, id } of [
    { trigger: '@', keyword: '插件管理', selector: '.mention-ref-picker', source: 'toolkit', id: 'plugin-management' },
    { trigger: '/', keyword: '需求审查', selector: '.resource-picker', source: 'skill', id: 'fixture-review' }
  ]) {
    test(`${trigger} 关闭后输入和移动光标不复活，只有新触发符开启补全`, async () => {
      await editor().fill('')
      await page.keyboard.insertText(trigger)
      const picker = page.locator(`${selector}:visible`)
      const option = picker.getByRole('option').filter({ hasText: keyword })
      await expect(option).toBeVisible()
      await page.keyboard.insertText(keyword.slice(0, 2)); await expect(option).toBeVisible()
      await page.keyboard.press('Escape'); await expectCompletionClosed()
      await page.keyboard.insertText(keyword.slice(2)); await expectCompletionClosed()
      await page.keyboard.press('Home'); await clickQueryEnd(); await expectCompletionClosed()
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight')
      await page.keyboard.insertText('X'); await expectCompletionClosed()
      for (let index = 0; index < keyword.length + 1; index++) await page.keyboard.press('Backspace')
      await expect(editor()).toHaveText(trigger); await expectCompletionClosed()

      // Deleting the old delimiter and typing a new one is a fresh request,
      // even though the resulting draft text is identical.
      await page.keyboard.press('Backspace'); await page.keyboard.insertText(trigger)
      await expect(option).toBeVisible()
      await clickQueryEnd(); await expectCompletionClosed()
      await page.keyboard.insertText(keyword); await expectCompletionClosed()
      await page.keyboard.insertText(` ${trigger}`); await expect(option).toBeVisible()
      await page.keyboard.insertText(keyword); await expect(option).toBeVisible()
      await page.keyboard.press('ArrowLeft'); await expectCompletionClosed()
      await page.keyboard.press('ArrowRight'); await page.keyboard.insertText('X'); await expectCompletionClosed()

      await page.keyboard.insertText(` ${trigger}${keyword}`); await expect(option).toBeVisible()
      await page.getByRole('heading', { name: title, exact: true }).click(); await expectCompletionClosed()
      await clickQueryEnd(); await page.keyboard.insertText('X'); await expectCompletionClosed()
      await page.keyboard.insertText(` ${trigger}${keyword}`); await expect(option).toBeVisible()
      await expect(option).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Tab'); await expectCompletionClosed()
      const reference = editor().locator(`.mention-chip--${source}`)
      await expect(reference).toHaveCount(1); await expect(reference).toHaveText(keyword)
      expect((await savedDraft()).mentions.filter(mention => mention.source === source).map(mention => mention.path)).toEqual([id])
      await reference.click(); await expectCompletionClosed()
    })

    test(`${trigger} 关闭后中文输入法不重开，新查询的中文补全仍正常`, async () => {
      await editor().fill('')
      await page.keyboard.insertText(trigger)
      const option = page.locator(`${selector}:visible`).getByRole('option').filter({ hasText: keyword })
      await expect(option).toBeVisible()
      await page.keyboard.press('Escape'); await expectCompletionClosed()
      await cdp.send('Input.imeSetComposition', { text: keyword, selectionStart: keyword.length, selectionEnd: keyword.length })
      await expectCompletionClosed()
      await cdp.send('Input.insertText', { text: keyword }); await expectCompletionClosed()
      await expect(editor()).toHaveText(`${trigger}${keyword}`)

      await page.keyboard.insertText(` ${trigger}`); await expect(option).toBeVisible()
      await cdp.send('Input.imeSetComposition', { text: keyword, selectionStart: keyword.length, selectionEnd: keyword.length })
      await expectCompletionClosed()
      await cdp.send('Input.insertText', { text: keyword })
      await expect(option).toBeVisible()
      await option.click(); await expectCompletionClosed()
      await expect(editor().locator(`.mention-chip--${source}`)).toHaveText(keyword)
      expect((await savedDraft()).mentions.filter(mention => mention.source === source).map(mention => mention.path)).toEqual([id])
    })
  }

  test('插件管理标签前后输入空格、中文并移动光标，显示与草稿引用一致', async () => {
    await insertReference()
    await page.keyboard.insertText('在当前项目里继续工作')
    for (const side of ['after', 'before'] as const) {
      await caretAtChip(side)
      await page.keyboard.type('   ')
      await assertReference()
      await page.keyboard.insertText(side === 'after' ? '后续要求' : '前置说明')
      await assertReference()
    }
    await editor().focus()
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight', 'Control+Home', 'Control+End']) {
      await page.keyboard.press(key); await page.keyboard.press('Space'); await assertReference()
    }
    const beforeReload = await savedDraft()
    await page.reload(); await expect(editor()).toBeVisible(); await assertReference()
    expect((await savedDraft()).draft).toBe(beforeReload.draft)
    expect((await savedDraft()).mentions).toEqual(beforeReload.mentions)
  })

  test('中文组合输入提交及取消后紧接空格，标签和已提交正文均保留', async () => {
    await insertReference()
    await page.keyboard.insertText('在当前项目 ')
    for (const [index, text] of ['生成插件', '继续优化'].entries()) {
      await caretAtChip(index === 0 ? 'after' : 'before')
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
      // Persisting a draft publishes owner state while the IME owns the DOM.
      // It must not flatten the chip or replace the in-progress composition.
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await cdp.send('Input.insertText', { text })
      await page.keyboard.press('Space')
      await assertReference()
      await expect(editor()).toContainText(text)
    }
    await editor().focus(); await page.keyboard.press('Control+End')
    const committed = await savedDraft()
    await cdp.send('Input.imeSetComposition', { text: '不保留候选', selectionStart: 5, selectionEnd: 5 })
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await page.keyboard.press('Space')
    await assertReference()
    expect((await savedDraft()).draft.replace(/\s+$/, '')).toBe(committed.draft.replace(/\s+$/, ''))
    await expect(editor()).not.toContainText('不保留候选')
  })

  test('同帧原生输入与 IME 提交紧接空格，不让延迟草稿回声拆掉标签', async () => {
    await insertReference()
    await page.keyboard.insertText('在当前项目 ')
    await caretAtChip('after')
    const before = await savedDraft()
    const burst = await editor().evaluate(async element => {
      const inputTypes: string[] = []
      const observe = (event: Event): void => { if (event instanceof InputEvent) inputTypes.push(`${event.inputType}:${event.isTrusted}`) }
      element.addEventListener('input', observe)
      const parts = [' ', '空格', ' ', '@', '边界', ' ', '继续', ' ']
      const inserted: string[] = []
      try {
        await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()))
        // Separate protocol/keyboard calls yield whole browser tasks. Native
        // edits in one frame leave passive React echoes pending between edits.
        for (const part of parts) {
          if (!document.execCommand('insertText', false, part)) throw new Error('Native text insertion is unavailable')
          inserted.push(part)
          await Promise.resolve()
        }
        return { inputTypes, inserted: inserted.join('') }
      } finally { element.removeEventListener('input', observe) }
    })
    expect(burst.inputTypes.filter(type => type === 'insertText:true')).toHaveLength(8)
    await assertReference()
    const after = await savedDraft()
    const token = '@toolkit:plugin-management'
    const insertionAt = before.mentions[0].textOffset! + token.length
    expect(after.draft.replace(/\u00a0/g, ' ')).toBe(
      (before.draft.slice(0, insertionAt) + burst.inserted + before.draft.slice(insertionAt)).replace(/\u00a0/g, ' '))

    await editor().focus(); await page.keyboard.press('Control+End')
    await editor().evaluate(element => {
      element.addEventListener('compositionend', () => {
        // Queue before React handles the same compositionend; the following
        // native edit runs before a later renderer task can drain stale effects.
        queueMicrotask(() => { document.execCommand('insertText', false, ' ') })
      }, { once: true, capture: true })
    })
    await cdp.send('Input.imeSetComposition', { text: '候选确认', selectionStart: 4, selectionEnd: 4 })
    await cdp.send('Input.insertText', { text: '候选确认' })
    await assertReference()
    expect((await savedDraft()).draft.replace(/\u00a0/g, ' ')).toBe(`${after.draft.replace(/\u00a0/g, ' ')}候选确认 `)
  })

  test('空格编辑后的标签可撤销恢复，手工输入同名 token 不获得引用身份', async () => {
    await insertReference()
    await page.keyboard.press('Space')
    await assertReference()
    const beforeDelete = await savedDraft()
    await chip().focus(); await page.keyboard.press('Delete')
    await expect(chip()).toHaveCount(0)
    await expect.poll(async () => (await savedDraft()).mentions).toEqual([])
    await expect.poll(async () => (await savedDraft()).resources?.toolkits).toEqual([])

    await editor().focus(); await page.keyboard.press('Control+z')
    await assertReference()
    expect((await savedDraft()).draft).toBe(beforeDelete.draft)
    expect((await savedDraft()).mentions).toEqual(beforeDelete.mentions)
    await page.keyboard.press('Control+y')
    await expect(chip()).toHaveCount(0)
    await expect.poll(async () => (await savedDraft()).mentions).toEqual([])
    await expect.poll(async () => (await savedDraft()).resources?.toolkits).toEqual([])

    await editor().fill('')
    await page.keyboard.insertText('@toolkit:plugin-management')
    await page.keyboard.press('Space')
    await expect(editor()).toContainText('@toolkit:plugin-management')
    await expect(editor().locator('.mention-chip')).toHaveCount(0)
    const plain = await savedDraft()
    expect(plain.draft.replace(/\u00a0/g, ' ')).toBe('@toolkit:plugin-management ')
    expect(plain.mentions).toEqual([])
    expect(plain.resources?.toolkits).toEqual([])
    await page.reload(); await expect(editor()).toBeVisible()
    await expect(editor().locator('.mention-chip')).toHaveCount(0)
    expect((await savedDraft()).mentions).toEqual([])
  })

  test('恢复的文件与 Agent 引用在两侧输入空格后仍保留各自身份', async () => {
    await savedDraft()
    const fileToken = '@src/example.ts', agentToken = '@fixture-agent'
    await page.evaluate(({ key, sessionId, fileToken, agentToken }) => {
      const state = JSON.parse(localStorage.getItem(key) ?? '{}')
      const task = state.tasks.find((item: { id: string }) => item.id === sessionId)
      task.draft = `${fileToken} ${agentToken} 在当前项目`
      task.mentions = [
        { source: 'file', origin: 'workspace', path: 'src/example.ts', displayText: 'example.ts', textOffset: 0 },
        { source: 'agent', path: 'fixture-agent', displayText: '测试 Agent', textOffset: fileToken.length + 1 }
      ]
      task.resources.toolkits = []
      localStorage.setItem(key, JSON.stringify(state))
    }, { key: storageKey, sessionId, fileToken, agentToken })
    await page.reload(); await expect(editor()).toBeVisible()
    for (const source of ['file', 'agent']) {
      const reference = editor().locator(`.mention-chip--${source}`)
      await expect(reference).toHaveCount(1)
      for (const side of ['before', 'after'] as const) {
        await reference.evaluate((element, side) => {
          (element.closest('[contenteditable="true"]') as HTMLElement).focus()
          const range = document.createRange()
          if (side === 'before') range.setStartBefore(element); else range.setStartAfter(element)
          range.collapse(true)
          const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
        }, side)
        await page.keyboard.press('Space')
        await expect(editor().locator('.mention-chip')).toHaveCount(2)
        await expect(editor()).not.toContainText(fileToken)
        await expect(editor()).not.toContainText(agentToken)
      }
    }
    const draft = await savedDraft()
    expect(draft.mentions.map(mention => [mention.source, mention.path])).toEqual([['file', 'src/example.ts'], ['agent', 'fixture-agent']])
    for (const [index, token] of [fileToken, agentToken].entries()) {
      const offset = draft.mentions[index].textOffset!
      expect(draft.draft.slice(offset, offset + token.length)).toBe(token)
    }
  })
})
