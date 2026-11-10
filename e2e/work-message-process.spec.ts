/** Pure Work timeline regression: process prose and receipts fold together in order,
 * and only confirmed final answers own reply actions. Full child transcripts keep order. */
import { expect, test } from '@playwright/test'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { CommandJobStatus } from '../src/shared/command-job'
import type { RootRun } from '../src/shared/root-run'
import { finalAnswerForMessage } from '../src/renderer/src/core/engine/final-result'
import { captureWorkCollaborationMembership, workMessagePresentation, workMessageTimeline, workTranscriptPresentation, type WorkPresentationSegment } from '../src/renderer/src/contrib/work/work-message-timeline'
import { workMessageRunning } from '../src/renderer/src/contrib/work/work-tool-presentation'

function command(status: CommandJobStatus, id: string = status): ToolActivity {
  return { id, name: 'execute_command', args: '{"command":"npm test"}', result: `Full ${status} output`,
    state: status === 'running' || status === 'cancelling' ? 'running' : status === 'succeeded' ? 'done' : 'error',
    commandJob: { schemaVersion: 1, jobId: `job-${id}`, sessionId: 'work-task', ownerSessionId: 'work-task',
      version: 1, status, command: 'npm', args: ['test'], cwd: 'D:/project', background: false,
      createdAt: 10, updatedAt: 20, exitCode: status === 'succeeded' ? 0 : 1, signal: null, cursor: 1, earliestCursor: 1 } }
}
function message(status: ChatMessage['status'], tools: ToolActivity[], rootStatus?: RootRun['status']): ChatMessage {
  return { id: 'assistant', role: 'assistant', status, content: '', thinking: '', createdAt: 10, tools,
    items: tools.map(tool => ({ kind: 'tool', id: tool.id })),
    ...(rootStatus ? { run: { schemaVersion: 1 as const, runId: 'root', sessionId: 'work-task', turnId: 'turn',
      assistantMessageId: 'assistant', userMessageId: 'user', seq: 1, version: 2, status: rootStatus,
      createdAt: 10, updatedAt: 20, pending: [] } } : {}) }
}
function present(value: ChatMessage): WorkPresentationSegment[] {
  return workMessagePresentation(workMessageTimeline(value), undefined,
    finalAnswerForMessage(value, 'work-task'), workMessageRunning(value))
}
function processTools(presentation: WorkPresentationSegment[]): ToolActivity[] {
  return presentation.flatMap(segment => segment.kind === 'process'
    ? segment.segments.flatMap(item => item.kind === 'tools' || item.kind === 'collaboration' ? item.tools : item.kind === 'tool' ? [item.tool] : []) : [])
}

test('child full transcript keeps every prose segment in order and folds even live command output', () => {
  const tool = command('running')
  const source = message('streaming', [tool])
  source.items = [{ kind: 'thinking', text: '内部检查步骤' }, { kind: 'content', text: '先核对输入。' },
    { kind: 'tool', id: tool.id }, { kind: 'content', text: '输入已确认，继续处理。' }]
  const timeline = workMessageTimeline(source), original = structuredClone(timeline)
  const transcript = workTranscriptPresentation(timeline)
  expect(transcript.map(segment => segment.kind)).toEqual(['process', 'answer', 'process', 'answer'])
  expect(transcript.flatMap(segment => segment.kind === 'answer' ? [segment.text] : [])).toEqual(['先核对输入。', '输入已确认，继续处理。'])
  expect(processTools(transcript)).toEqual([tool])
  expect(timeline).toEqual(original)
  // The main conversation retains its live command card and final-answer rules.
  expect(workMessagePresentation(timeline, undefined, false, true).some(segment => segment.kind === 'tool')).toBe(true)
})

test('settled command outcomes share the existing process disclosure in original order', () => {
  const tools = (['failed', 'cancelled', 'interrupted', 'timed_out', 'succeeded'] as const).map(status => command(status))
  const source = message('done', tools, 'succeeded'), original = structuredClone(source)
  const presentation = present(source)
  expect(presentation.map(segment => segment.kind)).toEqual(['process'])
  expect(processTools(presentation)).toEqual(tools)
  expect(source).toEqual(original)
})

