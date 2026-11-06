/** Pure session artifact contracts: durable ownership, normalized file identity,
 * operation ordering, intact net segments, exact tool navigation, diff statistics,
 * tree ordering, turn ownership, search and refresh-only tool receipts.
 * No Electron or filesystem writes. */
import { expect, test } from '@playwright/test'
import type { EngineFileChange } from '../src/shared/ipc'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import type { ChatMessage, ToolActivity } from '../src/renderer/src/core/engine/useChat'
import {
  artifactChangeTurnScope,
  artifactChangeStats,
  artifactChangesCancel,
  artifactFileIsDeleted,
  artifactSelectionAvailable,
  artifactTurnScopeKey,
  artifactToolRevision,
  buildArtifactTurnOptions,
  buildSessionArtifactFiles,
  buildSessionArtifactTree,
  currentArtifactForFile,
  defaultArtifactView,
  filterSessionArtifactFiles,
  ownedArtifactChanges,
  reconcileArtifactChanges,
  resolveArtifactChoice,
  scopeArtifactChanges,
  searchArtifactFiles,
  type WorkSessionArtifactFile
} from '../src/renderer/src/contrib/work/work-session-artifacts'

const sessionId = 'work-current'
const root = 'D:/workspace/project'
const change = (id: string, patch: Partial<EngineFileChange> = {}): EngineFileChange => ({
  id, sessionId, path: `${root}/report.md`, kind: 'write', oldContent: 'before\n',
  newContent: 'after\n', truncated: false, status: 'pending', createdAt: 1, ...patch
})
const tool = (patch: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'tool', name: 'write_file', args: '{}', result: '', state: 'done', ...patch
})
const commandJob = (patch: Partial<CommandJobSnapshot> = {}): CommandJobSnapshot => ({
  schemaVersion: 1, jobId: 'job', sessionId, ownerSessionId: sessionId, version: 1,
  command: 'node', args: ['generate.js'], cwd: root, background: true, status: 'succeeded',
  createdAt: 1, updatedAt: 2, cursor: 0, earliestCursor: 0, exitCode: 0, signal: null, ...patch
})
const user = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: 'user', content: `请求 ${id}`, thinking: '', tools: [], items: [], status: 'done',
  createdAt: 1, ...patch
})
const run = (patch: Partial<NonNullable<ChatMessage['run']>> = {}): NonNullable<ChatMessage['run']> => ({
  schemaVersion: 1, runId: 'run', sessionId, turnId: 'turn', userMessageId: 'user',
  assistantMessageId: 'reply', version: 1, seq: 1, status: 'succeeded', createdAt: 1,
  updatedAt: 2, pending: [], ...patch
})

test('当前删除状态使用全会话最新有效记录，历史删除不遮蔽后续重建', () => {
  const created = change('created', { seq: 1, turnId: 'first', oldContent: null, oldHash: 'missing', isNew: true })
  const deleted = change('deleted', { seq: 2, turnId: 'second', kind: 'delete', newContent: null, newHash: 'missing' })
  const recreated = change('recreated', { seq: 3, turnId: 'third', oldContent: null, oldHash: 'missing', isNew: true })
  expect(artifactFileIsDeleted(sessionId, created.path, [created, deleted], root)).toBe(true)
  expect(artifactFileIsDeleted(sessionId, created.path, [created, { ...deleted, status: 'kept' }], root)).toBe(true)
  expect(artifactFileIsDeleted(sessionId, deleted.path, [recreated, deleted, created], root)).toBe(false)
  expect(artifactFileIsDeleted(sessionId, created.path, [created, { ...deleted, status: 'reverted' }], root)).toBe(false)
  expect(artifactFileIsDeleted(sessionId, created.path, [created, deleted, { ...recreated, status: 'reverted' }], root)).toBe(true)
  expect(artifactFileIsDeleted(sessionId, created.path, [{ ...deleted, status: 'reverted' }], root)).toBe(false)
})

test('撤回完整新增链后原路径不存在，未存档文本本身不能证明删除', () => {
  const created = change('created', { seq: 1, oldContent: null, newContent: null, oldHash: 'missing', truncated: true, status: 'reverted' })
  const edited = change('edited', { seq: 2, oldHash: 'bytes-before', newHash: 'bytes-after', status: 'reverted' })
  expect(artifactFileIsDeleted(sessionId, created.path, [edited, created], root)).toBe(true)
  expect(artifactFileIsDeleted(sessionId, created.path, [{ ...created, oldHash: undefined, isNew: true }], root)).toBe(true)
  expect(artifactFileIsDeleted(sessionId, created.path, [{ ...created, oldHash: undefined, isNew: undefined }], root)).toBe(false)
  expect(artifactFileIsDeleted(sessionId, created.path, [{ ...created, status: 'pending', oldHash: undefined }], root)).toBe(false)
})

test('删除状态隔离会话和路径并沿用 Windows 路径归一化', () => {
  const deleted = change('deleted', { kind: 'delete', newContent: null })
  const foreign = { ...deleted, id: 'foreign', seq: 10, sessionId: 'other-session', kind: 'write' as const }
  const otherPath = { ...deleted, id: 'other-path', path: `${root}/other.md`, seq: 11, kind: 'write' as const }
  expect(artifactFileIsDeleted(sessionId, 'D:\\WORKSPACE\\PROJECT\\REPORT.MD', [foreign, otherPath, deleted], root)).toBe(true)
  expect(artifactFileIsDeleted(sessionId, deleted.path, [foreign, otherPath], root)).toBe(false)
  expect(artifactFileIsDeleted(sessionId, deleted.path, [], root)).toBe(false)
})

test('整个会话抵消跨轮新增后删除，单轮记录和精确历史入口保持可见', () => {
  const created = change('created', { seq: 1, turnId: 'first', kind: 'write', oldContent: null, oldHash: 'missing', newHash: 'image-a', isNew: true })
  const deleted = change('deleted', { seq: 2, turnId: 'second', kind: 'delete', oldHash: 'image-a', newHash: 'missing', newContent: null })
  const records = [deleted, created]
  const sessionFiles = buildSessionArtifactFiles(sessionId, records, [], root)
  expect(filterSessionArtifactFiles(sessionFiles)).toEqual([])
  expect(filterSessionArtifactFiles(sessionFiles, sessionFiles[0].key)).toEqual(sessionFiles)
  expect(resolveArtifactChoice(filterSessionArtifactFiles(sessionFiles, sessionFiles[0].key), sessionId,
    { kind: 'request', request: { sessionId, path: created.path, changeId: created.id, revision: 1 } }, root)?.view?.change).toEqual(created)
  const turn = scopeArtifactChanges(sessionId, records, [], { kind: 'turn', turnId: 'second' })
  expect(buildSessionArtifactFiles(sessionId, turn.records, turn.net, root)[0].operations).toEqual([deleted])
  expect(records).toEqual([deleted, created])
})

