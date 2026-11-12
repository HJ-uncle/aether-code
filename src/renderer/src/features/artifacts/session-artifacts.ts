import type { EngineFileChange } from '@shared/ipc'
import type { ChatMessage, ToolActivity } from '@renderer/core/engine/useChat'
import { mergeFileChanges } from '@renderer/core/engine/tool-file-changes'
import type { DiffStats } from '../conversation/shared/diff'
import { sessionChangePathKey } from './file-changes'
import { sessionFileChangeStats } from './file-change-presentation'
import type { SessionArtifact } from '../sessions/state'

const artifactCollator = new Intl.Collator('zh-CN', { numeric: true })

export interface SessionArtifactSelection {
  sessionId: string
  changeId?: string
  path?: string
  view?: SessionArtifactDetailView
  turnScope?: SessionArtifactTurnScope
  revision: number
}

export type SessionArtifactScope = 'net' | 'operation'
export type SessionArtifactDetailView = 'current' | SessionArtifactScope
export interface SessionArtifactView {
  scope: SessionArtifactScope
  change: EngineFileChange
}
export interface SessionArtifactFile {
  key: string
  path: string
  name: string
  displayPath: string
  operations: EngineFileChange[]
  net: EngineFileChange[]
}
export interface SessionArtifactTreeNode {
  key: string
  name: string
  depth: number
  file?: SessionArtifactFile
  children: SessionArtifactTreeNode[]
}
export type SessionArtifactChoice =
  | { kind: 'request'; request: SessionArtifactSelection }
  | { kind: 'view'; fileKey: string; scope: SessionArtifactScope; changeId: string }

export type SessionArtifactTurnScope = { kind: 'session' } | { kind: 'turn'; turnId: string } | { kind: 'unassociated' }
export interface SessionArtifactTurnOption {
  key: string
  scope: SessionArtifactTurnScope
  summary: string
  createdAt?: number
  timeSource?: 'request' | 'change'
}

export function artifactTurnScopeKey(scope: SessionArtifactTurnScope): string {
  return scope.kind === 'turn' ? `turn:${scope.turnId}` : scope.kind
}

function reliableTurnId(turnId: string | undefined): string | undefined {
  return turnId?.trim() ? turnId : undefined
}

export function artifactChangeTurnScope(change: EngineFileChange): SessionArtifactTurnScope {
  const turnId = reliableTurnId(change.turnId)
  return turnId ? { kind: 'turn', turnId } : { kind: 'unassociated' }
}

/** Request time is display metadata, never evidence linking a write to a turn. */
export function buildArtifactTurnOptions(sessionId: string, messages: readonly ChatMessage[], log: unknown): SessionArtifactTurnOption[] {
  const turns = new Map<string, SessionArtifactTurnOption>()
  const records = ownedArtifactChanges(sessionId, log)
  for (const change of records) {
    const scope = artifactChangeTurnScope(change)
    if (scope.kind !== 'turn') continue
    const key = artifactTurnScopeKey(scope)
    const existing = turns.get(key)
    if (!existing || change.createdAt < (existing.createdAt ?? Infinity)) {
      turns.set(key, { key, scope, summary: '历史轮次（请求摘要未加载）', createdAt: change.createdAt, timeSource: 'change' })
    }
  }
  for (const message of messages) {
    if (message.role !== 'user' || message.run && message.run.sessionId !== sessionId) continue
    const turnId = reliableTurnId(message.conversationId) ??
      (message.run?.sessionId === sessionId ? reliableTurnId(message.run.turnId) : undefined)
    if (!turnId) continue
    const scope: SessionArtifactTurnScope = { kind: 'turn', turnId }
    const key = artifactTurnScopeKey(scope)
    const existing = turns.get(key)
    if (existing?.timeSource === 'request' && (existing.createdAt ?? Infinity) <= message.createdAt) continue
    const request = message.content.replace(/\s+/g, ' ').trim()
    const summary = request ? request.length > 72 ? `${request.slice(0, 72)}…` : request
      : message.attachments?.length ? `附件：${message.attachments.map(item => item.name).join('、')}` : '无文字请求'
    turns.set(key, { key, scope, summary, createdAt: message.createdAt, timeSource: 'request' })
  }
  const options: SessionArtifactTurnOption[] = [{ key: 'session', scope: { kind: 'session' }, summary: '整个会话' },
    ...[...turns.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.key.localeCompare(b.key))]
  if (records.some(change => !reliableTurnId(change.turnId))) options.push({ key: 'unassociated', scope: { kind: 'unassociated' }, summary: '未关联轮次' })
  return options
}

