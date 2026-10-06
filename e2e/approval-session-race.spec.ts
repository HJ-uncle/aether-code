/** Real useChat callbacks in a VM: stale approval closures and IPC retry ownership. No Electron window. */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { buildToolResponse } from '../src/renderer/src/core/engine/pending'
import { applyRootRun, finishTransport } from '../src/renderer/src/core/engine/root-run-state'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { RootRun, RootRunStatus } from '../src/shared/root-run'
import type { StreamEvent } from '../src/shared/ipc'
import { parseSseBlock } from '../src/main/engine/sse'

// Execute the production callbacks, rather than a copy of their validation.
const filename = resolve(__dirname, '../src/renderer/src/core/engine/useChat.ts')
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
function callbackDeclaration(name: string): string {
  let declaration: ts.VariableDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declaration = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!declaration) throw new Error(`Missing useChat callback: ${name}`)
  return `const ${declaration.getText(source)};`
}
function functionDeclaration(name: string): string {
  let declaration: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!declaration) throw new Error(`Missing useChat function: ${name}`)
  return declaration.getText(source)
}
const callbacks = ts.transpileModule(
  `${callbackDeclaration('runStream')}\n${callbackDeclaration('respond')}\n` +
  ['patchLastAssistant', 'recover', 'refreshWaitingRun', 'isApprovalConflict', 'applyEvent'].map(functionDeclaration).join('\n') +
  '\nglobalThis.respond = respond; globalThis.applyEvent = applyEvent;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText

type StartInput = { streamId: string; path: string; body: Record<string, unknown> }
function harness(start?: (input: StartInput) => Promise<void>, recovery?: (sessionId: string) => Promise<boolean>) {
  const run: RootRun = {
    schemaVersion: 1, runId: 'run-a', sessionId: 'session-a', turnId: 'turn-a',
    userMessageId: 'user-a', assistantMessageId: 'assistant-a', version: 2, seq: 1,
    status: 'waiting', createdAt: 1, updatedAt: 2,
    pending: [{ requestId: 'request-a', kind: 'permission', toolCallId: 'tool-a',
      toolName: 'execute_cmd', args: { command: 'echo fixture' }, status: 'pending' }]
  }
  const message: ChatMessage = {
    id: 'assistant-a', role: 'assistant', runId: run.runId, run,
    status: 'waiting', content: '', thinking: '', tools: [], items: [], createdAt: 1,
    interactions: [{ ...run.pending[0], runId: run.runId, question: 'Allow fixture?',
      options: [], multiSelect: false, groups: [] }]
  }
  const calls: StartInput[] = []
  const recoveries: string[] = []
  const streaming: boolean[] = []
  let messageState = [message]
  const refs = {
    activeStreamRef: { current: null as string | null },
    activeSessionRef: { current: 'session-a' as string | null },
    viewSessionRef: { current: 'session-a' as string | null },
    activeRunIdRef: { current: 'run-a' as string | null },
    rootRunsRef: { current: new Map<string, RootRun>([[run.runId, run]]) },
    optimisticIdsRef: { current: {} as { assistantId?: string } },
    answeringRef: { current: new Set<string>() },
    approvalRefreshRef: { current: null as { sessionId: string; source: number } | null },
    consumedEventIdRef: { current: null },
    recoveryAttemptsRef: { current: 0 },
    recoverRef: { current: async (sessionId: string): Promise<boolean> => {
      recoveries.push(sessionId)
      return recovery ? recovery(sessionId) : false
    } },
    drainQueueRef: { current: async () => {} }
  }
  let engineSource = 1
  let ids = 0
  const context = {
    ...refs, Error, messages: [message], renderSource: engineSource,
    useCallback: <T>(callback: T): T => callback,
    getEngineSource: () => engineSource,
    assertEngineSource: (expected: number) => { if (expected !== engineSource) throw new Error('Engine changed') },
    newId: () => `stream-${++ids}`,
    setStreaming: (value: boolean) => { streaming.push(value) },
    setMessages: (update: (previous: ChatMessage[]) => ChatMessage[]) => {
      messageState = update(messageState)
      context.messages = messageState
    },
    flushStreamPatches: () => {},
    reconcile: () => {},
    finishTransport,
    buildToolResponse,
    engine: { startStream: async (input: StartInput) => { calls.push(input); await start?.(input) } },
    respond: undefined as unknown as (requestId: string, values: string[], options: { sessionId: string }) => Promise<void>,
    applyEvent: undefined as unknown as (event: StreamEvent) => void
  }
  runInNewContext(callbacks, context)
  return { ...refs, run, message, calls, streaming, recoveries,
    messages: () => messageState,
    applySnapshot: (next: RootRun) => {
      refs.rootRunsRef.current.set(next.runId, next)
      context.setMessages(previous => applyRootRun(previous, next))
    },
    event: (event: StreamEvent) => context.applyEvent(event),
    // Playwright's matcher chain needs a host-realm Promise and Error. Preserve
    // the production rejection while crossing the VM boundary explicitly.
    respond: async () => await context.respond('request-a', ['approved'], { sessionId: 'session-a' }),
    changeEngine: () => { engineSource = 2 } }
}

test('安全模式请求晚返回：切换到B后旧A审批闭包不得起流或覆盖B', async () => {
  const state = harness()
  state.viewSessionRef.current = 'session-b'
  state.activeSessionRef.current = null
  state.activeRunIdRef.current = null
  state.rootRunsRef.current.clear()
  await state.respond()
  expect(state.calls).toEqual([])
  expect(state.streaming).toEqual([])
  expect(state.viewSessionRef.current).toBe('session-b')
  expect(state.activeSessionRef.current).toBeNull()
})

for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted', 'running'] satisfies RootRunStatus[]) {
  test(`同会话旧waiting闭包不能应答最新${status}运行`, async () => {
    const state = harness()
    state.rootRunsRef.current.set(state.run.runId, { ...state.run, version: 3, status })
    await expect(state.respond()).rejects.toThrow('待应答请求已变化')
    expect(state.calls).toEqual([])
    expect(state.answeringRef.current.size).toBe(0)
  })
}