test('failed, stopped and interrupted owning turns also fold command records', () => {
  for (const [status, rootStatus] of [['error', 'failed'], ['aborted', 'cancelled'], ['interrupted', 'interrupted']] as const) {
    const tool = command('failed')
    expect(present(message(status, [tool], rootStatus))).toEqual([
      { kind: 'process', key: `tool:${tool.id}`, segments: [{ kind: 'tools', key: `tool:${tool.id}`, tools: [tool] }] }
    ])
  }
})

test('running and waiting roots retain their command cards even when a transcript segment has ended', () => {
  const tools = [command('running'), command('failed')]
  for (const rootStatus of ['running', 'waiting'] as const) {
    const presentation = present(message('done', tools, rootStatus))
    expect(presentation.map(segment => segment.kind)).toEqual(['tool', 'tool'])
    expect(processTools(presentation)).toEqual([])
  }
})

test('legacy histories use message settlement and stale running job snapshots cannot bypass it', () => {
  const tools = [command('running')]
  for (const status of ['done', 'error', 'aborted', 'interrupted'] as const) {
    expect(processTools(present(message(status, tools)))).toEqual(tools)
  }
  for (const status of ['streaming', 'waiting'] as const) {
    expect(present(message(status, tools)).map(segment => segment.kind)).toEqual(['tool'])
  }
})

test('final answer and delivered image stay outside while command and preview evidence fold together', () => {
  const tool = command('failed'), preview: ToolActivity = { id: 'preview', name: 'browser_snapshot',
    args: '{}', result: 'Process screenshot receipt', state: 'done' }
  const final = '成品已完成。\n\n![成品](D:/project/final.png)'
  const source = message('done', [tool, preview], 'succeeded')
  source.content = `先检查失败原因。\n${final}`
  source.items = [{ kind: 'content', text: '先检查失败原因。' }, { kind: 'tool', id: tool.id },
    { kind: 'tool', id: preview.id }, { kind: 'content', text: final }]
  const presentation = workMessagePresentation(workMessageTimeline(source), undefined, { text: final }, false)
  expect(presentation.map(segment => segment.kind)).toEqual(['process', 'answer'])
  expect(presentation[0]).toMatchObject({ kind: 'process', segments: [{ kind: 'content', text: '先检查失败原因。' }, { kind: 'tools' }] })
  expect(processTools(presentation)).toEqual([tool, preview])
  expect(presentation.at(-1)).toEqual({ kind: 'answer', key: 'final-result', text: final })
})

test('command completion alone is not promoted to a final answer', () => {
  const source = message('done', [command('succeeded')], 'succeeded')
  source.content = '现在开始运行验证。'
  source.items.unshift({ kind: 'content', text: source.content })
  const presentation = present(source)
  expect(presentation.map(segment => segment.kind)).toEqual(['process'])
  expect(presentation[0]).toMatchObject({ kind: 'process', segments: [{ kind: 'content', text: source.content }, { kind: 'tools' }] })
  expect(presentation.filter(segment => segment.kind === 'answer')).toEqual([])
})

test('a full report and closing prose remain intact inside process while only the published answer is copied', () => {
  const report = '# 完整核对报告\n\n' + Array.from({ length: 60 }, (_, index) =>
    `## 核对项 ${index + 1}\n\nREPORT_SECTION_${index}：保留检查依据、差异说明与原始结论。\n\n`).join('') +
    '```ts\n  return originalValue\n```\n\nREPORT_END'
  const closing = '页面复核也已完成，完整报告保持原文可读。'
  const final = '最终交付已确认，请查看完整报告和附件。'
  const tool = command('succeeded', 'after-report')
  const source = message('done', [tool], 'succeeded')
  source.content = `${report}\n\n${closing}\n\n${final}`
  source.items = [{ kind: 'thinking', text: '内部核对过程。' }, { kind: 'content', text: report },
    { kind: 'tool', id: tool.id }, { kind: 'content', text: `${closing}\n\n${final}` }]
  source.finalResult = { schemaVersion: 1, sessionId: 'work-task', turnId: 'turn', runId: 'root',
    assistantMessageId: 'assistant', text: final, publishedAt: 20, items: [] }
  const original = structuredClone(source), presentation = present(source)
  expect(presentation.map(segment => segment.kind)).toEqual(['process', 'answer'])
  expect(presentation.filter(segment => segment.kind === 'content')).toEqual([])
  const process = presentation.flatMap(segment => segment.kind === 'process' ? segment.segments : [])
  expect(process.map(segment => segment.kind)).toEqual(['thinking', 'content', 'tools', 'content'])
  expect(process.flatMap(segment => segment.kind === 'content' ? [segment.text] : [])).toEqual([report, closing])
  expect(processTools(presentation)).toEqual([tool])
  const answers = presentation.flatMap(segment => segment.kind === 'answer' ? [segment.text] : [])
  expect(answers).toEqual([final])
  expect(answers.join('\n\n')).not.toContain('REPORT_SECTION_')
  expect(answers.join('\n\n')).not.toContain(closing)
  // A published suffix is rendered once, without duplicating it in the body.
  const prose = [...process, ...presentation].flatMap(segment => segment.kind === 'content' || segment.kind === 'answer' ? [segment.text] : []).join('\n\n')
  expect(prose).toBe(`${report}\n\n${closing}\n\n${final}`)
  expect(source).toEqual(original)
})

