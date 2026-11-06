/** Pure Work presentation contracts: previews follow their own root run, browser
 * tools stay in the process, and standalone collaboration retains its receipts. */
import { expect, test } from '@playwright/test'
import type { RootRun } from '../src/shared/root-run'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { isWorkStandaloneTool, workMessageRunning, workToolChanges, workToolHasImages, workToolKind, workToolTechnicalFields } from '../src/renderer/src/contrib/work/work-tool-presentation'
import { readActivityPreview } from '../src/renderer/src/contrib/work/work-activity-presentation'
import { toolPresentation } from '../src/renderer/src/contrib/chat/tool-presentation'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII='
const tool = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'tool', name: 'read_file', args: '{"path":"report.md"}', result: 'Report contents', state: 'done', ...overrides
})
const run = (overrides: Partial<RootRun> = {}): RootRun => ({
  schemaVersion: 1, runId: 'run', sessionId: 'task', turnId: 'turn',
  userMessageId: 'user', assistantMessageId: 'assistant', version: 1, seq: 1,
  status: 'running', createdAt: 1, updatedAt: 1, pending: [], ...overrides
})

test('同一根运行的前段消息已完成，截图仍随根运行和等待应答保持展开默认值', () => {
  for (const status of ['running', 'waiting'] as const) {
    const current = run({ status })
    const segments: Array<Pick<ChatMessage, 'run' | 'status'>> = [
      { run: current, status: 'done' },
      { run: current, status: status === 'running' ? 'streaming' : 'waiting' }
    ]
    expect(segments.map(workMessageRunning)).toEqual([true, true])
  }
})

test('根运行的所有结束状态覆盖消息残留的流式或等待状态', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
    for (const messageStatus of ['streaming', 'waiting'] as const) {
      expect(workMessageRunning({ run: run({ status }), status: messageStatus }),
        `${status} root / ${messageStatus} segment`).toBe(false)
    }
  }
})

test('旧消息没有根运行时仅流式和等待应答视为进行中', () => {
  const expected: Record<ChatMessage['status'], boolean> = {
    streaming: true, waiting: true, done: false, error: false, aborted: false, interrupted: false
  }
  for (const [status, running] of Object.entries(expected)) {
    expect(workMessageRunning({ status: status as ChatMessage['status'] }), status).toBe(running)
  }
})

test('同任务的新轮次开始或结束不会重开旧轮次的截图', () => {
  const previous = { run: run({ runId: 'old-run', turnId: 'old-turn', status: 'succeeded' }), status: 'done' as const }
  const current = { run: run({ runId: 'new-run', turnId: 'new-turn' }), status: 'streaming' as const }
  expect([previous, current].map(workMessageRunning)).toEqual([false, true])
  const settled = { ...current, run: { ...current.run, status: 'succeeded' as const } }
  expect([previous, settled].map(workMessageRunning)).toEqual([false, false])
  const next = { run: run({ runId: 'next-run', turnId: 'next-turn', status: 'waiting' }), status: 'waiting' as const }
  expect([previous, settled, next].map(workMessageRunning)).toEqual([false, false, true])
})