test('已有文件删除保留 D，重建仍可见，kept 不改变最终缺失状态', () => {
  const created = change('created', { seq: 1, oldContent: null, oldHash: 'missing', newHash: 'a', isNew: true, status: 'kept' })
  const deleted = change('deleted', { seq: 2, kind: 'delete', oldHash: 'a', newHash: 'missing', newContent: null, status: 'kept' })
  const recreated = change('recreated', { seq: 3, oldContent: null, oldHash: 'missing', newHash: 'b', isNew: true })
  const files = (records: EngineFileChange[]): WorkSessionArtifactFile[] => buildSessionArtifactFiles(sessionId, records, [], root)
  expect(filterSessionArtifactFiles(files([created, deleted]))).toEqual([])
  expect(filterSessionArtifactFiles(files([deleted]))).toHaveLength(1)
  expect(filterSessionArtifactFiles(files([created, deleted, recreated]))).toHaveLength(1)
  expect(filterSessionArtifactFiles(files([{ ...created, oldContent: 'original', oldHash: 'original', isNew: false }, deleted]))).toHaveLength(1)
})

test('旧回执凭明确新增和删除抵消，缺少新增证据或已知版本断链则保留', () => {
  const created = change('created', { seq: 1, oldContent: null, newContent: null, truncated: true, isNew: true })
  const deleted = change('deleted', { seq: 2, kind: 'delete', oldContent: null, newContent: null, truncated: true })
  const filter = (records: EngineFileChange[]): WorkSessionArtifactFile[] => filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, records, [], root))
  expect(filter([created, deleted])).toEqual([])
  expect(filter([{ ...created, isNew: undefined }, deleted])).toHaveLength(1)
  expect(filter([{ ...created, oldHash: 'existing-version' }, deleted])).toHaveLength(1)
  expect(filter([{ ...created, oldHash: 'missing', newHash: 'created-version' }, { ...deleted, oldHash: 'external-version', newHash: 'missing' }])).toHaveLength(1)
  expect(filter([created, { ...created, id: 'second-create', seq: 2 }, { ...deleted, seq: 3 }])).toHaveLength(1)
  expect(filter([created, { ...deleted, newHash: 'still-exists' }])).toHaveLength(1)
})

test('连续撤回尾链按最后有效版本判断，撤回删除可恢复文件，撤回新建则抵消', () => {
  const created = change('created', { seq: 1, oldContent: null, oldHash: 'missing', newHash: 'a', isNew: true })
  const deleted = change('deleted', { seq: 2, kind: 'delete', oldHash: 'a', newHash: 'missing', newContent: null })
  const recreated = change('recreated', { seq: 3, oldContent: null, oldHash: 'missing', newHash: 'b', isNew: true })
  const filter = (records: EngineFileChange[]): WorkSessionArtifactFile[] => filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, records, [], root))
  expect(filter([created, { ...deleted, status: 'reverted' }])).toHaveLength(1)
  expect(filter([{ ...created, status: 'reverted' }])).toEqual([])
  expect(filter([{ ...created, status: 'reverted' }, { ...deleted, status: 'reverted' }])).toEqual([])
  expect(filter([created, deleted, { ...recreated, status: 'reverted' }])).toEqual([])
  expect(filter([{ ...created, oldHash: undefined, newHash: undefined, status: 'reverted' }])).toEqual([])
})

test('撤回后重建的新链必须连到还原版本，证据不足或外部改动不隐藏', () => {
  const created = change('created', { seq: 1, oldContent: null, oldHash: 'missing', newHash: 'a', isNew: true, status: 'reverted' })
  const recreated = change('recreated', { seq: 2, oldContent: null, oldHash: 'missing', newHash: 'b', isNew: true })
  const deleted = change('deleted', { seq: 3, kind: 'delete', oldHash: 'b', newHash: 'missing', newContent: null })
  const filter = (records: EngineFileChange[]): WorkSessionArtifactFile[] => filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, records, [], root))
  expect(filter([created, recreated, deleted])).toEqual([])
  expect(filter([{ ...created, newHash: undefined }, recreated, deleted])).toHaveLength(1)
  expect(filter([created, { ...recreated, oldHash: 'external-version', isNew: false }, deleted])).toHaveLength(1)
  expect(filter([{ ...created, status: 'pending' }, { ...recreated, oldHash: 'a', isNew: false, status: 'reverted' }, { ...deleted, oldHash: 'a' }])).toEqual([])
})

test('现场投影报路径变化或磁盘冲突时保留已抵消文件，不能用历史隐藏异常', () => {
  const created = change('created', { seq: 1, oldContent: null, oldHash: 'missing', newHash: 'a', isNew: true })
  const deleted = change('deleted', { seq: 2, kind: 'delete', oldHash: 'a', newHash: 'missing', newContent: null })
  const projection = { ...deleted, oldHash: 'missing', isNew: false, changeIds: ['created', 'deleted'] }
  const filter = (net: EngineFileChange[]): WorkSessionArtifactFile[] => filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, [created, deleted], net, root))
  expect(filter([projection])).toEqual([])
  for (const projectionIssue of ['disk-diverged', 'path-changed', 'unreadable', 'discontinuous-history', 'later-change'] as const) {
    expect(filter([{ ...projection, projectionIssue }]), projectionIssue).toHaveLength(1)
  }
  const files = buildSessionArtifactFiles(sessionId, [created, { ...deleted, projectionIssue: 'unreadable' }], [], root)
  expect(filterSessionArtifactFiles(files)).toHaveLength(1)
})

test('二进制缺少内容快照但完整版本闭环仍抵消，缺版本或现场冲突不抵消', () => {
  const created = change('created', { seq: 1, path: `${root}/image.png`, oldContent: null, newContent: null,
    oldHash: 'missing', newHash: 'binary-a', isNew: true, truncated: true, projectionIssue: 'snapshot-unavailable' })
  const deleted = change('deleted', { seq: 2, path: created.path, kind: 'delete', oldContent: null, newContent: null,
    oldHash: 'binary-a', newHash: 'missing', truncated: true, projectionIssue: 'snapshot-unavailable' })
  const projection = { ...deleted, oldHash: 'missing', isNew: false, changeIds: ['created', 'deleted'] }
  expect(artifactChangesCancel([created, deleted], [projection])).toBe(true)
  expect(filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, [created, deleted], [projection], root))).toEqual([])
  expect(artifactChangesCancel([created, { ...deleted, oldHash: undefined }], [projection])).toBe(false)
  expect(artifactChangesCancel([created, deleted], [{ ...projection, projectionIssue: 'disk-diverged' }])).toBe(false)
})

