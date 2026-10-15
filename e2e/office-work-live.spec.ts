/** Fresh full-chain office acceptance: isolated DB model + controlled OpenAI
 * peer, real sibling engine agent loop/tools, real Electron Work and binary
 * save IPC. The model responses are deterministic; no paid model is exercised. */
import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'

interface ModelMessage { role: string; content?: string | unknown[]; tool_calls?: { function?: { name?: string; arguments?: string } }[] }
interface ModelRequest { messages?: ModelMessage[]; tools?: { function?: { name?: string } }[] }

test('Work 通过办公 skill 真实生成和编辑 Word/Excel，成果展示与原文件下载一致', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const root = resolve(__dirname, '..'), engine = resolve(root, '..', 'ai-agent-engine'), parent = join(root, '.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'office-work-live-'))
  const requests: ModelRequest[] = []
  const errors: string[] = []
  const receipts: { path?: string; expectedHash?: string; content?: string; warnings?: string[] }[] = []
  const downloaded: Record<string, { path: string; sha256: string }> = {}
  let step = 0
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''
      for await (const chunk of request) raw += chunk.toString()
      const body = JSON.parse(raw) as ModelRequest
      requests.push(body)
      const lastTool = [...(body.messages ?? [])].reverse().find(message => message.role === 'tool')
      let receipt: { path?: string; expectedHash?: string; content?: string; warnings?: string[] } = {}
      if (typeof lastTool?.content === 'string') {
        try { receipt = JSON.parse(lastTool.content) as typeof receipt; if (receipt.path) receipts.push(receipt) } catch { /* get_skill returns Markdown */ }
      }
      const version = typeof lastTool?.content === 'string' ? lastTool.content.match(/sha256:[a-f0-9]{64}/)?.[0] : undefined
      let name = 'get_skill', args: Record<string, unknown> = { name: 'aether-office' }
      const docx = '成果/中文周报.docx', xlsx = '成果/项目预算.xlsx'
      switch (step) {
        case 1: args = { name: 'aether-office', resource: 'references/documents.md' }; break
        case 2: name = 'office_document'; args = { operation: 'create', path: docx, expectedHash: 'missing',
          markdown: '# Aether 办公验收周报\n\n## 本期概要\n完成办公产物链路验证。原始预算为 1000 元。\n\n## 重点进展\n- **文档**：中文标题、列表与表格。\n- **交付**：真实文件与版本校验。\n\n| 项目 | 状态 |\n| --- | --- |\n| 文档生成 | 已完成 |\n| 预算校验 | 进行中 |\n\n## 下期计划\n继续核对交付质量。' }; break
        case 3: name = 'office_document'; args = { operation: 'inspect', path: docx }; break
        case 4: name = 'office_document'; args = { operation: 'edit', path: docx, expectedHash: version,
          edits: [{ oldText: '原始预算为 1000 元。', newText: '原始预算为 1200 元，已核对。' }] }; break
        case 5: args = { name: 'aether-office', resource: 'references/spreadsheets.md' }; break
        case 6: name = 'office_document'; args = { operation: 'create', path: xlsx, expectedHash: 'missing', workbook: { sheets: [{
          name: '项目预算', columns: [{ header: '项目编码', key: 'code', type: 'text' }, { header: '预算（元）', key: 'amount', type: 'number' },
            { header: '完成率', key: 'progress', type: 'percent' }, { header: '日期', key: 'date', type: 'date' }],
          rows: [{ code: '00123', amount: 1000, progress: 0.5, date: '2026-10-15' },
            { code: '00456', amount: 2000, progress: 0.25, date: '2026-10-16' },
            { code: '合计', amount: { formula: 'SUM(B2:B3)' } }]
        }] } }; break
        case 7: name = 'office_document'; args = { operation: 'inspect', path: xlsx }; break
        case 8: name = 'office_document'; args = { operation: 'edit', path: xlsx, expectedHash: version,
          edits: [{ sheet: '项目预算', cell: 'B2', value: 1200 }] }; break
        case 9: name = 'office_document'; args = { operation: 'inspect', path: xlsx }; break
      }
      const current = step++
      const delta = current <= 9 ? { role: 'assistant', tool_calls: [{ index: 0, id: `office-call-${current}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: 'OFFICE_ACCEPTANCE_COMPLETE：Word 与 Excel 已生成并核对，预算已更新至 1200 元。' }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (value: unknown): void => { response.write(`data: ${JSON.stringify(value)}\n\n`) }
      frame({ id: `office-response-${current}`, object: 'chat.completion.chunk', created: 1, model: 'office-contract-model',
        choices: [{ index: 0, delta, finish_reason: null }] })
      frame({ id: `office-response-${current}`, object: 'chat.completion.chunk', created: 1, model: 'office-contract-model',
        choices: [{ index: 0, delta: {}, finish_reason: current <= 9 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
      response.end('data: [DONE]\n\n')
    })().catch(error => { errors.push(String(error)); response.writeHead(500); response.end() })
  })
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const key = '34'.repeat(32)
  const secretDirectory = join(fixture, 'engine', 'secrets')
  mkdirSync(secretDirectory, { recursive: true })
  writeFileSync(join(secretDirectory, 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
  const seed = join(fixture, 'seed-office-model.mjs')
  writeFileSync(seed, `
import { writeFileSync } from 'node:fs';
const { initDb, closeDb } = await import(${JSON.stringify(pathToFileURL(join(engine, 'dist/storage/sqlite/db.js')).href)});
const { ModelsStore } = await import(${JSON.stringify(pathToFileURL(join(engine, 'dist/storage/sqlite/models.js')).href)});
await initDb();
const model = await new ModelsStore().createModel({ tenantId:'default', provider:'openai', modelId:'office-contract-model',
 apiKey:'office-contract-fake-key', baseUrl:${JSON.stringify(endpoint)}, displayName:'办公验收受控模型', isEnabled:true,
 capabilities:{ toolCalling:true, contextWindow:128000, maxOutputTokens:16000 } });
writeFileSync(${JSON.stringify(join(fixture, 'model-id.txt'))}, model.id);
await closeDb();
`)
  execFileSync(process.execPath, [seed], { cwd: engine, windowsHide: true, timeout: 30_000,
    env: { ...process.env, DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key } })
  const modelId = readFileSync(join(fixture, 'model-id.txt'), 'utf8')
  writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', autoStartEngine: true,
    preferredPort: 12431, lastFolder: '', lastModelId: modelId, appearance: 'light' }))
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global'),
    AETHER_IDE_ENGINE_ENTRY: join(engine, 'dist', 'main.js'), WORKSPACE_ROOT: join(fixture, 'workspaces'),
    ENABLE_LONG_TERM_MEMORY: 'false', OSM_MODE: 'off' }
  delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
    const page: Page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1560, 1000))
    await expect.poll(() => page.evaluate(() => window.aether.engine.getSnapshot()).then(snapshot => snapshot.phase), { timeout: 90_000 }).toBe('ready')
    // Exercise the actual preload/main boundary before the positive save flow.
    const rejected = await page.evaluate(async () => {
      const snapshot = await window.aether.engine.getSnapshot()
      const input = { expectedEngine: snapshot, sessionId: 'office-contract-test', path: '周报.docx', workspaceRoot: 'office-contract-root' }
      const failure = async (value: typeof input): Promise<string> => {
        try { await window.aether.engine.saveWorkspaceFile(value); return 'unexpected-success' }
        catch (error) { return String(error) }
      }
      return { traversal: await failure({ ...input, path: '../outside.docx' }),
        stale: await failure({ ...input, expectedEngine: { ...snapshot, instanceId: 'obsolete-office-engine' } }) }
    })
    expect(rejected.traversal).toContain('成果下载参数无效')
    expect(rejected.stale).toContain('引擎连接已经切换')
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }) })
    const canceled = await page.evaluate(async () => window.aether.engine.saveWorkspaceFile({
      expectedEngine: await window.aether.engine.getSnapshot(), sessionId: 'office-contract-test', path: '周报.docx', workspaceRoot: 'office-contract-root' }))
    expect(canceled).toEqual({ saved: false })
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    const work = page.locator('.work-view')
    await work.getByRole('textbox', { name: '任务目标', exact: true }).fill('OFFICE_ACCEPTANCE：生成一份中文周报和项目预算表，预算更新为1200元，保留编码00123。')
    await work.getByRole('button', { name: '开始任务', exact: true }).click()
    await expect(work.getByRole('region', { name: '协作对话', exact: true })).toContainText('OFFICE_ACCEPTANCE_COMPLETE', { timeout: 60_000 })
    await expect(work.locator('.work-task-heading')).toContainText('已完成')
    expect(requests[0].tools?.some(tool => tool.function?.name === 'office_document')).toBe(true)
    expect(requests.length).toBe(11)
    const results = requests.flatMap(request => (request.messages ?? []).filter(message => message.role === 'tool').flatMap(message => typeof message.content === 'string' ? [message.content] : []))
    expect(results.filter(result => /OFFICE_(?:FAILED|FORMAT_FAILED|VERSION_CONFLICT|INVALID_ARGUMENTS|RECORD_FAILED)/.test(result))).toEqual([])
    expect(results.some(result => result.includes('references/documents.md') || result.includes('文档写作'))).toBe(true)
    expect(receipts.some(receipt => receipt.content?.includes('00123'))).toBe(true)
    expect(receipts.some(receipt => receipt.content?.includes('3200'))).toBe(true)

    const workspaceButton = work.getByRole('button', { name: /^成果(?:\s+\d+)?$/ }).first()
    if (!(await work.getByRole('listbox', { name: '成果文件', exact: true }).isVisible())) await workspaceButton.click()
    const files = work.getByRole('listbox', { name: '成果文件', exact: true })
    await expect(files.getByRole('option').filter({ hasText: '中文周报.docx' }).first()).toBeVisible()
    await expect(files.getByRole('option').filter({ hasText: '项目预算.xlsx' }).first()).toBeVisible()
    for (const [file, savedName] of [['中文周报.docx', '办公验收周报.docx'], ['项目预算.xlsx', '办公验收预算.xlsx']]) {
      await files.getByRole('option').filter({ hasText: file }).first().click()
      const panel = work.getByRole('region', { name: '成果预览', exact: true })
      await expect(panel.getByRole('button', { name: '下载原文件', exact: true })).toBeEnabled()
      await expect(panel).toContainText('当前不提供原版式预览')
      await expect(panel.getByRole('alert')).toHaveCount(0)
      const output = testInfo.outputPath(savedName)
      mkdirSync(dirname(output), { recursive: true })
      await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }) }, output)
      await panel.getByRole('button', { name: '下载原文件', exact: true }).click()
      await expect.poll(() => { try { return readFileSync(output).subarray(0, 4).toString('hex') } catch { return '' } }).toBe('504b0304')
      const receipt = [...receipts].reverse().find(receipt => receipt.path?.endsWith(file))
      expect(receipt?.path).toBeTruthy()
      expect(readFileSync(output)).toEqual(readFileSync(receipt!.path!))
      downloaded[file] = { path: output, sha256: `sha256:${createHash('sha256').update(readFileSync(output)).digest('hex')}` }
      await panel.screenshot({ path: testInfo.outputPath(`${file}.light.png`) })
      await page.evaluate(() => { document.documentElement.dataset.appearance = 'dark' })
      await panel.screenshot({ path: testInfo.outputPath(`${file}.dark.png`) })
      await page.evaluate(() => { document.documentElement.dataset.appearance = 'light' })
    }
    // Reopen the downloaded files with independent readers, beyond the tool's
    // own inspection and beyond the ZIP magic bytes.
    const engineRequire = createRequire(join(engine, 'package.json'))
    const mammoth = engineRequire('mammoth') as { extractRawText(options: { buffer: Buffer }): Promise<{ value: string }> }
    const word = await mammoth.extractRawText({ buffer: readFileSync(downloaded['中文周报.docx'].path) })
    expect(word.value).toContain('原始预算为 1200 元，已核对。')
    expect(word.value).not.toContain('原始预算为 1000 元。')
    expect(word.value.match(/Aether 办公验收周报/g)).toHaveLength(1)
    const ExcelJS = engineRequire('exceljs') as { Workbook: new () => {
      xlsx: { load(buffer: Buffer): Promise<unknown> }
      getWorksheet(name: string): { getCell(address: string): { value: unknown } } | undefined
    } }
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(readFileSync(downloaded['项目预算.xlsx'].path))
    const sheet = book.getWorksheet('项目预算')
    expect(sheet?.getCell('A2').value).toBe('00123')
    expect(sheet?.getCell('B2').value).toBe(1200)
    expect(sheet?.getCell('B4').value).toEqual({ formula: 'SUM(B2:B3)', result: 3200 })
    expect(sheet?.getCell('C2').value).toBe(0.5)
    expect(sheet?.getCell('D2').value).toBeInstanceOf(Date)
    expect(errors).toEqual([])
    const evidence = JSON.stringify({ model: 'isolated DB controlled model', toolSteps: step, downloaded,
      independentRead: { docx: 'mammoth: revised Chinese text and single title', xlsx: 'ExcelJS: text code, number, percentage, date and recalculated SUM' },
      visualValidation: 'not-performed',
      receipts: receipts.map(receipt => ({ path: receipt.path, expectedHash: receipt.expectedHash, warnings: receipt.warnings })) }, null, 2)
    writeFileSync(testInfo.outputPath('office-chain-evidence.json'), evidence)
    await testInfo.attach('office-chain-evidence', { body: evidence, contentType: 'application/json' })
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    const target = resolve(fixture)
    if (dirname(target) !== parent || !basename(target).startsWith('office-work-live-')) throw new Error('Unsafe office fixture cleanup')
    rmSync(target, { recursive: true, force: true, maxRetries: 5 })
  }
})
