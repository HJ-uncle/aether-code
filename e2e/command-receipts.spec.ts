/** Pure command receipt protocol and rendering inputs; no Electron process. */
import { expect, test } from '@playwright/test'
import { commandLogText, isCommandReceipt, parseCommandReceipts } from '../src/shared/command-receipt'
import { commandInvocation, exportToolDiagnostics } from '../src/renderer/src/core/engine/tool-feedback'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { EngineRequestInput } from '../src/shared/ipc'
import { commandReceiptBelongs, readCommandReceiptPage } from '../src/renderer/src/features/conversation/shared/command-receipt-client'
import { getEngineSource, getExpectedEngine, isEngineReady, publishEngineSource } from '../src/renderer/src/core/engine/source'

const receipt = { type: 'command_result', version: 1, jobId: 'job-1', status: 'succeeded', exitCode: 0, signal: null,
  entries: [{ seq: 1, stream: 'stdout', text: '{"text":"business data","schemaVersion":3}\n' }],
  nextCursor: 1, nextOffset: 0, earliestCursor: 0, truncated: false, hasMore: false }

test('only command tools recognize a versioned receipt and preserve the actual program JSON', () => {
  const parsed = parseCommandReceipts(JSON.stringify(receipt), 'execute_cmd')
  expect(parsed).toEqual([receipt])
  expect(parseCommandReceipts(JSON.stringify(receipt), 'read_file')).toBeNull()
  for (const output of ['{"text":"important","count":12}', '"PASS\\n2 checks"', JSON.stringify({ stdout: 'x'.repeat(64001) }), '{"type":"command_result"']) {
    expect(parseCommandReceipts(output, 'execute_cmd')).toBeNull()
    expect(commandLogText(output, 'execute_cmd')).toBe(output)
  }
})

test('accepts partial entries, code-only failures and independently failed batch members', () => {
  const partial = { ...receipt, entries: [{ seq: 1, stream: 'stderr', text: '😀中' }], nextCursor: 0, nextOffset: 7, hasMore: true,
    status: 'failed', exitCode: 7, error: { code: 'COMMAND_EXIT_FAILED' } }
  expect(isCommandReceipt(partial)).toBe(true)
  expect(parseCommandReceipts(JSON.stringify({ type: 'command_results', version: 1, results: [partial, { jobId: 'missing', error: 'COMMAND_JOB_NOT_FOUND' }] }), 'wait_commands')).toEqual([partial, { jobId: 'missing', error: 'COMMAND_JOB_NOT_FOUND' }])
  for (const invalid of [{ ...receipt, version: 2 }, { ...receipt, nextOffset: -1 }, { ...receipt, entries: [{ seq: 2, stream: 'stdout', text: 'bad' }] },
    { ...receipt, entries: [...receipt.entries, ...receipt.entries] }, { ...receipt, error: { code: 10 } }]) expect(isCommandReceipt(invalid)).toBe(false)
})

test('strips only a complete historical file trailer backed by matching metadata', () => {
  const changes = [{ id: 'change-1', path: 'report.md', kind: 'write' }]
  const tail = '\n[文件变化观察] ' + JSON.stringify({ changes, changeTracking: { status: 'complete',
    scope: '仅 cwd 内有界文件观察，不覆盖目录外或其他系统副作用', rollback: '可能含外部并发编辑，须审阅并明确选择变更 ID 后回退' } })
  expect(commandLogText('PASS\n' + tail, 'execute_cmd', { changes })).toBe('PASS\n')
  expect(commandLogText('PASS' + tail, 'execute_cmd')).toBe('PASS' + tail)
  expect(commandLogText('PASS' + tail, 'execute_cmd', { changes: [] })).toBe('PASS' + tail)
  expect(commandLogText('PASS' + tail + '\nnext actual output', 'execute_cmd', { changes })).toBe('PASS' + tail + '\nnext actual output')
  const ordinary = 'real output\n[文件变化观察] {"text":"do not hide me"}'
  expect(commandLogText(ordinary, 'execute_cmd', { changes })).toBe(ordinary)
})

test('keeps command scripts readable without literal JSON escapes', () => {
  const script = 'const title = "中文";\nconsole.log(title);\nconsole.log("done");'
  const invocation = commandInvocation(JSON.stringify({ command: 'node', args: ['-e', script] }))!
  expect(invocation).toContain(script)
  expect(invocation).not.toContain('\\n')
  expect(invocation).not.toContain('\\"')
  expect(commandInvocation(JSON.stringify({ command: 'cmd.exe', args: ['/c', 'npm test'] }))).toBe('cmd.exe /c "npm test"')
})