test('最新请求已回答、被替换或工具身份变化时不得使用旧审批', async () => {
  for (const pending of [
    { status: 'answered' as const, output: 'approved' },
    { requestId: 'request-b' },
    { toolCallId: 'tool-b' },
    { toolName: 'delete_file' },
    { kind: 'ask' as const }
  ]) {
    const state = harness()
    state.rootRunsRef.current.set(state.run.runId, { ...state.run, version: 3,
      pending: [{ ...state.run.pending[0], ...pending }] })
    await expect(state.respond()).rejects.toThrow('待应答请求已变化')
    expect(state.calls).toEqual([])
  }
})

test('当前durable请求正常提交准确身份，重复点击不重复起流', async () => {
  const state = harness()
  await state.respond()
  await state.respond()
  expect(state.calls).toEqual([{ streamId: 'stream-1', path: '/chat', body: {
    sessionId: 'session-a', runId: 'run-a', toolResponse: {
      toolCallId: 'tool-a', name: 'execute_cmd', output: 'approved', requestId: 'request-a', runId: 'run-a'
    }
  } }])
  expect(state.streaming).toEqual([true])
})

test('IPC启动拒绝释放本次流锁，原审批可以重试', async () => {
  let attempts = 0
  const state = harness(async () => { if (++attempts === 1) throw new Error('IPC start failed') })
  await expect(state.respond()).rejects.toThrow('IPC start failed')
  expect(state.activeStreamRef.current).toBeNull()
  expect(state.answeringRef.current.size).toBe(0)
  expect(state.streaming).toEqual([true, false])
  await state.respond()
  expect(state.calls.map(call => call.streamId)).toEqual(['stream-1', 'stream-2'])
  expect(state.activeStreamRef.current).toBe('stream-2')
})

