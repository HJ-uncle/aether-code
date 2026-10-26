/** Pure Work-domain contracts: persisted preference recovery, engine/session
 * isolation, truthful run status, and artifact provenance. No Electron needed. */
import { expect, test } from '@playwright/test'
import {
  normalizeWorkState,
  workArtifacts,
  workStatus,
  workStorageKey
} from '../src/renderer/src/contrib/work/work-state'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { EngineFileChange } from '../src/shared/ipc'

function message(status: ChatMessage['status'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant',
    role: 'assistant',
    content: '',
    thinking: '',
    tools: [],
    items: [],
    createdAt: 1,
    status,
    ...extra
  }
}
const receipt: EngineFileChange = {
  id: 'report-change',
  path: 'D:\\work\\report.md',
  displayPath: 'report.md',
  kind: 'write',
  oldContent: null,
  newContent: '# 实际结果',
  isNew: true,
  truncated: false,
  status: 'kept',
  createdAt: 20
}

test('真实自动化 UUID 会话带来源恢复，普通 Code ID 与不完整来源仍不能混入 Work', () => {
  const task = { id: '58a84948-15bf-4d80-a40c-c94508814aa3', title: '定时审查', createdAt: 10, status: 'done',
    origin: { kind: 'automation', jobId: 'actual-job', runId: 'actual-cron-run' } }
  const saved = JSON.parse(JSON.stringify({ tasks: [task, { ...task, id: 'unmarked-code', origin: undefined },
    { ...task, id: 'incomplete-record', origin: { kind: 'automation', jobId: 'actual-job' } }], activeTaskId: task.id }))
  const recovered = normalizeWorkState(saved)
  expect(recovered.tasks).toHaveLength(1)
  expect(recovered.tasks[0]).toMatchObject({ id: task.id, status: 'done', origin: task.origin })
  expect(recovered.activeTaskId).toBe(task.id)
})

test('Work 本地恢复丢弃损坏数据与 Code 会话，不保留悬空选中项', () => {
  for (const value of [null, false, [], 'bad']) {
    expect(normalizeWorkState(value)).toMatchObject({
      tasks: [],
      activeTaskId: null,
      homeDraft: '',
      homeAttachments: []
    })
  }
  const normalized = normalizeWorkState({
    tasks: [
      null,
      { id: 'code-session', title: '开发对话', createdAt: 1 },
      {
        id: 'work-valid',
        title: '工作任务',
        createdAt: 2,
        status: 'unknown',
        attachments: [{ path: 42 }],
        sources: []
      }
    ],
    activeTaskId: 'code-session',
    homeDraft: '保留未发送内容',
    homeAttachments: [{ path: 'brief.md', name: 'brief.md', size: 5, type: 'text/markdown' }]
  })
  expect(normalized.tasks).toEqual([
    {
      id: 'work-valid',
      title: '工作任务',
      createdAt: 2,
      updatedAt: 2,
      status: 'draft',
      draft: '',
      workspacePath: null,
      modelId: '',
      attachments: [],
      sources: []
    }
  ])
  expect(normalized.activeTaskId).toBeNull()
  expect(normalized.homeDraft).toBe('保留未发送内容')
  expect(normalized.homeAttachments).toHaveLength(1)
})

test('Work 状态按引擎来源隔离，连接地址和账号不会覆盖另一份草稿', () => {
  const keys = [
    '',
    'remote:https://alpha.example',
    'remote:https://beta.example',
    'remote:https://alpha.example:account:alice',
    'remote:https://alpha.example:account:bob'
  ].map(workStorageKey)
  expect(new Set(keys).size).toBe(keys.length)
  expect(keys.every((key) => key.startsWith('aether.work.state.v1'))).toBe(true)
  expect(keys).not.toContain('aether.ide.layout')
})

test('Work 执行状态区分等待、失败、中断和停止，不能把断流当完成', () => {
  expect(workStatus([], false)).toBeNull()
  expect(workStatus([message('done', { role: 'user' })], false)).toBeNull()
  expect(workStatus([message('streaming')], false)).toBe('running')
  expect(workStatus([message('waiting')], true)).toBe('waiting')
  expect(workStatus([message('error')], false)).toBe('error')
  expect(workStatus([message('aborted')], false)).toBe('stopped')
  expect(workStatus([message('interrupted')], false)).toBe('interrupted')
  expect(workStatus([message('done')], false)).toBe('done')
})

test('成果只来源于文件写入回执，删除标记历史成果，已撤销和文字声称不计入', () => {
  const tool = (change: EngineFileChange) => ({
    id: change.id,
    name: 'write_file',
    args: '{}',
    result: 'ok',
    state: 'done' as const,
    change
  })
  const artifacts = workArtifacts([
    message('done', {
      content: '我已经创建了 guessed.docx、imaginary.xlsx。',
      tools: [
        tool(receipt),
        tool({ ...receipt, id: 'deleted', kind: 'delete' }),
        tool({ ...receipt, id: 'reverted', status: 'reverted' })
      ]
    })
  ])
  expect(artifacts).toEqual([
    {
      id: 'report-change',
      path: 'D:\\work\\report.md',
      name: 'report.md',
      content: '# 实际结果',
      status: 'deleted',
      createdAt: 20
    }
  ])
  expect(
    workArtifacts([message('done', { content: '已生成一个演示文稿 imaginary.pptx' })])
  ).toEqual([])
})

test('生成、失败、停止和中断时的成果可预览，但不能伪装成已完成成果', () => {
  for (const status of ['streaming', 'error', 'aborted', 'interrupted'] as const) {
    const artifacts = workArtifacts([
      message(status, {
        tools: [
          {
            id: 'write',
            name: 'write_file',
            args: '{}',
            result: '',
            state: 'running',
            change: receipt
          }
        ]
      })
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      name: 'report.md',
      content: '# 实际结果',
      status: status === 'streaming' ? 'draft' : 'unverified'
    })
  }
})
