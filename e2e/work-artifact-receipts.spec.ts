/** Fresh regression from six-role Work office run: successful PDF writes were
 * labelled running and deleted CRUD probes stayed usable in the artifact list. */
import { expect, test } from '@playwright/test'
import { workArtifacts, workArtifactStatusLabel } from '../src/renderer/src/contrib/work/work-state'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { EngineFileChange } from '../src/shared/ipc'

const root = 'D:\\company\\departments\\legal'
function change(id: string, path: string, seq: number, kind: 'write' | 'delete' = 'write'): EngineFileChange {
  return { id, path, seq, kind, createdAt: seq, oldContent: null, newContent: null, truncated: true, status: 'pending', newHash: kind === 'delete' ? 'missing' : 'sha256:written' }
}
function tool(receipt: EngineFileChange, state: ToolActivity['state'] = 'done'): ToolActivity {
  return { id: receipt.id, name: receipt.kind === 'delete' ? 'delete_file' : 'office_document', args: '{}', result: 'applied', state, change: receipt }
}
function message(status: ChatMessage['status'], tools: ToolActivity[]): ChatMessage {
  return { id: status, role: 'assistant', status, content: '', thinking: '', tools, items: [], createdAt: 0 }
}
test('completed Office writes stay written while the parent continues, fails or stops', () => {
  for (const status of ['streaming', 'waiting', 'error', 'aborted', 'interrupted', 'done'] as const) {
    const result = workArtifacts([message(status, [tool(change('contract', root + '\\v1\\contract-review.pdf', 1))])])
    expect(result[0].status).toBe('ready')
    expect(workArtifactStatusLabel(result[0].status)).toBe('已写入')
  }
})
test('real delete receipts retain both historical CRUD outputs with deleted labels', () => {
  const original = root + '\\scratch\\v1\\crud-original.pdf', revised = root + '\\scratch\\v1\\crud-revised.pdf'
  const result = workArtifacts([message('streaming', [
    tool(change('contract', root + '\\v1\\contract-review.pdf', 1)),
    tool(change('original', original, 2)), tool(change('revised', revised, 3)),
    tool(change('delete-original', original.toUpperCase().replaceAll('\\', '/'), 4, 'delete')),
    tool(change('delete-revised', revised, 5, 'delete'))
  ])])
  expect(result.map(item => [item.id, item.status])).toEqual([['revised', 'deleted'], ['original', 'deleted'], ['contract', 'ready']])
  expect(result.filter(item => item.status === 'deleted').map(item => workArtifactStatusLabel(item.status))).toEqual(['已删除', '已删除'])
})
test('recreating a path does not revive its deleted historical version', () => {
  const path = root + '\\report.pdf'
  const result = workArtifacts([message('done', [tool(change('new', path, 3)), tool(change('old', path, 1)), tool(change('delete', path, 2, 'delete'))])])
  expect(result.map(item => [item.id, item.status])).toEqual([['new', 'ready'], ['old', 'deleted']])
})
test('unresolved or failed tools are not certified by a successful parent message', () => {
  for (const state of ['running', 'unknown', 'error', 'cancelled', 'waiting', 'interrupted'] as const) {
    const result = workArtifacts([message('done', [tool(change('uncertain', root + '\\report.pdf', 1), state)])])
    expect(result[0].status).toBe('unverified')
    expect(workArtifactStatusLabel(result[0].status)).toBe('待核验')
  }
  expect(workArtifacts([message('streaming', [tool(change('active', root + '\\report.pdf', 1), 'running')])])[0].status).toBe('draft')
})
test('reverted deletion preserves a completed write and cannot erase its evidence', () => {
  const path = root + '\\report.pdf', removed = { ...change('delete', path, 2, 'delete'), status: 'reverted' as const }
  const result = workArtifacts([message('done', [tool(change('write', path, 1)), tool(removed)])])
  expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id: 'write', status: 'ready' })
})