test('同轮创建后删除从该轮列表和摘要抵消，上一轮创建而本轮删除保留 D', () => {
  const created = change('created', { seq: 1, turnId: 'first', oldContent: null, oldHash: 'missing', newHash: 'a', isNew: true })
  const deleted = change('deleted', { seq: 2, turnId: 'first', kind: 'delete', oldHash: 'a', newHash: 'missing', newContent: null })
  const sameTurn = scopeArtifactChanges(sessionId, [created, deleted], [], { kind: 'turn', turnId: 'first' })
  expect(artifactChangesCancel(sameTurn.records)).toBe(true)
  expect(filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, sameTurn.records, sameTurn.net, root))).toEqual([])
  const crossTurn = scopeArtifactChanges(sessionId, [created, { ...deleted, turnId: 'second' }], [], { kind: 'turn', turnId: 'second' })
  expect(artifactChangesCancel(crossTurn.records)).toBe(false)
  const files = filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, crossTurn.records, crossTurn.net, root))
  expect(files).toHaveLength(1)
  expect(files[0].operations[0].kind).toBe('delete')
  expect(artifactChangesCancel([created, { ...deleted, turnId: 'second' }])).toBe(true)
})

test('净投影和日志的存在性版本冲突或来源未同步时不隐藏文件', () => {
  const created = change('created', { seq: 1, oldContent: null, oldHash: 'missing', newHash: 'a', isNew: true })
  const deleted = change('deleted', { seq: 2, kind: 'delete', oldHash: 'a', newHash: 'missing', newContent: null })
  const projection = { ...deleted, oldHash: 'missing', isNew: false, changeIds: ['created', 'deleted'] }
  const filter = (net: EngineFileChange[]): WorkSessionArtifactFile[] => filterSessionArtifactFiles(buildSessionArtifactFiles(sessionId, [created, deleted], net, root))
  expect(filter([{ ...projection, kind: 'write', newHash: 'restored' }])).toHaveLength(1)
  expect(filter([{ ...projection, newHash: 'exists' }])).toHaveLength(1)
  expect(filter([{ ...projection, oldHash: 'pre-existing-file' }])).toHaveLength(1)
  expect(filter([{ ...projection, changeIds: ['created', 'not-yet-synchronized'] }])).toHaveLength(1)
  expect(filter([{ ...created, isNew: false, changeIds: ['created'] }])).toHaveLength(1)
  const stale = buildSessionArtifactFiles(sessionId, [created, { ...deleted, status: 'kept' }], [projection], root)
  expect(filterSessionArtifactFiles(stale)).toHaveLength(1)
})

test('旧的待确认片段不冒充最终状态，完整日志中的后续保留删除仍抵消创建', () => {
  const created = change('created', { seq: 1, oldContent: null, oldHash: 'missing', newHash: 'a', isNew: true })
  const deleted = change('deleted', { seq: 2, kind: 'delete', oldHash: 'a', newHash: 'missing', newContent: null, status: 'kept' })
  const previousSegment = { ...created, changeIds: ['created'], projectionIssue: 'later-change' as const }
  const files = buildSessionArtifactFiles(sessionId, [created, deleted], [previousSegment], root)
  expect(filterSessionArtifactFiles(files)).toEqual([])
})

test('持久记录先核对会话再合并，同 ID 外来记录不能污染当前会话', () => {
  const owned = change('same', { newContent: 'owned\n', status: 'kept' })
  const foreign = change('same', { sessionId: 'work-other', newContent: 'foreign\n', status: 'reverted' })
  for (const rows of [[foreign, owned], [owned, foreign]]) {
    expect(ownedArtifactChanges(sessionId, rows)).toEqual([owned])
    const files = buildSessionArtifactFiles(sessionId, rows, [], root)
    expect(files).toHaveLength(1)
    expect(files[0].operations).toEqual([owned])
  }
  expect(owned.status).toBe('kept')
  expect(foreign.status).toBe('reverted')
})

test('无归属、无效 HTTP 响应及空会话不能生成成果', () => {
  const noOwner = change('legacy', { sessionId: undefined })
  expect(ownedArtifactChanges(sessionId, [noOwner, null, 'receipt', { sessionId, id: 'incomplete' }])).toEqual([])
  expect(ownedArtifactChanges('', [change('mine')])).toEqual([])
  for (const value of [null, undefined, { rows: [change('mine')] }, '[]']) {
    expect(ownedArtifactChanges(sessionId, value)).toEqual([])
    expect(buildSessionArtifactFiles(sessionId, value, value, root)).toEqual([])
  }
  expect(buildSessionArtifactFiles(sessionId, [noOwner], [noOwner], root)).toEqual([])
})

test('成果文件相对服务端实际工作区展示，根外路径保留完整位置且不隐藏内部目录', () => {
  const workspaceRoot = 'D:/dev/ai-agent-engine/.tmp/aether-code-dev/build/dist/workspace/default/work-home-123'
  const files = buildSessionArtifactFiles(sessionId, [
    change('inside', { path: `${workspaceRoot}/docs/report.md` }),
    change('windows-alias', { path: `${workspaceRoot.toUpperCase().replace(/\//g, '\\')}\\Report.md` }),
    change('internal', { path: `${workspaceRoot}/.ae/tmp/file-writes/proof.md` }),
    change('external', { path: `${workspaceRoot}-other/docs/report.md` })
  ], [], workspaceRoot)
  expect(Object.fromEntries(files.map(file => [file.operations[0].id, file.displayPath]))).toEqual({
    inside: 'docs/report.md', 'windows-alias': 'Report.md', internal: '.ae/tmp/file-writes/proof.md',
    external: `${workspaceRoot}-other/docs/report.md`
  })
  expect(buildSessionArtifactFiles(sessionId, [change('posix-root', { path: '/docs/report.md' })], [], '/')[0].displayPath).toBe('docs/report.md')
  expect(buildSessionArtifactFiles(sessionId, [change('posix-case', { path: '/Workspace/report.md' })], [], '/workspace')[0].displayPath).toBe('/Workspace/report.md')
  expect(buildSessionArtifactFiles(sessionId, [change('unc', { path: '\\\\server\\share\\work\\docs\\report.md' })], [], '//SERVER/share/work')[0].displayPath).toBe('docs/report.md')
})