export function scopeArtifactChanges(sessionId: string, log: unknown, net: unknown, scope: SessionArtifactTurnScope): {
  records: EngineFileChange[]; net: EngineFileChange[]; uncombinedChangeIds: string[]
} {
  const owned = ownedArtifactChanges(sessionId, log)
  const pending = ownedArtifactChanges(sessionId, net).filter(change => change.status === 'pending')
  if (scope.kind === 'session') return { records: owned, net: pending, uncombinedChangeIds: [] }
  const scopeKey = artifactTurnScopeKey(scope)
  const records = owned.filter(change => artifactTurnScopeKey(artifactChangeTurnScope(change)) === scopeKey)
  const ids = new Set(records.map(change => change.id))
  // The projection inherits its final write's turnId. Only all source IDs can
  // prove that a net snapshot belongs entirely to this selected turn.
  const scopedNet = pending.filter(change => (change.changeIds?.length ? change.changeIds : [change.id]).every(id => ids.has(id)))
  const combined = new Set(scopedNet.flatMap(change => change.changeIds?.length ? change.changeIds : [change.id]))
  return { records, net: scopedNet, uncombinedChangeIds: records.filter(change => change.status === 'pending' && !combined.has(change.id)).map(change => change.id) }
}

/** Search before the tree is flattened so collapsed folders cannot hide hits. */
export function searchArtifactFiles(files: readonly SessionArtifactFile[], query: string): SessionArtifactFile[] {
  const words = query.trim().replace(/\\/g, '/').toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? files.filter(file => {
    const haystack = `${file.name}\n${file.displayPath}\n${file.path}\n${file.key}`.replace(/\\/g, '/').toLocaleLowerCase()
    return words.every(word => haystack.includes(word))
  }) : [...files]
}

/** HTTP rows must prove ownership; legacy tool receipts only trigger a refresh. */
export function ownedArtifactChanges(sessionId: string, value: unknown): EngineFileChange[] {
  if (!sessionId || !Array.isArray(value)) return []
  return mergeFileChanges(value.filter(row => row && typeof row === 'object' && row.sessionId === sessionId))
}

/** A streamed receipt can arrive before its durable record. Only the owned
 * ledger may satisfy navigation; a same-ID record at another path cannot. */
export function artifactSelectionAvailable(sessionId: string, log: unknown, selection: SessionArtifactSelection, root?: string | null): boolean {
  if (selection.sessionId !== sessionId) return false
  if (!selection.path) return true
  const key = sessionChangePathKey(selection.path, root)
  return ownedArtifactChanges(sessionId, log).some(change => sessionChangePathKey(change.path, root) === key &&
    (!selection.changeId || change.id === selection.changeId))
}

function sameArtifactField(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false
  const keys = Reflect.ownKeys(previous)
  if (keys.length !== Reflect.ownKeys(next).length) return false
  return keys.every(key => {
    if (!Object.prototype.hasOwnProperty.call(next, key)) return false
    const before: unknown = Reflect.get(previous, key)
    const after: unknown = Reflect.get(next, key)
    // Wire arrays contain scalar IDs. Unknown structured metadata must not be
    // treated as unchanged just because its shallow shape looks familiar.
    return (before === null || typeof before !== 'object' && typeof before !== 'function') && Object.is(before, after)
  })
}

function sameArtifactChange(previous: EngineFileChange, next: EngineFileChange): boolean {
  if (previous === next) return true
  const keys = Reflect.ownKeys(previous)
  return keys.length === Reflect.ownKeys(next).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(next, key) && sameArtifactField(Reflect.get(previous, key), Reflect.get(next, key)))
}

/** Polls often return identical JSON with new identities. Preserve the previous
 * snapshot only when every field still agrees, including removed optional data. */
export function reconcileArtifactChanges(previous: EngineFileChange[], next: EngineFileChange[]): EngineFileChange[] {
  if (previous === next) return previous
  const bySession = new Map<string | undefined, Map<string, EngineFileChange>>()
  for (const change of previous) {
    let records = bySession.get(change.sessionId)
    if (!records) { records = new Map(); bySession.set(change.sessionId, records) }
    records.set(change.id, change)
  }
  let unchanged = previous.length === next.length
  const result = next.map((change, index) => {
    const aligned = previous[index]
    let row = change
    if (aligned && aligned.sessionId === change.sessionId && aligned.id === change.id && sameArtifactChange(aligned, change)) row = aligned
    else {
      const existing = bySession.get(change.sessionId)?.get(change.id)
      if (existing && sameArtifactChange(existing, change)) row = existing
    }
    if (row !== previous[index]) unchanged = false
    return row
  })
  return unchanged ? previous : result
}

