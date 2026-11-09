/** Pure Work timeline regression: settled commands belong to process; live actions and final answers retain their scope. */
import { expect, test } from '@playwright/test'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { CommandJobStatus } from '../src/shared/command-job'
import type { RootRun } from '../src/shared/root-run'
import { finalAnswerForMessage } from '../src/renderer/src/core/engine/final-result'
import { workMessagePresentation, workMessageTimeline, type WorkPresentationSegment } from '../src/renderer/src/contrib/work/work-message-timeline'
import { workMessageRunning } from '../src/renderer/src/contrib/work/work-tool-presentation'

function command(status: CommandJobStatus, id = status): ToolActivity {
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
    ? segment.segments.flatMap(item => item.kind === 'tools' ? item.tools : []) : [])
}

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
  expect(processTools(presentation)).toEqual([tool, preview])
  expect(presentation.at(-1)).toEqual({ kind: 'answer', key: 'final-result', text: final })
})

test('command completion alone is not promoted to a final answer', () => {
  const source = message('done', [command('succeeded')], 'succeeded')
  source.content = '现在开始运行验证。'
  source.items.unshift({ kind: 'content', text: source.content })
  expect(present(source).map(segment => segment.kind)).toEqual(['process'])
})

test('collaboration boundaries survive folding adjacent commands', () => {
  const before = command('failed', 'before'), after = command('cancelled', 'after')
  const collaborator: ToolActivity = { id: 'delegate', name: 'subagent', args: '{}', result: '协作结果', state: 'done' }
  const presentation = present(message('done', [before, collaborator, after], 'succeeded'))
  expect(presentation.map(segment => segment.kind)).toEqual(['process', 'tool', 'process'])
  expect(processTools(presentation)).toEqual([before, after])
  expect(presentation[1]).toEqual({ kind: 'tool', key: 'tool:delegate', tool: collaborator })
})