test('Windows 完整路径规范化去重，不把同名文件或相似目录前缀合在一起', () => {
  const files = buildSessionArtifactFiles(sessionId, [
    change('old', { path: 'D:\\workspace\\project\\sales\\report.md', seq: 1 }),
    change('latest', { path: 'd:/WORKSPACE/project/sales/./draft/../report.md', seq: 2 }),
    change('relative', { path: './sales/report.md', seq: 3 }),
    change('other-dir', { path: 'support/report.md', seq: 4 }),
    change('other-root', { path: 'D:/workspace/project-backup/sales/report.md', seq: 5 })
  ], [], root)
  expect(files).toHaveLength(3)
  const sales = files.find(file => file.key === 'd:/workspace/project/sales/report.md')!
  expect(sales.operations.map(item => item.id)).toEqual(['relative', 'latest', 'old'])
  expect(files.find(file => file.key === 'd:/workspace/project/support/report.md')?.operations.map(item => item.id)).toEqual(['other-dir'])
  expect(files.find(file => file.key === 'd:/workspace/project-backup/sales/report.md')?.operations.map(item => item.id)).toEqual(['other-root'])
})

test('操作以服务器 seq 排最新，输入倒序和旧时间戳不会把最新改动覆盖成旧记录', () => {
  const rows = [
    change('newest', { seq: 12, createdAt: 1, newContent: 'latest bytes\n' }),
    change('old', { seq: 10, createdAt: 900, newContent: 'old bytes\n' }),
    change('middle', { seq: 11, createdAt: 500 })
  ]
  const files = buildSessionArtifactFiles(sessionId, rows, [], root)
  expect(files[0].operations.map(item => item.id)).toEqual(['newest', 'middle', 'old'])
  expect(defaultArtifactView(files[0])).toMatchObject({ scope: 'operation', change: { id: 'newest', newContent: 'latest bytes\n' } })
  expect(rows.map(item => item.id)).toEqual(['newest', 'old', 'middle'])
  const legacy = buildSessionArtifactFiles(sessionId, [change('early', { createdAt: 1 }), change('later', { createdAt: 2 })], [], root)
  expect(legacy[0].operations.map(item => item.id)).toEqual(['later', 'early'])
})

test('同路径服务器净变化段保留精确 changeIds 与轮次边界，不拼成伪快照', () => {
  const early = change('net-early', {
    seq: 2, turnId: 'turn-a', changeIds: ['a1', 'a2'], oldContent: 'A\n', newContent: 'B\n'
  })
  const later = change('net-later', {
    seq: 5, turnId: 'turn-b', changeIds: ['b1'], oldContent: 'external\n', newContent: 'C\n',
    projectionIssue: 'discontinuous-history'
  })
  const files = buildSessionArtifactFiles(sessionId, [change('a1')], [
    early, later, change('already-kept', { status: 'kept' }),
    change('foreign-net', { sessionId: 'work-other', changeIds: ['foreign'] })
  ], root)
  expect(files).toHaveLength(1)
  expect(files[0].net).toEqual([later, early])
  expect(files[0].net.map(item => item.changeIds)).toEqual([['b1'], ['a1', 'a2']])
  expect(defaultArtifactView(files[0])).toMatchObject({ scope: 'net', change: { id: 'net-later', oldContent: 'external\n' } })
  expect(files[0].operations.map(item => item.id)).toEqual(['a1'])
})

test('工具点击严格选中指定操作，找不到 changeId 时不显示另一条差异', () => {
  const files = buildSessionArtifactFiles(sessionId, [
    change('old', { seq: 1, newContent: 'old result\n' }),
    change('latest', { seq: 2, newContent: 'latest result\n' }),
    change('another-file', { path: `${root}/other.md`, seq: 3 })
  ], [change('net', { changeIds: ['old', 'latest'] })], root)
  const request = { sessionId, path: '.\\report.md', changeId: 'old', revision: 1 }
  expect(resolveArtifactChoice(files, sessionId, { kind: 'request', request }, root)?.view)
    .toMatchObject({ scope: 'operation', change: { id: 'old', newContent: 'old result\n' } })
  const absent = resolveArtifactChoice(files, sessionId, { kind: 'request', request: { ...request, changeId: 'missing' } }, root)
  expect(absent?.file.key).toBe('d:/workspace/project/report.md')
  expect(absent?.view).toBeNull()
  expect(resolveArtifactChoice(files, sessionId, { kind: 'request', request: { ...request, changeId: 'another-file' } }, root)?.view).toBeNull()
})

test('相同路径的外来会话选择也被拒绝，缺失文件不能跳到首个成果', () => {
  const files = buildSessionArtifactFiles(sessionId, [change('mine')], [], root)
  expect(resolveArtifactChoice(files, sessionId, {
    kind: 'request', request: { sessionId: 'work-other', path: `${root}/report.md`, changeId: 'mine', revision: 2 }
  }, root)).toBeNull()
  expect(resolveArtifactChoice(files, sessionId, {
    kind: 'request', request: { sessionId, path: `${root}/missing.md`, revision: 3 }
  }, root)).toBeNull()
  expect(resolveArtifactChoice([], sessionId, null, root)).toBeNull()
})

test('查看全部请求无需路径，精确请求必须等同会话同路径的持久记录', () => {
  const own = change('mine'), wrongPath = change('mine', { path: `${root}/wrong.md` })
  const request = { sessionId, path: '.\\report.md', changeId: 'mine', revision: 1, view: 'operation' as const }
  expect(artifactSelectionAvailable(sessionId, [], request, root)).toBe(false)
  expect(artifactSelectionAvailable(sessionId, [wrongPath], request, root)).toBe(false)
  expect(artifactSelectionAvailable(sessionId, [{ ...own, sessionId: 'work-other' }], request, root)).toBe(false)
  expect(artifactSelectionAvailable(sessionId, [{ ...own, sessionId: undefined }], request, root)).toBe(false)
  expect(artifactSelectionAvailable(sessionId, [own], request, root)).toBe(true)
  expect(artifactSelectionAvailable(sessionId, [own], { ...request, changeId: 'missing' }, root)).toBe(false)
  expect(artifactSelectionAvailable(sessionId, [own], { ...request, changeId: undefined, view: 'current' }, root)).toBe(true)
  const all = { sessionId, revision: 2, view: 'net' as const, turnScope: { kind: 'session' as const } }
  expect(artifactSelectionAvailable(sessionId, [], all, root)).toBe(true)
  expect(artifactSelectionAvailable(sessionId, [own], { ...all, sessionId: 'work-other' }, root)).toBe(false)
  const files = buildSessionArtifactFiles(sessionId, [own], [], root)
  expect(resolveArtifactChoice(files, sessionId, { kind: 'request', request: all }, root)?.file).toBe(files[0])
  expect(resolveArtifactChoice([], sessionId, { kind: 'request', request: all }, root)).toBeNull()
})