function newestFirst(a: EngineFileChange, b: EngineFileChange): number {
  return typeof a.seq === 'number' && typeof b.seq === 'number' && a.seq !== b.seq
    ? b.seq - a.seq : b.createdAt - a.createdAt || b.id.localeCompare(a.id)
}

function displayPath(path: string, root?: string | null): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = root?.replace(/\\/g, '/').replace(/\/+$/, '')
  const boundary = prefix ? `${sessionChangePathKey(prefix)}/` : root?.replace(/\\/g, '/') === '/' ? '/' : null
  return boundary && sessionChangePathKey(normalized).startsWith(boundary)
    ? normalized.slice(boundary.length) : normalized
}

/** Keep the server's continuous net segments intact. A path is a tree identity,
 * never permission to combine snapshots across turns or other sessions. */
export function buildSessionArtifactFiles(sessionId: string, log: unknown, net: unknown, root?: string | null): SessionArtifactFile[] {
  const files = new Map<string, SessionArtifactFile>()
  const append = (change: EngineFileChange, scope: SessionArtifactScope): void => {
    const key = sessionChangePathKey(change.path, root)
    if (!key) return
    let file = files.get(key)
    if (!file) {
      const shown = displayPath(change.path, root)
      file = { key, path: change.path, name: shown.split('/').at(-1) || shown, displayPath: shown, operations: [], net: [] }
      files.set(key, file)
    }
    file[scope === 'net' ? 'net' : 'operations'].push(change)
  }
  for (const change of ownedArtifactChanges(sessionId, log).sort(newestFirst)) append(change, 'operation')
  for (const change of ownedArtifactChanges(sessionId, net).filter(change => change.status === 'pending').sort(newestFirst)) append(change, 'net')
  return [...files.values()].sort((a, b) => artifactCollator.compare(a.displayPath, b.displayPath))
}

export function defaultArtifactView(file: SessionArtifactFile): SessionArtifactView {
  return file.net[0] ? { scope: 'net', change: file.net[0] } : { scope: 'operation', change: file.operations[0] }
}

/** Use the whole session ledger: a deletion in an older turn must not hide a
 * later recreation. Reverted operations do not describe the current outcome. */
export function artifactFileIsDeleted(sessionId: string, path: string, log: unknown, root?: string | null): boolean {
  const key = sessionChangePathKey(path, root)
  const history = ownedArtifactChanges(sessionId, log)
    .filter(change => sessionChangePathKey(change.path, root) === key).sort(newestFirst)
  const current = history.find(change => change.status !== 'reverted')
  if (current) return current.kind === 'delete'
  // Reverting the complete chain restores its original baseline. A missing
  // text snapshot alone cannot establish that the baseline file was absent.
  const first = history.at(-1)
  return first?.oldHash === 'missing' || Boolean(first?.kind === 'write' && first.isNew === true)
}

function artifactVersion(hash: string | null | undefined): string | undefined {
  return typeof hash === 'string' && hash.trim() ? hash : undefined
}

/** Only an explicit creation establishes an absent baseline. Null text may be
 * a binary snapshot, so it can never cancel a file from the session catalog. */