test('浏览器操作和生成图片均归入过程，保留截图内容供展开查看', () => {
  const screenshot = tool({ name: 'browser_screenshot', result: JSON.stringify({ filename: 'preview.png', dataUrl: png }) })
  const snapshot = tool({ name: 'browser_snapshot', result: JSON.stringify({
    tab: { title: '验收页面', url: 'https://example.test' },
    text: '页面已就绪', elements: [{ role: 'heading', name: '页面已就绪' }], truncated: false
  }) })
  for (const receipt of [screenshot, tool({ name: 'image_generate', result: screenshot.result })]) {
    const original = receipt.result
    expect(workToolHasImages(receipt)).toBe(true)
    expect(workToolKind(receipt)).toBe('visual')
    expect(isWorkStandaloneTool(receipt)).toBe(false)
    expect(toolPresentation(receipt).images.map(image => image.src)).toEqual([png])
    expect(receipt.result).toBe(original)
    const encoded = { ...receipt, result: JSON.stringify(receipt.result) }
    expect(workToolKind(encoded)).toBe('visual')
    expect(isWorkStandaloneTool(encoded)).toBe(false)
    expect(toolPresentation(encoded).images.map(image => image.src)).toEqual([png])
  }
  const pageImage = JSON.stringify({ ...JSON.parse(snapshot.result), screenshot: { dataUrl: png, width: 1, height: 1 } })
  for (const name of ['browser_snapshot', 'browser_read', 'browser_navigate', 'browser_wait', 'browser_set_viewport', 'browser_resize', 'browser_click']) {
    for (const result of [screenshot.result, pageImage]) {
      const receipt = tool({ name, result })
      expect(workToolHasImages(receipt)).toBe(true)
      expect(workToolKind(receipt)).toBe('visual')
      expect(isWorkStandaloneTool(receipt)).toBe(false)
      const parsed = toolPresentation(receipt)
      const images = [...parsed.images.map(image => image.src), ...(parsed.browserSnapshots ?? []).flatMap(snapshot => snapshot.screenshot ? [snapshot.screenshot.dataUrl] : [])]
      expect(images).toEqual([png])
      expect(receipt.result).toBe(result)
    }
    expect(workToolKind({ ...snapshot, name })).toBe('compact')
    expect(workToolHasImages({ ...snapshot, name })).toBe(false)
    expect(isWorkStandaloneTool({ ...snapshot, name })).toBe(false)
  }
  expect(workToolKind({ ...snapshot, name: 'browser_screenshot' })).toBe('compact')
})

test('查看图片和 MCP 图片按实际像素识别，不依赖工具名称或包装层数', () => {
  const data = png.slice(png.indexOf(',') + 1)
  const receipts = [
    tool({ name: 'view_image', result: JSON.stringify({ image_url: png }) }),
    tool({ name: 'mcp__design__inspect', result: JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data }] }) }),
    tool({ name: 'custom_probe', result: JSON.stringify({ result: JSON.stringify({ content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }
    ] }) }) })
  ]
  for (const receipt of receipts) {
    expect(workToolHasImages(receipt), receipt.name).toBe(true)
    expect(toolPresentation(receipt).images.map(image => image.src)).toEqual([png])
  }
})

test('浏览器点击前截图可触发展开，纯文本快照和省略标记不会伪造图片', () => {
  const snapshot = {
    tab: { title: '点击后的页面', url: 'https://example.test/next' }, text: '已导航', elements: [], truncated: false
  }
  const interaction = {
    type: 'click', x: 0, y: 0, navigationId: 1, pageUrl: 'https://example.test',
    viewport: { width: 1, height: 1, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 }
  }
  const screenshot = { dataUrl: png, width: 1, height: 1 }
  const receipt = tool({ name: 'browser_click', result: JSON.stringify({ result: {
    ...snapshot, interaction: { ...interaction, screenshot }
  } }) })
  const parsed = toolPresentation(receipt)
  expect(parsed.images).toEqual([])
  expect(parsed.browserSnapshots?.[0].screenshot).toBeUndefined()
  expect(parsed.browserSnapshots?.[0].interaction?.screenshot?.dataUrl).toBe(png)
  expect(workToolHasImages(receipt)).toBe(true)
  const omitted = {
    retainedForDisplay: true, omittedFromStream: true, retainedInHistory: true,
    reason: 'stream-byte-budget', width: 1, height: 1
  }
  for (const result of [snapshot, { ...snapshot, screenshot: omitted }, {
    ...snapshot, interaction: { ...interaction, screenshot: omitted }
  }]) {
    const textOnly = tool({ name: 'browser_click', result: JSON.stringify(result) })
    expect(toolPresentation(textOnly).browserSnapshots).toHaveLength(1)
    expect(workToolHasImages(textOnly)).toBe(false)
  }
})

test('文件改动回执附带图片时保留图片判定，改动本身不会触发图片展开', () => {
  const change = {
    id: 'image-file', path: 'D:/project/preview.png', kind: 'write' as const,
    oldContent: null, newContent: '', truncated: false, status: 'pending' as const, createdAt: 1
  }
  for (const changes of [{ change }, { changes: [change] }]) {
    const receipt = tool({ name: 'image_generate', ...changes, result: JSON.stringify({ image_url: png }) })
    expect(workToolKind(receipt)).toBe('file-change')
    expect(workToolHasImages(receipt)).toBe(true)
    expect(workToolHasImages({ ...receipt, result: '图片已保存到 preview.png' })).toBe(false)
  }
})