test('当前内容只传文件身份，不把历史正文或删除状态当成当前文件', () => {
  const deleted = change('deleted', { kind: 'delete', status: 'kept', oldContent: 'historical text', newContent: null })
  const file = buildSessionArtifactFiles(sessionId, [deleted], [], root)[0]
  const current = currentArtifactForFile(file)
  expect(current).toMatchObject({ path: deleted.path, name: 'report.md', content: null, status: 'ready' })
  expect(current.id).not.toBe(deleted.id)
  const reverted = { ...file, operations: [{ ...deleted, status: 'reverted' as const }] }
  expect(currentArtifactForFile(reverted).id).not.toBe(current.id)
  expect(currentArtifactForFile({ ...file, operations: [change('write', { newContent: 'old receipt' })] }).content).toBeNull()
})

test('本地视图的净变化已保留后消失，可回到同文件最新操作而不复活旧净段', () => {
  const files = buildSessionArtifactFiles(sessionId, [
    change('old', { seq: 1 }), change('latest', { seq: 2, status: 'kept' })
  ], [], root)
  expect(resolveArtifactChoice(files, sessionId, {
    kind: 'view', fileKey: files[0].key, scope: 'net', changeId: 'removed-net'
  }, root)).toMatchObject({ file: { key: files[0].key }, view: { scope: 'operation', change: { id: 'latest', status: 'kept' } } })
  expect(resolveArtifactChoice(files, sessionId, {
    kind: 'request', request: { sessionId, path: `${root}/report.md`, revision: 4 }
  }, root)?.view).toMatchObject({ scope: 'operation', change: { id: 'latest' } })
})

test('单次与净变化对相同版本使用相同增删统计，新增和删除保留准确行数', () => {
  const operation = change('operation', { oldContent: 'keep\nold\n', newContent: 'keep\nnew\nextra\n' })
  const net = change('net', { ...operation, id: 'net', changeIds: ['operation'] })
  expect(artifactChangeStats(operation)).toEqual({ added: 2, removed: 1, approximate: false })
  expect(artifactChangeStats(net)).toEqual(artifactChangeStats(operation))
  expect(artifactChangeStats(change('new', { isNew: true, oldContent: null, newContent: 'one\ntwo' })))
    .toEqual({ added: 2, removed: 0, approximate: false })
  expect(artifactChangeStats(change('delete', { kind: 'delete', oldContent: 'one\ntwo\n', newContent: null })))
    .toEqual({ added: 0, removed: 2, approximate: false })
})

test('缺快照统计为 null，不能冒充零改动；完整空文件才是真正零行', () => {
  for (const item of [
    change('truncated', { truncated: true }),
    change('no-old', { isNew: false, oldContent: null }),
    change('known-prior-version', { isNew: undefined, oldContent: null, oldHash: 'known-prior-hash', newContent: 'present' }),
    change('no-new', { newContent: null }),
    change('missing-delete', { kind: 'delete', oldContent: null, newContent: null }),
    change('missing-create', { isNew: true, oldContent: null, newContent: null })
  ]) expect(artifactChangeStats(item)).toBeNull()
  expect(artifactChangeStats(change('empty-new', { isNew: true, oldContent: null, newContent: '' })))
    .toEqual({ added: 0, removed: 0, approximate: false })
  expect(artifactChangeStats(change('known-missing-before', { isNew: undefined, oldContent: null, oldHash: 'missing', newContent: 'one\ntwo\n' })))
    .toEqual({ added: 2, removed: 0, approximate: false })
  expect(artifactChangeStats(change('unchanged', { oldContent: 'same\n', newContent: 'same\n' })))
    .toEqual({ added: 0, removed: 0, approximate: false })
})

test('成果树目录在前、文件自然排序，重复路径不重复叶子且不同目录同名独立', () => {
  const files = buildSessionArtifactFiles(sessionId, [
    change('root-10', { path: `${root}/file10.md` }),
    change('root-2', { path: `${root}/file2.md` }),
    change('nested-10', { path: `${root}/src/file10.md` }),
    change('nested-2', { path: `${root}/src/file2.md` }),
    change('other', { path: `${root}/docs/file2.md` })
  ], [], root)
  const tree = buildSessionArtifactTree([...files, files[0]])
  expect(tree.map(node => node.name)).toEqual(['docs', 'src', 'file2.md', 'file10.md'])
  expect(tree.map(node => node.depth)).toEqual([0, 0, 0, 0])
  expect(tree[1].children.map(node => node.name)).toEqual(['file2.md', 'file10.md'])
  expect(tree[1].children.map(node => node.depth)).toEqual([1, 1])
  expect(tree[0].children[0].file?.key).toBe('d:/workspace/project/docs/file2.md')
  expect(tree[1].children[0].file?.key).toBe('d:/workspace/project/src/file2.md')
  expect(tree.flatMap(node => node.file ? [node] : node.children)).toHaveLength(5)
})

test('无变化轮询复用原记录和整数组，字段顺序与新建的标量数组不影响相等性', () => {
  const previous = [change('first', { oldHash: 'old', newHash: 'new', changeIds: ['earlier', 'first'],
    seq: 2, runId: 'run-a', turnId: 'turn-a', toolCallId: 'tool-a', displayPath: 'report.md', isNew: false }),
  change('second', { path: `${root}/second.md`, status: 'kept' })]
  const next = previous.map(row => Object.fromEntries(Object.entries(structuredClone(row)).reverse()) as EngineFileChange)
  expect(next[0]).not.toBe(previous[0])
  expect(next[0].changeIds).not.toBe(previous[0].changeIds)
  expect(reconcileArtifactChanges(previous, next)).toBe(previous)
  expect(reconcileArtifactChanges(previous, previous)).toBe(previous)
  const empty: EngineFileChange[] = []
  expect(reconcileArtifactChanges(empty, [])).toBe(empty)
})

test('快照内容、版本、状态、归属和净变化链任一字段改变都采用新记录', () => {
  const original = change('original', { source: 'command-observation', commandJobId: 'job', requiresExplicitRevert: true,
    changeIds: ['first', 'original'], projectionIssue: 'disk-diverged', turnId: 'turn', runId: 'run', seq: 2,
    oldHash: 'old', newHash: 'new', displayPath: 'report.md', isNew: false, toolCallId: 'tool' })
  const patches: Partial<EngineFileChange>[] = [
    { id: 'other' }, { sessionId: 'work-other' }, { commandJobId: 'other-job' }, { requiresExplicitRevert: false },
    { changeIds: ['original', 'first'] }, { changeIds: ['first'] }, { projectionIssue: 'later-change' },
    { turnId: 'other-turn' }, { runId: 'other-run' }, { seq: 3 }, { oldHash: 'other-old' }, { newHash: 'other-new' },
    { path: `${root}/other.md` }, { kind: 'delete' }, { oldContent: null }, { oldContent: 'replaced\n' },
    { newContent: null }, { newContent: 'replaced\n' }, { truncated: true }, { status: 'kept' },
    { status: 'reverted' }, { createdAt: 2 }, { displayPath: 'renamed.md' }, { isNew: true }, { toolCallId: 'other-tool' }
  ]
  for (const patch of patches) {
    const next = { ...original, ...patch }
    const reconciled = reconcileArtifactChanges([original], [next])
    expect(reconciled[0], JSON.stringify(patch)).toBe(next)
  }
  expect(original.status).toBe('pending')
  expect(original.changeIds).toEqual(['first', 'original'])
})