export function artifactChangesCancel(operations: readonly EngineFileChange[], net: readonly EngineFileChange[] = []): boolean {
  const history = [...operations].sort((a, b) => newestFirst(b, a))
  const first = history[0]
  if (!first) return false
  if (history.some(change => change.projectionIssue && change.projectionIssue !== 'snapshot-unavailable')) return false
  const byId = new Map(history.map(change => [change.id, change]))
  for (const projection of net) {
    const ids = projection.changeIds?.length ? projection.changeIds : [projection.id]
    const sources = ids.map(id => byId.get(id))
    // A projection can arrive ahead of its log, or report that the actual path
    // changed. Keep those files reviewable until both responses agree.
    if (sources.some(change => !change || change.status !== 'pending')) return false
    const start = sources[0]!, end = sources.at(-1)!
    if (projection.projectionIssue && projection.projectionIssue !== 'snapshot-unavailable' && !(projection.projectionIssue === 'later-change' &&
      history.slice(history.indexOf(end) + 1).some(change => change.status !== 'reverted'))) return false
    if (projection.kind !== end.kind) return false
    const oldHash = artifactVersion(projection.oldHash), newHash = artifactVersion(projection.newHash)
    if (oldHash !== undefined && artifactVersion(start.oldHash) !== undefined && oldHash !== start.oldHash ||
      newHash !== undefined && artifactVersion(end.newHash) !== undefined && newHash !== end.newHash) return false
    if (projection.kind === 'write' && (projection.isNew === true &&
      (start.isNew === false || artifactVersion(start.oldHash) !== undefined && start.oldHash !== 'missing') ||
      projection.isNew === false && (start.isNew === true || start.oldHash === 'missing'))) return false
  }
  // Binary payloads can be unavailable while complete byte hashes still prove
  // the lifecycle. Missing both payloads and versions cannot close that chain.
  if ([...history, ...net].some(change => change.projectionIssue === 'snapshot-unavailable') &&
    history.some(change => artifactVersion(change.oldHash) === undefined || artifactVersion(change.newHash) === undefined)) return false
  const baseline = artifactVersion(first.oldHash)
  if (baseline !== 'missing' && !(baseline === undefined && first.kind === 'write' && first.isNew === true)) return false
  const before = (change: EngineFileChange): string | undefined => artifactVersion(change.oldHash) ??
    (change.kind === 'write' && change.isNew === true ? 'missing' : undefined)
  const after = (change: EngineFileChange): string | undefined => artifactVersion(change.newHash) ??
    (change.kind === 'delete' ? 'missing' : undefined)
  if (history.some(change => {
    const old = before(change), next = after(change)
    return change.isNew === true && change.kind === 'write' && old !== undefined && old !== 'missing' ||
      change.kind === 'write' && next === 'missing' || change.kind === 'delete' && next !== 'missing'
  })) return false

  const firstReverted = history.findIndex(change => change.status === 'reverted')
  const hasWriteAfterRevert = firstReverted >= 0 && history.slice(firstReverted).some(change => change.status !== 'reverted')
  const discontinuous = history.some((change, index) => {
    if (!index) return false
    const prior = history[index - 1]
    const previous = after(prior), current = before(change)
    const existedBefore = current !== undefined ? current !== 'missing'
      : change.isNew === false || typeof change.oldContent === 'string' ? true : undefined
    return previous !== undefined && current !== undefined && previous !== current ||
      existedBefore !== undefined && existedBefore !== (prior.kind === 'write')
  })
  if (!hasWriteAfterRevert && !discontinuous) {
    // Legacy receipts may omit hashes. Explicit creation/deletion and a
    // reverted suffix still establish the endpoints without inventing bytes.
    const effective = history.findLast(change => change.status !== 'reverted')
    return !effective || effective.kind === 'delete'
  }

  // A revert followed by another write can start a fresh chain from the
  // restored version. Require complete versions before bridging those chains.
  if (history.some(change => before(change) === undefined || after(change) === undefined)) return false
  let current = 'missing'
  for (let start = 0; start < history.length;) {
    let end = start + 1
    while (end < history.length && after(history[end - 1]) === before(history[end])) end++
    const segment = history.slice(start, end)
    if (before(segment[0]) !== current) return false
    const reverted = segment.findIndex(change => change.status === 'reverted')
    if (reverted >= 0 && segment.slice(reverted).some(change => change.status !== 'reverted')) return false
    const effective = segment.findLast(change => change.status !== 'reverted')
    if (effective) current = after(effective)!
    start = end
  }
  return current === 'missing'
}

/** The supplied operations define the scope: a turn cancels only its own
 * creations. Exact history requests retain otherwise cancelled receipts. */
export function filterSessionArtifactFiles(files: readonly SessionArtifactFile[], preserveFileKey?: string): SessionArtifactFile[] {
  return files.filter(file => file.key === preserveFileKey || !artifactChangesCancel(file.operations, file.net))
}

/** A historical deletion does not prove that today's file is absent: it may
 * have been recreated elsewhere. Let the authenticated reader resolve it. */
export function currentArtifactForFile(file: SessionArtifactFile): SessionArtifact {
  const latest = file.operations[0]
  return {
    id: JSON.stringify(['current', file.key, latest?.id, latest?.newHash, latest?.status]),
    path: file.path, name: file.name, content: null, status: 'ready', createdAt: latest?.createdAt ?? 0
  }
}