test('A的启动拒绝晚于切换到B，不清理B的新流和加载状态', async () => {
  let rejectStart: (reason: Error) => void = () => { throw new Error('Start was not reached') }
  const state = harness(() => new Promise<void>((_resolve, reject) => { rejectStart = reject }))
  const response = state.respond()
  state.viewSessionRef.current = 'session-b'
  state.activeStreamRef.current = 'stream-b'
  state.answeringRef.current.clear()
  rejectStart(new Error('late IPC failure'))
  await response
  expect(state.activeStreamRef.current).toBe('stream-b')
  expect(state.viewSessionRef.current).toBe('session-b')
  expect(state.streaming).toEqual([true])
})

test('同会话已经启动的新流不会被旧提交的失败清理', async () => {
  let rejectStart: (reason: Error) => void = () => { throw new Error('Start was not reached') }
  const state = harness(() => new Promise<void>((_resolve, reject) => { rejectStart = reject }))
  const response = state.respond()
  state.activeStreamRef.current = 'newer-stream-a'
  rejectStart(new Error('late IPC failure'))
  await response
  expect(state.activeStreamRef.current).toBe('newer-stream-a')
  expect(state.streaming).toEqual([true])
})

test('引擎切换后的旧审批闭包不向新引擎发送请求', async () => {
  const state = harness()
  state.changeEngine()
  await expect(state.respond()).rejects.toThrow('Engine changed')
  expect(state.calls).toEqual([])
})

for (const status of [404, 409]) {
  test(`应答HTTP${status}冲突拉取最新快照，恢复期间禁止重复提交`, async () => {
    let finishRecovery: (attached: boolean) => void = () => { throw new Error('Recovery was not reached') }
    const state = harness(undefined, () => new Promise<boolean>(resolveRecovery => { finishRecovery = resolveRecovery }))
    await state.respond()
    state.event({ streamId: 'stream-1', type: 'error', status, message: 'Request is no longer pending' })
    expect(state.recoveries).toEqual(['session-a'])
    expect(state.approvalRefreshRef.current?.sessionId).toBe('session-a')
    await state.respond()
    expect(state.calls).toHaveLength(1)
    const next: RootRun = status === 404
      ? { ...state.run, status: 'cancelled', version: 3 }
      : { ...state.run, status: 'succeeded', version: 3,
          pending: [{ ...state.run.pending[0], status: 'answered', output: 'approved' }] }
    state.applySnapshot(next)
    finishRecovery(false)
    await expect.poll(() => state.approvalRefreshRef.current).toBeNull()
    expect(state.messages()[0].run?.status).toBe(next.status)
    expect(state.messages()[0].status).toBe(status === 404 ? 'aborted' : 'done')
    await expect(state.respond()).rejects.toThrow('待应答请求已变化')
    expect(state.calls).toHaveLength(1)
    expect(state.streaming.at(-1)).toBe(false)
  })
}

for (const format of ['http-200-json', 'sse-message', 'sse-code']) {
  test(`审批失效兼容${format}信封并用取消快照清理旧卡片`, async () => {
    let finishRecovery: (attached: boolean) => void = () => { throw new Error('Recovery was not reached') }
    const state = harness(undefined, () => new Promise<boolean>(resolveRecovery => { finishRecovery = resolveRecovery }))
    await state.respond()
    if (format === 'http-200-json') {
      state.event({ streamId: 'stream-1', type: 'error', status: 200, code: 409, message: '请求状态已变化' })
    } else {
      const parsed = parseSseBlock(`data: ${JSON.stringify(format === 'sse-message'
        ? { error: 'Run is no longer waiting' }
        : { error: '请求状态已变化', code: 409 })}`)
      if (!parsed) throw new Error('Fixture SSE error was not parsed')
      state.event({ streamId: 'stream-1', ...parsed })
    }
    expect(state.recoveries).toEqual(['session-a'])
    expect(state.approvalRefreshRef.current?.sessionId).toBe('session-a')
    state.applySnapshot({ ...state.run, version: 3, status: 'cancelled' })
    finishRecovery(false)
    await expect.poll(() => state.approvalRefreshRef.current).toBeNull()
    expect(state.messages()[0].status).toBe('aborted')
    await expect(state.respond()).rejects.toThrow('待应答请求已变化')
    expect(state.calls).toHaveLength(1)
  })
}