test('可选字段删除、增加及显式undefined不能被旧记录覆盖', () => {
  const original = change('optional', { source: 'command-observation', commandJobId: 'job', requiresExplicitRevert: true,
    changeIds: ['optional'], projectionIssue: 'unreadable', turnId: 'turn', runId: 'run', seq: 1,
    oldHash: 'old', newHash: 'new', displayPath: 'report.md', isNew: false, toolCallId: 'tool' })
  for (const key of ['sessionId', 'source', 'commandJobId', 'requiresExplicitRevert', 'changeIds', 'projectionIssue',
    'turnId', 'runId', 'seq', 'oldHash', 'newHash', 'displayPath', 'isNew', 'toolCallId'] as const) {
    const removed = { ...original }
    delete removed[key]
    expect(reconcileArtifactChanges([original], [removed])[0], key).toBe(removed)
    expect(reconcileArtifactChanges([removed], [original])[0], key).toBe(original)
  }
  const absent = change('undefined'), explicit = { ...absent, isNew: undefined }
  expect(reconcileArtifactChanges([absent], [explicit])[0]).toBe(explicit)
  expect(reconcileArtifactChanges([explicit], [absent])[0]).toBe(absent)
})

test('刷新严格保留新顺序和增删，不复活删除记录或跨会话借用相同ID', () => {
  const first = change('first'), removed = change('removed'), last = change('last')
  const previous = [first, removed, last]
  const added = change('added')
  const next = [{ ...last }, added, { ...first }]
  const result = reconcileArtifactChanges(previous, next)
  expect(result).not.toBe(previous)
  expect(result.map(row => row.id)).toEqual(['last', 'added', 'first'])
  expect(result[0]).toBe(last)
  expect(result[1]).toBe(added)
  expect(result[2]).toBe(first)
  expect(previous).toEqual([first, removed, last])
  expect(reconcileArtifactChanges(previous, [])).toEqual([])
  const foreign = change('first', { sessionId: 'work-other' })
  expect(reconcileArtifactChanges([first], [foreign])[0]).toBe(foreign)
  const foreignClone = { ...foreign }, ownClone = { ...first }
  const both = reconcileArtifactChanges([first, foreign], [foreignClone, ownClone])
  expect(both[0]).toBe(foreign)
  expect(both[1]).toBe(first)
  const legacy = change('legacy', { sessionId: undefined })
  expect(reconcileArtifactChanges([], [legacy])[0]).toBe(legacy)
  expect(reconcileArtifactChanges([first], [legacy])[0]).toBe(legacy)
})

test('未知字段同引用可复用，新的结构对象或对象数组保守更新，标量数组逐项比较', () => {
  const object = { revision: 1 }
  const previous = [{ ...change('metadata'), future: object, scalarFlags: [null, true, 3, 'four'] }]
  expect(reconcileArtifactChanges(previous, [{ ...previous[0], scalarFlags: [null, true, 3, 'four'] }])).toBe(previous)
  const changedObject = { ...previous[0], future: { revision: 1 } }
  expect(reconcileArtifactChanges(previous, [changedObject])[0]).toBe(changedObject)
  const objects = { ...change('objects'), future: [object] }
  const clonedArray = { ...objects, future: [object] }
  expect(reconcileArtifactChanges([objects], [clonedArray])[0]).toBe(clonedArray)
  const scalarChange = { ...previous[0], scalarFlags: [null, false, 3, 'four'] }
  expect(reconcileArtifactChanges(previous, [scalarChange])[0]).toBe(scalarChange)
  const futureAdded = { ...change('new-field'), future: 'new' }
  expect(reconcileArtifactChanges([change('new-field')], [futureAdded])[0]).toBe(futureAdded)
})

test('成果树保留Windows目录大小写合并及POSIX区分，重复输入仍保留首个叶子', () => {
  const files = buildSessionArtifactFiles(sessionId, [
    change('windows-first', { path: 'D:/project/Src/file2.md' }),
    change('windows-second', { path: 'd:/project/src/file10.md' })
  ], [], 'D:/project')
  const windows = buildSessionArtifactTree(files)
  expect(windows).toHaveLength(1)
  expect(windows[0].children.map(node => node.name)).toEqual(['file2.md', 'file10.md'])
  expect(windows[0].key).toBe('dir:src')
  const posixFiles = buildSessionArtifactFiles(sessionId, [
    change('posix-first', { path: '/project/Src/file.md' }),
    change('posix-second', { path: '/project/src/file.md' })
  ], [], '/project')
  const posix = buildSessionArtifactTree(posixFiles)
  expect(new Set(posix.map(node => node.key))).toEqual(new Set(['dir:Src', 'dir:src']))
  expect(posix.flatMap(node => node.children)).toHaveLength(2)
  const first = files[0], duplicate = { ...first, operations: [change('replacement')] }
  const duplicated = buildSessionArtifactTree([first, duplicate])
  expect(duplicated[0].children).toHaveLength(1)
  expect(duplicated[0].children[0].file).toBe(first)
})

test('成果目录与树使用一致的中英文、大小写和数字自然排序', () => {
  const names = ['file10.md', 'file2.md', 'File2.md', '文件10.md', '文件2.md', 'Alpha.md', 'alpha.md', '报告2.md']
  const expected = ['报告2.md', '文件2.md', '文件10.md', 'alpha.md', 'Alpha.md', 'file2.md', 'File2.md', 'file10.md']
  const files = buildSessionArtifactFiles(sessionId, names.map((name, index) =>
    change(`mixed-${index}`, { path: `/project/${name}` })), [], '/project')
  expect(files.map(file => file.name)).toEqual(expected)
  expect(buildSessionArtifactTree([...files].reverse()).map(node => node.name)).toEqual(expected)
})