test('live and unsuccessful tool turns keep AI progress around the matching receipts without a final answer', () => {
  for (const status of ['streaming', 'waiting', 'error', 'aborted', 'interrupted'] as const) {
    const tool: ToolActivity = { id: 'read', name: 'read_file', args: '{}', result: 'source', state: 'done' }
    const source = message(status, [tool])
    source.items = [{ kind: 'content', text: '先检查输入。' }, { kind: 'tool', id: tool.id }, { kind: 'content', text: '核对结果，等待下一步。' }]
    const original = structuredClone(source), presentation = present(source)
    expect(presentation.map(segment => segment.kind)).toEqual(['process'])
    expect(presentation[0]).toMatchObject({ segments: [
      { kind: 'content', text: '先检查输入。' }, { kind: 'tools', tools: [tool] }, { kind: 'content', text: '核对结果，等待下一步。' }
    ] })
    expect(source).toEqual(original)
  }
})

test('ordinary text-only replies remain visible while streaming and after completion', () => {
  for (const status of ['streaming', 'waiting', 'error', 'aborted', 'done'] as const) {
    const source = message(status, [])
    source.content = '这是直接给用户的回答。'
    source.items = [{ kind: 'content', text: source.content }]
    expect(present(source)).toEqual([{ kind: status === 'done' ? 'answer' : 'content', key: 'content:0', text: source.content }])
  }
})

test('legacy completed turns expose only the trailing answer after the last tool', () => {
  const tool: ToolActivity = { id: 'read', name: 'read_file', args: '{}', result: 'source', state: 'done' }
  const source = message('done', [tool])
  source.items = [{ kind: 'content', text: '先查看输入。' }, { kind: 'tool', id: tool.id }, { kind: 'content', text: '核对完成，这是最终结论。' }]
  const presentation = present(source)
  expect(presentation.map(segment => segment.kind)).toEqual(['process', 'answer'])
  expect(presentation[0]).toMatchObject({ segments: [{ kind: 'content', text: '先查看输入。' }, { kind: 'tools', tools: [tool] }] })
  expect(presentation[1]).toMatchObject({ kind: 'answer', text: '核对完成，这是最终结论。' })
})

test('an empty published answer never promotes its earlier progress into an answer', () => {
  expect(workMessagePresentation([{ kind: 'content', key: 'progress', text: '交付信息在附件里。' }], undefined, { text: '' }, false)).toEqual([
    { kind: 'process', key: 'progress', segments: [{ kind: 'content', key: 'progress', text: '交付信息在附件里。' }] }
  ])
})

test('collaboration and adjacent commands share the owning process in original order', () => {
  const before = command('failed', 'before'), after = command('cancelled', 'after')
  const collaborator: ToolActivity = { id: 'delegate', name: 'subagent', args: '{}', result: '协作结果', state: 'done' }
  const presentation = present(message('done', [before, collaborator, after], 'succeeded'))
  expect(presentation.map(segment => segment.kind)).toEqual(['process'])
  expect(processTools(presentation)).toEqual([before, collaborator, after])
  expect(presentation[0]).toEqual({ kind: 'process', key: 'tool:before', segments: [
    { kind: 'tools', key: 'tool:before', tools: [before] },
    { kind: 'tool', key: 'tool:delegate', tool: collaborator },
    { kind: 'tools', key: 'tool:after', tools: [after] }
  ] })
})