test('copy and export include readable logs, pending output and notices instead of transport envelopes', () => {
  const tool: ToolActivity = { id: 'tool', name: 'wait_command', args: '{"jobId":"job-1"}', state: 'done',
    result: JSON.stringify({ ...receipt, hasMore: true, notice: '源码发生变化，仍需确认。' }) }
  const exported = exportToolDiagnostics(tool)
  expect(exported).toContain(receipt.entries[0].text)
  expect(exported).toContain('源码发生变化，仍需确认。')
  expect(exported).toContain('后续输出尚未读取')
  expect(exported).not.toContain('command_result')
  expect(exported).not.toContain('nextCursor')
  const business = '{"text":"business JSON","count":19}'
  expect(exportToolDiagnostics({ ...tool, name: 'execute_cmd', result: business })).toContain(business)
  expect(parseCommandReceipts(JSON.stringify({ ...receipt, notice: '停止已确认' }), 'cancel_command')).toEqual([{ ...receipt, notice: '停止已确认' }])
})

test('continuation is one scoped request and rejects foreign jobs or a replaced engine', async () => {
  const job: CommandJobSnapshot = { schemaVersion: 1, jobId: 'job-1', sessionId: 'parent', ownerSessionId: 'child',
    version: 1, status: 'succeeded', command: 'node', args: [], cwd: '/workspace', background: false,
    createdAt: 1, updatedAt: 2, exitCode: 0, signal: null, cursor: 1, earliestCursor: 0 }
  expect(commandReceiptBelongs(job, { sessionId: 'parent' })).toBe(true)
  expect(commandReceiptBelongs(job, { sessionId: 'child', receiptParentSessionId: 'parent' })).toBe(true)
  expect(commandReceiptBelongs(job, { sessionId: 'child' })).toBe(false)
  expect(commandReceiptBelongs(job, { sessionId: 'foreign', receiptParentSessionId: 'parent' })).toBe(false)
  const legacy = { job, entries: receipt.entries, nextCursor: 1, earliestCursor: 0, truncated: false, hasMore: false }
  const parsedLegacy = parseCommandReceipts(JSON.stringify(legacy), 'command_output')
  expect(parsedLegacy?.[0]).toMatchObject({ type: 'command_result', version: 1, jobId: job.jobId, entries: receipt.entries })
  expect(parseCommandReceipts(JSON.stringify(legacy), 'execute_cmd')).toBeNull()
  expect(parseCommandReceipts(JSON.stringify({ ...legacy, extra: 'business metadata' }), 'command_output')).toBeNull()
  expect(parseCommandReceipts(JSON.stringify({ ...legacy, job: { jobId: job.jobId } }), 'command_output')).toBeNull()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousEngine = { ...getExpectedEngine(), phase: isEngineReady() ? 'ready' as const : 'idle' as const }
  const requests: EngineRequestInput[] = []
  let outputJob = job, replace = false
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { aether: { engine: { request: async (input: EngineRequestInput) => {
    requests.push(input)
    if (replace) publishEngineSource({ mode: 'remote', baseUrl: 'http://another-engine', phase: 'ready' })
    return { ok: true, data: { job: outputJob, entries: [{ seq: 1, stream: 'stdout', text: '文' }], nextCursor: 1, nextOffset: 0,
      earliestCursor: 0, truncated: false, hasMore: false } }
  } } } } })
  try {
    publishEngineSource({ mode: 'remote', baseUrl: 'http://receipt-engine', phase: 'ready' })
    const page = await readCommandReceiptPage(job, 0, 7, getEngineSource())
    expect(page.entries[0].text).toBe('文')
    expect(requests).toHaveLength(1)
    expect(requests[0].query).toEqual({ sessionId: 'parent', cursor: 0, cursorOffset: 7, maxBytes: 32768 })
    outputJob = { ...job, ownerSessionId: 'other-child' }
    await expect(readCommandReceiptPage(job, 0, 7, getEngineSource())).rejects.toThrow('归属不一致')
    outputJob = job; replace = true
    await expect(readCommandReceiptPage(job, 0, 7, getEngineSource())).rejects.toThrow('连接已变化')
  } finally {
    publishEngineSource(previousEngine)
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