test('成果树的目录与同名文件键互不覆盖，大型平铺目录不丢文件且自然排序', () => {
  const file = (key: string, displayPath: string): WorkSessionArtifactFile => ({
    key, path: key, displayPath, name: displayPath.split('/').at(-1)!, operations: [], net: []
  })
  const sameName = buildSessionArtifactTree([file('/root/docs', 'docs'), file('/root/docs/a.md', 'docs/a.md')])
  expect(sameName.map(node => [node.key, Boolean(node.file)])).toEqual([['dir:docs', false], ['file:/root/docs', true]])
  const files = Array.from({ length: 5000 }, (_, index) => file(`/root/file${4999 - index}.md`, `file${4999 - index}.md`))
  const tree = buildSessionArtifactTree(files)
  expect(tree).toHaveLength(5000)
  expect(tree.map(node => node.name)).toEqual(Array.from({ length: 5000 }, (_, index) => `file${index}.md`))
  expect(new Set(tree.map(node => node.file))).toEqual(new Set(files))
  expect(files[0].name).toBe('file4999.md')
})

test('多文件工具和命令只生成刷新修订，不从路径、产物文本或无归属回执生成成果', () => {
  const first = change('first', { seq: 1, newHash: 'first-hash' })
  const second = change('second', { path: `${root}/two.md`, seq: 2 })
  const third = change('third', { path: `${root}/three.md`, seq: 3 })
  const legacy = change('legacy', { sessionId: undefined, path: `${root}/legacy.md` })
  const tools = [tool({ change: first, changes: [first, second] }),
    tool({ id: 'command', name: 'execute_cmd', commandJob: commandJob({ changes: [third] }) }),
    tool({ id: 'legacy', change: legacy }),
    tool({ id: 'output-only', name: 'office_document', args: '{"path":"report.xlsx"}', result: '{"path":"report.xlsx"}' })]
  expect(JSON.parse(artifactToolRevision(sessionId, tools)).map((entry: unknown[]) => entry[0]))
    .toEqual(['first', 'second', 'third', 'legacy'])
  expect(buildSessionArtifactFiles(sessionId, [], [], root)).toEqual([])
  expect(buildSessionArtifactFiles(sessionId, [legacy], [], root)).toEqual([])
  expect(artifactToolRevision(sessionId, [tools[3]])).toBe('[]')
  expect(artifactToolRevision(sessionId, [tool({ commandJob: commandJob({ sessionId: 'work-other', changes: [third] }) })])).toBe('[]')
})

test('外来同 ID 工具回执不能吞掉本会话刷新，状态和版本变化会改变修订', () => {
  const own = change('same', { seq: 1, newHash: 'a' })
  const foreign = change('same', { sessionId: 'work-other', path: `${root}/foreign.md`, status: 'reverted' })
  const ownRevision = artifactToolRevision(sessionId, [tool({ change: own })])
  expect(artifactToolRevision(sessionId, [tool({ change: foreign }), tool({ changes: [own] })])).toBe(ownRevision)
  expect(artifactToolRevision(sessionId, [tool({ change: own }), tool({ changes: [foreign] })])).toBe(ownRevision)
  expect(artifactToolRevision(sessionId, [tool({ change: { ...own, status: 'kept' } })])).not.toBe(ownRevision)
  expect(artifactToolRevision(sessionId, [tool({ change: { ...own, seq: 2, newHash: 'b' } })])).not.toBe(ownRevision)
})

test('轮次精确绑定 conversationId，同轮补充不增加选项且摘要取最早用户请求', () => {
  const messages = [
    user('steering', { conversationId: 'turn-a', content: '后来的补充', createdAt: 300 }),
    user('original', { conversationId: 'turn-a', content: '  最早请求\n生成报告  ', createdAt: 100 }),
    user('assistant', { role: 'assistant', conversationId: 'turn-a', content: '助手内容不可当请求', createdAt: 50 }),
    user('second-request', { conversationId: 'turn-b', content: '第二轮请求', createdAt: 200 })
  ]
  const options = buildArtifactTurnOptions(sessionId, messages, [
    change('write-a', { turnId: 'turn-a', createdAt: 150 }),
    change('write-b', { turnId: 'turn-b', createdAt: 250 })
  ])
  expect(options.map(option => option.key)).toEqual(['session', 'turn:turn-b', 'turn:turn-a'])
  expect(options.find(option => option.key === 'turn:turn-a')).toEqual({
    key: 'turn:turn-a', scope: { kind: 'turn', turnId: 'turn-a' },
    summary: '最早请求 生成报告', createdAt: 100, timeSource: 'request'
  })
  expect(options.some(option => option.key.includes('original') || option.key.includes('steering'))).toBe(false)
})

test('摘要未加载的已知轮次与真正未关联改动分开，时间只作显示不推断归属', () => {
  const options = buildArtifactTurnOptions(sessionId, [
    user('adjacent', { conversationId: 'visible-turn', content: '附近的请求不是历史摘要', createdAt: 100 }),
    user('no-identity', { content: '恰好同时发生的请求', createdAt: 90 })
  ], [
    change('historical-later', { turnId: 'archived-turn', createdAt: 110 }),
    change('historical-first', { turnId: 'archived-turn', createdAt: 90 }),
    change('unassociated', { createdAt: 100 }),
    change('blank-turn', { turnId: '  ', createdAt: 100 })
  ])
  expect(options.find(option => option.key === 'turn:archived-turn')).toEqual({
    key: 'turn:archived-turn', scope: { kind: 'turn', turnId: 'archived-turn' },
    summary: '历史轮次（请求摘要未加载）', createdAt: 90, timeSource: 'change'
  })
  expect(options.filter(option => option.scope.kind === 'unassociated')).toEqual([
    { key: 'unassociated', scope: { kind: 'unassociated' }, summary: '未关联轮次' }
  ])
  expect(options.filter(option => option.scope.kind === 'turn')).toHaveLength(2)
  expect(artifactChangeTurnScope(change('known', { turnId: 'exact-turn' }))).toEqual({ kind: 'turn', turnId: 'exact-turn' })
  expect(artifactChangeTurnScope(change('unknown', { turnId: '\t' }))).toEqual({ kind: 'unassociated' })
  expect(artifactTurnScopeKey({ kind: 'session' })).toBe('session')
  expect(artifactTurnScopeKey({ kind: 'turn', turnId: 'exact-turn' })).toBe('turn:exact-turn')
  expect(artifactTurnScopeKey({ kind: 'unassociated' })).toBe('unassociated')
})

test('当前会话 run 可补轮次，显式外来 run 和外来日志不能改写请求摘要', () => {
  const messages = [
    user('foreign-earlier', { conversationId: 'shared-turn', content: '外来摘要', createdAt: 1,
      run: run({ sessionId: 'work-other', turnId: 'shared-turn' }) }),
    user('mine', { conversationId: 'shared-turn', content: '当前会话摘要', createdAt: 2 }),
    user('run-only', { content: 'run 绑定请求', createdAt: 3, run: run({ turnId: 'run-turn' }) }),
    user('foreign-only', { content: '外来 run', createdAt: 4, run: run({ sessionId: 'work-other', turnId: 'foreign-turn' }) })
  ]
  const options = buildArtifactTurnOptions(sessionId, messages, [
    change('same-id', { sessionId: 'work-other', turnId: 'foreign-log', createdAt: 0 }),
    change('same-id', { turnId: 'shared-turn', createdAt: 5 }),
    change('unowned-log', { sessionId: undefined, turnId: 'unowned-turn' })
  ])
  expect(options.map(option => option.key)).toEqual(['session', 'turn:run-turn', 'turn:shared-turn'])
  expect(options.find(option => option.key === 'turn:shared-turn')).toMatchObject({
    summary: '当前会话摘要', createdAt: 2, timeSource: 'request'
  })
})