test('普通 JSON、流式参数和无效图片不会被提升为视觉卡片', () => {
  for (const receipt of [
    tool(),
    tool({ args: '{"path":', state: 'running', result: '' }),
    tool({ name: 'office_inspect', result: '{"sheets":3,"cells":42}' }),
    tool({ name: 'browser_screenshot', result: '{"dataUrl":"data:image/png;base64,invalid"}' }),
    tool({ name: 'execute_cmd', result: '{"status":"running"}' })
  ]) {
    expect(workToolHasImages(receipt)).toBe(false)
    expect(workToolKind(receipt)).toBe('compact')
    expect(isWorkStandaloneTool(receipt)).toBe(false)
  }
})

test('后台命令凭持久任务数据使用命令卡片，不依赖工具名称或派发已完成状态', () => {
  const receipt = tool({ name: 'command_output', commandJob: {
    schemaVersion: 1, jobId: 'job', sessionId: 'task', ownerSessionId: 'task', version: 1,
    command: 'node', args: ['server.js'], cwd: 'D:/project', background: true, status: 'running',
    createdAt: 1, updatedAt: 2, cursor: 0, earliestCursor: 0, exitCode: null, signal: null
  } })
  expect(workToolKind(receipt)).toBe('command')
  expect(isWorkStandaloneTool(receipt)).toBe(true)
})

test('文件改动进入紧凑过程组，子代理仍独立，缺少文件回执不伪造改动', () => {
  const receipt = tool({ name: 'office_document', change: {
    id: 'change', path: 'D:/project/report.md', kind: 'write', oldContent: null, newContent: '# Report',
    truncated: false, status: 'pending', createdAt: 1
  } })
  expect(workToolKind(receipt)).toBe('file-change')
  expect(isWorkStandaloneTool(receipt)).toBe(false)
  expect(workToolKind({ ...receipt, change: undefined, changes: [receipt.change!] })).toBe('file-change')
  expect(workToolKind(tool({ name: 'subagent', state: 'running', result: '' }))).toBe('subagent')
  expect(isWorkStandaloneTool(tool({ name: 'subagent', state: 'running', result: '' }))).toBe(true)
  expect(workToolKind(tool({ name: 'write_file' }))).toBe('compact')
})

test('文件入口保留完整回执和最新状态，拒绝显式跨会话改动', () => {
  const first = { id: 'first', sessionId: 'work-a', path: 'first.md', kind: 'write' as const, oldContent: '', newContent: 'new', truncated: false, status: 'pending' as const, createdAt: 1 }
  const updated = { ...first, status: 'kept' as const }
  const legacy = { ...first, id: 'legacy', sessionId: undefined }
  const foreign = { ...first, id: 'foreign', sessionId: 'work-b' }
  const selected = workToolChanges({ change: first, changes: [updated, legacy, foreign] }, 'work-a')
  expect(selected).toEqual([updated, legacy])
  expect(workToolChanges({ change: updated, changes: [first] }, 'work-a')).toEqual([updated])
  const reverted = { ...first, status: 'reverted' as const }
  expect(workToolChanges({ change: reverted, changes: [first, { ...first, path: 'other.md' }] }, 'work-a')).toEqual([reverted])
  expect(workToolChanges({ change: first }, '')).toEqual([])
})

test('技术详情保留读取版本回执、原始参数和错误，正文转换不会改写原文', () => {
  const raw = '{\r\n  "path": "report.md", "expectedHash": "' + 'a'.repeat(64) + '", "startLine": 1, "endLine": 2, "totalLines": 2, "content": "A\\nB\\n"\r\n}'
  const original = tool({ args: ' { "path" : "report.md" }\r\n', result: raw, error: '  retained error\r\n' })
  const preview = readActivityPreview(original)
  expect(preview).toEqual({ content: 'A\nB\n' })
  expect(workToolTechnicalFields(original)).toEqual([
    { key: 'args', label: '原始输入', raw: original.args },
    { key: 'result', label: '原始输出', raw },
    { key: 'error', label: '原始错误', raw: '  retained error\r\n' }
  ])
  expect(original.result).toBe(raw)
  expect(workToolTechnicalFields(tool({ args: '{"path":', result: '' }))).toEqual([
    { key: 'args', label: '原始输入', raw: '{"path":' }, { key: 'result', label: '原始输出', raw: '' }
  ])
})