/** An explicit tool click must not silently fall back to another operation. */
export function resolveArtifactChoice(files: readonly SessionArtifactFile[], sessionId: string, choice: SessionArtifactChoice | null, root?: string | null): { file: SessionArtifactFile; view: SessionArtifactView | null } | null {
  if (choice?.kind === 'request') {
    if (choice.request.sessionId !== sessionId) return null
    if (!choice.request.path) {
      const file = files[0]
      return file ? { file, view: defaultArtifactView(file) } : null
    }
    const requestedPath = sessionChangePathKey(choice.request.path, root)
    const file = files.find(item => item.key === requestedPath)
    if (!file) return null
    if (!choice.request.changeId) return { file, view: defaultArtifactView(file) }
    const change = file.operations.find(item => item.id === choice.request.changeId)
    return { file, view: change ? { scope: 'operation', change } : null }
  }
  const file = files.find(item => choice?.kind === 'view' && item.key === choice.fileKey) ?? files[0]
  if (!file) return null
  const scoped = choice?.kind === 'view' ? file[choice.scope === 'net' ? 'net' : 'operations'] : []
  const change = choice?.kind === 'view' ? scoped.find(item => item.id === choice.changeId) : undefined
  return { file, view: change && choice?.kind === 'view' ? { scope: choice.scope, change } : defaultArtifactView(file) }
}

export function buildSessionArtifactTree(files: readonly SessionArtifactFile[]): SessionArtifactTreeNode[] {
  const roots: SessionArtifactTreeNode[] = []
  // Index each sibling list independently: identical display prefixes under
  // differently cased parents must retain the existing platform semantics.
  const indexes = new Map<SessionArtifactTreeNode[], Map<string, SessionArtifactTreeNode>>()
  indexes.set(roots, new Map())
  for (const file of files) {
    const segments = file.displayPath.split('/').filter(Boolean)
    let siblings = roots
    let prefix = ''
    segments.forEach((name, depth) => {
      prefix = prefix ? `${prefix}/${name}` : name
      const leaf = depth === segments.length - 1
      const directoryKey = /^(?:[a-z]:\/|\/\/)/i.test(file.key) ? prefix.toLowerCase() : prefix
      const key = leaf ? `file:${file.key}` : `dir:${directoryKey}`
      const index = indexes.get(siblings)!
      let node = index.get(key)
      if (!node) {
        node = { key, name, depth, ...(leaf ? { file } : {}), children: [] }
        siblings.push(node)
        index.set(key, node)
        indexes.set(node.children, new Map())
      }
      siblings = node.children
    })
  }
  const sort = (nodes: SessionArtifactTreeNode[]): void => {
    nodes.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || artifactCollator.compare(a.name, b.name))
    nodes.forEach(node => sort(node.children))
  }
  sort(roots)
  return roots
}

const statsCache = new WeakMap<EngineFileChange, DiffStats | null>()
export function artifactChangeStats(change: EngineFileChange): DiffStats | null {
  if (statsCache.has(change)) return statsCache.get(change) ?? null
  const stats = sessionFileChangeStats(change)
  statsCache.set(change, stats)
  return stats
}

/** A command can acknowledge multiple files, but it cannot create tree entries
 * until the current session's durable endpoint confirms them. */
export function artifactToolRevision(sessionId: string, tools: readonly ToolActivity[]): string {
  const receipts = tools.flatMap(tool => [tool.change, ...(tool.changes ?? []),
    ...(tool.commandJob?.sessionId === sessionId ? tool.commandJob.changes ?? [] : [])])
    .filter(change => change && (!change.sessionId || change.sessionId === sessionId))
  return JSON.stringify(mergeFileChanges(receipts)
    .map(change => [change.id, change.status, change.seq, change.newHash]))
}

export function artifactChangeStatus(status: EngineFileChange['status']): string {
  return status === 'pending' ? '待确认' : status === 'kept' ? '已保留' : '已撤回'
}

export const ARTIFACT_PROJECTION_NOTICES: Record<NonNullable<EngineFileChange['projectionIssue']>, string> = {
  'discontinuous-history': '这些修改的版本链不连续，已分段保留，不能合并成一份净变化。',
  'later-change': '此文件存在后续修改。撤回会核对当前版本，保留发生冲突的文件。',
  'disk-diverged': '当前文件与记录版本不同。这里展示历史差异，撤回前会再次检查版本。',
  'path-changed': '文件的实际路径已变化，当前记录无法安全地直接恢复。',
  'snapshot-unavailable': '缺少完整版本快照，无法计算全部差异或自动撤回。',
  unreadable: '当前文件无法读取；历史改动记录仍保留在这里。'
}