test('跨轮净变化即使继承末次 turnId 也不能纳入任一单轮，未知源 ID 同样拒绝', () => {
  const records = [
    change('a1', { turnId: 'turn-a', seq: 1, oldContent: 'before\n', newContent: 'A\n' }),
    change('b1', { turnId: 'turn-b', seq: 2, oldContent: 'A\n', newContent: 'B\n' })
  ]
  const combined = change('cross-turn', { turnId: 'turn-b', changeIds: ['a1', 'b1'], oldContent: 'before\n', newContent: 'B\n' })
  const unknown = change('unknown-source', { turnId: 'turn-b', changeIds: ['b1', 'not-loaded'] })
  const a = scopeArtifactChanges(sessionId, records, [combined, unknown], { kind: 'turn', turnId: 'turn-a' })
  const b = scopeArtifactChanges(sessionId, records, [combined, unknown], { kind: 'turn', turnId: 'turn-b' })
  expect(a).toEqual({ records: [records[0]], net: [], uncombinedChangeIds: ['a1'] })
  expect(b).toEqual({ records: [records[1]], net: [], uncombinedChangeIds: ['b1'] })
  expect(scopeArtifactChanges(sessionId, records, [combined], { kind: 'session' }))
    .toEqual({ records, net: [combined], uncombinedChangeIds: [] })
})

test('单轮净段仅凭全部源 ID 归属纳入，保留服务器分段及原始快照而不自行合并', () => {
  const records = [
    change('a1', { turnId: 'turn-a', seq: 1, oldContent: 'old\n', newContent: 'middle\n' }),
    change('a2', { turnId: 'turn-a', seq: 2, oldContent: 'middle\n', newContent: 'end\n' }),
    change('a3', { turnId: 'turn-a', seq: 3, oldContent: 'external\n', newContent: 'last\n' }),
    change('kept', { turnId: 'turn-a', status: 'kept' }),
    change('reverted', { turnId: 'turn-a', status: 'reverted' })
  ]
  const first = change('segment-1', { turnId: 'turn-a', changeIds: ['a1', 'a2'], oldContent: 'old\n', newContent: 'end\n' })
  const second = change('segment-2', { turnId: 'turn-a', changeIds: ['a3'], oldContent: 'external\n', newContent: 'last\n', projectionIssue: 'discontinuous-history' })
  const scoped = scopeArtifactChanges(sessionId, records, [first, second], { kind: 'turn', turnId: 'turn-a' })
  expect(scoped.records).toEqual(records)
  expect(scoped.net).toEqual([first, second])
  expect(scoped.uncombinedChangeIds).toEqual([])
  expect(scoped.records.map(item => [item.oldContent, item.newContent])).toEqual(records.map(item => [item.oldContent, item.newContent]))
  expect(scopeArtifactChanges(sessionId, records, [first], { kind: 'turn', turnId: 'turn-a' }).uncombinedChangeIds).toEqual(['a3'])
  const legacyNet = change('a3', { turnId: 'turn-a' })
  expect(scopeArtifactChanges(sessionId, records, [legacyNet], { kind: 'turn', turnId: 'turn-a' }).net).toEqual([legacyNet])
})

test('未关联范围只收真实无 turnId 记录，不按相同时间补归属且始终过滤 foreign', () => {
  const owned = change('same-id', { turnId: undefined, createdAt: 50 })
  const blank = change('blank', { turnId: ' ', createdAt: 50 })
  const associated = change('known', { turnId: 'turn-a', createdAt: 50 })
  const foreign = change('same-id', { sessionId: 'work-other', turnId: 'turn-a', status: 'reverted' })
  const net = change('unassociated-net', { turnId: undefined, changeIds: ['same-id', 'blank'] })
  const foreignNet = change('unassociated-net', { sessionId: 'work-other', changeIds: ['same-id'], status: 'kept' })
  const scoped = scopeArtifactChanges(sessionId, [foreign, owned, blank, associated], [foreignNet, net], { kind: 'unassociated' })
  expect(scoped).toEqual({ records: [owned, blank], net: [net], uncombinedChangeIds: [] })
  expect(scopeArtifactChanges(sessionId, [foreign, owned, associated], [foreignNet, net], { kind: 'turn', turnId: 'turn-a' }))
    .toEqual({ records: [associated], net: [], uncombinedChangeIds: ['known'] })
})

test('成果搜索按完整路径或文件名匹配，大小写与反斜杠兼容且不依赖树是否展开', () => {
  const files = buildSessionArtifactFiles(sessionId, [
    change('sales-first', { path: `${root}/sales/deep/Report.md`, seq: 1 }),
    change('sales-second', { path: `${root}/sales/deep/Report.md`, seq: 2 }),
    change('sales-kept', { path: `${root}/sales/deep/Report.md`, seq: 3, status: 'kept' }),
    change('support', { path: `${root}/support/Report.md` }),
    change('foreign', { sessionId: 'work-other', path: `${root}/sales/deep/Report.md` }),
    change('data', { path: `${root}/sales/deep/data.csv` })
  ], [], root)
  // Tree construction never replaces the full file catalog used for search.
  const tree = buildSessionArtifactTree(files)
  expect(tree.map(node => node.name)).toEqual(['sales', 'support'])
  expect(searchArtifactFiles(files, 'REPORT.MD').map(file => file.key)).toEqual([
    'd:/workspace/project/sales/deep/report.md', 'd:/workspace/project/support/report.md'
  ])
  const selected = searchArtifactFiles(files, 'D:\\WORKSPACE\\PROJECT\\SALES\\DEEP\\REPORT.MD')
  expect(selected).toHaveLength(1)
  expect(searchArtifactFiles(files, 'sales report.md')).toEqual(selected)
  expect(selected.flatMap(file => file.operations).filter(item => item.status === 'pending').map(item => item.id))
    .toEqual(['sales-second', 'sales-first'])
  expect(searchArtifactFiles(files, 'missing-file')).toEqual([])
  expect(searchArtifactFiles(files, '  ')).toEqual(files)
  expect(searchArtifactFiles(files, '  ')).not.toBe(files)
})