test('a reply containing only a child invocation still has a process in live and settled phases', () => {
  for (const status of ['streaming', 'waiting', 'done', 'error'] as const) {
    const child: ToolActivity = { id: 'only-child', name: 'subagent_start', args: '{}', result: '',
      state: status === 'streaming' || status === 'waiting' ? 'running' : 'done' }
    const source = message(status, [child]), original = structuredClone(source)
    const presentation = present(source)
    expect(presentation.map(segment => segment.kind)).toEqual(['process'])
    expect(processTools(presentation)).toEqual([child])
    expect(source).toEqual(original)
  }
})

test('completed collaboration groups stay inside process while their final answer stays outside', () => {
  const children = Array.from({ length: 4 }, (_, index): ToolActivity => ({
    id: `child-${index}`, name: 'subagent_start', args: '{}', result: `Child ${index} result`, state: 'done',
    subagent: { schemaVersion: 1, runId: `run-${index}`, tenantId: 'tenant', rootSessionId: 'work-task',
      parentSessionId: 'work-task', parentConversationId: 'turn', parentMessageId: 'assistant', parentToolCallId: `child-${index}`,
      childSessionId: `session-${index}`, agentId: 'general', agentName: `Agent ${index}`, task: 'Inspect task',
      description: '', modelId: 'model', lastSeq: 1, usage: {}, toolCalls: [],
      status: 'succeeded', createdAt: 10, updatedAt: 20, finishedAt: 20 }
  }))
  const source = message('done', children, 'succeeded')
  // Repeated stream references do not create extra process steps.
  source.items.push({ kind: 'tool', id: children[0].id })
  const original = structuredClone(source)
  const presentation = workMessagePresentation(workMessageTimeline(source), undefined, { text: '最终结论' }, false)
  expect(presentation).toEqual([
    { kind: 'process', key: 'tool:child-0', segments: [{ kind: 'collaboration', key: 'tool:child-0', tools: children }] },
    { kind: 'answer', key: 'final-result', text: '最终结论' }
  ])
  expect(processTools(presentation).map(tool => tool.id)).toEqual(children.map(tool => tool.id))
  expect(captureWorkCollaborationMembership(presentation)).toEqual(new Map(children.map(tool => [tool.id, 'tool:child-0'])))
  expect(source).toEqual(original)

  const next = { ...children[0], id: 'later-child', subagent: { ...children[0].subagent!, runId: 'later-run', parentToolCallId: 'later-child' } }
  const frozen = workMessagePresentation(workMessageTimeline(message('done', [...children, next])),
    captureWorkCollaborationMembership(presentation), { text: '最终结论' }, false)
  expect(frozen[0]).toEqual({ kind: 'process', key: 'tool:child-0', segments: [
    { kind: 'collaboration', key: 'tool:child-0', tools: children }, { kind: 'tool', key: 'tool:later-child', tool: next }
  ] })
})

test('whitespace-only streamed segments never create an empty process disclosure', () => {
  const source = message('done', [], 'succeeded')
  source.content = ' \n\t '
  source.thinking = '\n '
  source.items = [{ kind: 'thinking', text: '\t ' }, { kind: 'content', text: '\n\n' }]
  expect(workMessageTimeline(source)).toEqual([])
  expect(present(source)).toEqual([])
  expect(workMessagePresentation([{ kind: 'thinking', key: 'thinking', text: '  ' },
    { kind: 'content', key: 'content', text: '\n' }], undefined, false, false)).toEqual([])
})

test('removing blank segments preserves meaningful streamed spaces and code indentation', () => {
  const source = message('streaming', [], 'running')
  source.items = [{ kind: 'content', text: 'hello' }, { kind: 'content', text: ' ' },
    { kind: 'content', text: 'world\n\n```ts\n' }, { kind: 'content', text: '  ' },
    { kind: 'content', text: 'return value\n```' }]
  const original = structuredClone(source)
  expect(workMessageTimeline(source)).toEqual([{ kind: 'content', key: 'content:0', text: 'hello world\n\n```ts\n  return value\n```' }])
  expect(source).toEqual(original)
})

test('a trailing blank segment cannot hide a real legacy answer or add a process header', () => {
  const presentation = workMessagePresentation([{ kind: 'content', key: 'answer', text: '已完成核对。' },
    { kind: 'thinking', key: 'empty-thinking', text: '\n' }, { kind: 'content', key: 'empty-content', text: '  ' }])
  expect(presentation).toEqual([{ kind: 'answer', key: 'answer', text: '已完成核对。' }])
})