test('冲突快照仍是waiting/pending时保留审批并允许重试', async () => {
  let finishRecovery: (attached: boolean) => void = () => { throw new Error('Recovery was not reached') }
  const state = harness(undefined, () => new Promise<boolean>(resolveRecovery => { finishRecovery = resolveRecovery }))
  await state.respond()
  state.event({ streamId: 'stream-1', type: 'error', status: 409, message: 'Previous batch is settling' })
  state.applySnapshot({ ...state.run, version: 3 })
  finishRecovery(false)
  await expect.poll(() => state.approvalRefreshRef.current).toBeNull()
  expect(state.messages()[0].interactions?.[0].status).toBe('pending')
  expect(state.messages()[0].error).toBeUndefined()
  await state.respond()
  expect(state.calls).toHaveLength(2)
})

test('冲突快照已由另一端批准并继续运行时保持恢复后的流', async () => {
  let finishRecovery: (attached: boolean) => void = () => { throw new Error('Recovery was not reached') }
  const state = harness(undefined, () => new Promise<boolean>(resolveRecovery => { finishRecovery = resolveRecovery }))
  await state.respond()
  state.event({ streamId: 'stream-1', type: 'error', status: 409, message: 'Already answered differently' })
  state.applySnapshot({ ...state.run, status: 'running', version: 3,
    pending: [{ ...state.run.pending[0], status: 'answered', output: 'approved' }] })
  state.activeStreamRef.current = 'resumed-stream-a'
  finishRecovery(true)
  await expect.poll(() => state.approvalRefreshRef.current).toBeNull()
  expect(state.activeStreamRef.current).toBe('resumed-stream-a')
  expect(state.messages()[0].interactions?.[0].status).toBe('answered')
  expect(state.streaming.at(-1)).toBe(true)
})

test('普通暂时网络错误不把真实pending请求归档，原请求可重试', async () => {
  for (const status of [undefined, 503]) {
    const state = harness()
    await state.respond()
    state.event({ streamId: 'stream-1', type: 'error', status, message: 'Temporary network error' })
    expect(state.recoveries).toEqual([])
    expect(state.messages()[0].run?.status).toBe('waiting')
    expect(state.messages()[0].interactions?.[0].status).toBe('pending')
    expect(state.messages()[0].error).toBe('Temporary network error')
    await state.respond()
    expect(state.calls).toHaveLength(2)
  }
})

test('冲突后快照暂时获取失败不伪造终态，解除刷新锁以便重试', async () => {
  const state = harness(undefined, async () => { throw new Error('Snapshot unavailable') })
  await state.respond()
  state.event({ streamId: 'stream-1', type: 'error', status: 409, message: 'Approval conflict' })
  await expect.poll(() => state.approvalRefreshRef.current).toBeNull()
  expect(state.messages()[0].run?.status).toBe('waiting')
  expect(state.messages()[0].interactions?.[0].status).toBe('pending')
  await state.respond()
  expect(state.calls).toHaveLength(2)
})

test('旧会话审批刷新结束不解锁新会话的流', async () => {
  let finishRecovery: (attached: boolean) => void = () => { throw new Error('Recovery was not reached') }
  const state = harness(undefined, () => new Promise<boolean>(resolveRecovery => { finishRecovery = resolveRecovery }))
  await state.respond()
  state.event({ streamId: 'stream-1', type: 'error', status: 409, message: 'Approval conflict' })
  state.viewSessionRef.current = 'session-b'
  state.activeSessionRef.current = 'session-b'
  state.activeStreamRef.current = 'stream-b'
  state.approvalRefreshRef.current = null
  const transitions = [...state.streaming]
  finishRecovery(false)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(state.activeStreamRef.current).toBe('stream-b')
  expect(state.streaming).toEqual(transitions)
})
