import {
  DEFAULT_NEXT_TURN_QUEUE_LIMITS,
  NextTurnQueueError,
  type NextTurnQueueEnvelope,
  type NextTurnQueueLimits,
  type NextTurnQueueMutation,
  type QueueMention,
  type NextTurnQueueScope,
  type NextTurnQueueState
} from './next-turn-queue'

function fail(message: string): never {
  throw new NextTurnQueueError('INVALID', message)
}
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength
/** Structured-cloneable objects are broader than the JSON journal contract (Map, cycles, accessors). */
export function assertQueueJsonValue(
  value: unknown,
  maximumBytes = DEFAULT_NEXT_TURN_QUEUE_LIMITS.maxStateBytes + 8192
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    fail('Queue JSON byte budget is invalid')
  const ancestors = new Set<object>()
  let nodes = 0,
    encodedBytes = 0
  function add(size: number): void {
    encodedBytes += size
    if (encodedBytes > maximumBytes)
      throw new NextTurnQueueError('CAPACITY', 'Queue JSON UTF-8 byte budget exceeded')
  }
  function textSize(text: string): number {
    if (text.length > maximumBytes - encodedBytes)
      throw new NextTurnQueueError('CAPACITY', 'Queue JSON UTF-8 byte budget exceeded')
    return bytes(JSON.stringify(text))
  }
  function visit(item: unknown, depth: number, allowUndefined: boolean): void {
    if (++nodes > 200000 || depth > 32)
      throw new NextTurnQueueError('CAPACITY', 'Queue JSON structural budget exceeded')
    if (item === undefined && allowUndefined) return
    if (typeof item === 'string') {
      add(textSize(item))
      return
    }
    if (item === null || typeof item === 'boolean') {
      add(item === null ? 4 : item ? 4 : 5)
      return
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(JSON.stringify(item).length)
      return
    }
    if (typeof item !== 'object' || !item) fail('Queue value must contain only finite JSON data')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      fail('Queue value must contain only plain JSON objects')
    if (Object.getOwnPropertySymbols(item).length || ancestors.has(item))
      fail('Queue value has symbols or cycles')
    ancestors.add(item)
    if (Array.isArray(item)) {
      add(item.length + 1)
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !('value' in descriptor))
          fail('Queue arrays cannot contain holes or accessors')
        visit(descriptor.value, depth + 1, false)
      }
      if (
        Object.keys(item).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)
      )
        fail('Queue arrays cannot carry named properties')
    } else {
      add(2)
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!('value' in descriptor) || !descriptor.enumerable)
          fail('Queue objects cannot carry accessors or hidden fields')
        if (descriptor.value !== undefined) add(textSize(key) + 2)
        visit(descriptor.value, depth + 1, true)
      }
    }
    ancestors.delete(item)
  }
  try {
    visit(value, 0, false)
  } catch (error) {
    if (error instanceof NextTurnQueueError) throw error
    throw new NextTurnQueueError('INVALID', 'Queue JSON structure could not be inspected')
  }
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(label + ' must be an object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key)))
    return fail(label + ' contains an unsupported field')
  return record
}
function string(
  value: unknown,
  label: string,
  limit = 256,
  empty = false
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    value.length > limit ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail(label + ' is invalid')
}
function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum)
    fail(label + ' is invalid')
}
function list(value: unknown, label: string, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(label + ' is invalid')
  if (value.length > maximum)
    throw new NextTurnQueueError('CAPACITY', label + ' count budget exceeded')
}
function oneOf(value: unknown, choices: readonly string[], label: string): void {
  if (typeof value !== 'string' || !choices.includes(value)) fail(label + ' is invalid')
}
export function assertQueueScope(value: unknown): asserts value is NextTurnQueueScope {
  assertQueueJsonValue(value)
  const scope = object(value, ['source', 'tenantId', 'namespace', 'owner', 'taskId'], 'scope')
  const source = object(scope.source, ['mode', 'endpoint', 'accountId'], 'source')
  oneOf(source.mode, ['embedded', 'remote'], 'source mode')
  string(source.endpoint, 'endpoint', 2048, true)
  if (source.mode === 'embedded' && source.endpoint !== '')
    fail('Embedded source must not persist its transport port')
  if (source.mode === 'remote') {
    let url: URL
    try {
      url = new URL(source.endpoint)
    } catch {
      return fail('Remote endpoint is invalid')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href.replace(/\/+$/, '') !== source.endpoint
    )
      fail('Remote endpoint is not canonical or contains credentials')
  }
  if (source.accountId !== null) string(source.accountId, 'accountId')
  string(scope.tenantId, 'tenantId')
  string(scope.taskId, 'taskId')
  if (scope.owner !== 'work') fail('Queue owner must be work')
  const namespace = object(scope.namespace, ['id', 'generation'], 'namespace')
  string(namespace.id, 'namespace id')
  string(namespace.generation, 'namespace generation')
}
export function queueScopeIdentity(scope: NextTurnQueueScope): string {
  assertQueueScope(scope)
  return JSON.stringify([
    scope.source.mode,
    scope.source.endpoint,
    scope.source.accountId,
    scope.tenantId,
    scope.namespace.id,
    scope.namespace.generation,
    scope.owner,
    scope.taskId
  ])
}
export function sameQueueScope(left: NextTurnQueueScope, right: NextTurnQueueScope): boolean {
  return queueScopeIdentity(left) === queueScopeIdentity(right)
}
export function assertQueueLimits(value: NextTurnQueueLimits): void {
  for (const key of Object.keys(DEFAULT_NEXT_TURN_QUEUE_LIMITS) as (keyof NextTurnQueueLimits)[])
    integer(value[key], 'limit ' + key, 1)
}
function selection(value: unknown, label: string): void {
  const resource = object(value, ['kind', 'ids'], label)
  oneOf(resource.kind, ['inherit', 'none', 'override'], label + ' kind')
  if (resource.kind !== 'override') {
    if (resource.ids !== undefined) fail(label + ' inherited/none selection cannot carry IDs')
    return
  }
  list(resource.ids, label + ' IDs', 100)
  if (!resource.ids.length) fail(label + ' override must have IDs; use none to disable')
  for (const id of resource.ids) string(id, label + ' ID')
  if (new Set(resource.ids).size !== resource.ids.length) fail(label + ' has duplicate IDs')
}
/** Main-safe adapter of the existing composer token contract; label and machine selector differ. */
export function queueMentionToken(
  mention: Pick<QueueMention, 'path' | 'source' | 'displayText' | 'startLine' | 'endLine'>
): string {
  if (!mention.path) return mention.displayText
  if (mention.source === 'code' && mention.startLine) {
    const range =
      mention.endLine && mention.endLine !== mention.startLine
        ? `${mention.startLine}-${mention.endLine}`
        : `${mention.startLine}`
    return `@${mention.path}:${range}`
  }
  return `@${mention.path}`
}
export function assertQueueEnvelope(
  value: unknown,
  scope: NextTurnQueueScope,
  limits: NextTurnQueueLimits = DEFAULT_NEXT_TURN_QUEUE_LIMITS
): asserts value is NextTurnQueueEnvelope {
  assertQueueJsonValue(value, limits.maxStateBytes)
  const envelope = object(
    value,
    [
      'draft',
      'submissionDigest',
      'model',
      'workspace',
      'agent',
      'resources',
      'thinking',
      'memory',
      'security',
      'subagentModel',
      'utilityModel',
      'attachments'
    ],
    'envelope'
  )
  if (envelope.submissionDigest !== undefined && (typeof envelope.submissionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.submissionDigest))) fail('Enqueue submission digest is invalid')
  const draft = object(envelope.draft, ['text', 'revision', 'mentions'], 'draft')
  if (typeof draft.text !== 'string') fail('Draft text must be text')
  if (bytes(draft.text) > limits.maxTextBytes)
    throw new NextTurnQueueError('CAPACITY', 'Draft UTF-8 byte budget exceeded')
  integer(draft.revision, 'draft revision')
  list(draft.mentions, 'mentions', limits.maxMentions)
  let previousEnd = 0
  const agentIds = new Set<string>()
  for (const item of draft.mentions) {
    const mention = object(
      item,
      [
        'source',
        'displayText',
        'textOffset',
        'path',
        'content',
        'startLine',
        'endLine',
        'startColumn',
        'endColumn'
      ],
      'mention'
    )
    oneOf(mention.source, ['file', 'dir', 'code', 'terminal', 'agent', 'browser'], 'mention source')
    string(mention.displayText, 'mention label', 512)
    integer(mention.textOffset, 'mention offset')
    if (mention.path !== undefined) string(mention.path, 'mention path', 4096, true)
    if (mention.content !== undefined && typeof mention.content !== 'string')
      fail('Mention content must be text')
    for (const name of ['startLine', 'endLine', 'startColumn', 'endColumn'])
      if (mention[name] !== undefined) integer(mention[name], 'mention ' + name, 1)
    const token = queueMentionToken({
      source: mention.source as QueueMention['source'],
      displayText: mention.displayText,
      path: typeof mention.path === 'string' ? mention.path : undefined,
      startLine: typeof mention.startLine === 'number' ? mention.startLine : undefined,
      endLine: typeof mention.endLine === 'number' ? mention.endLine : undefined
    })
    const end = mention.textOffset + token.length
    if (
      mention.textOffset < previousEnd ||
      end > draft.text.length ||
      draft.text.slice(mention.textOffset, end) !== token
    )
      fail('Mention position does not match the authored chip')
    previousEnd = end
    if (mention.source === 'agent') {
      string(mention.path, 'Agent mention ID')
      agentIds.add(mention.path)
    }
  }
  const model = object(envelope.model, ['kind', 'modelId', 'observedModelId'], 'model')
  oneOf(model.kind, ['explicit', 'client-default', 'engine-default'], 'model kind')
  if (model.kind === 'explicit') {
    string(model.modelId, 'model ID')
    if (model.observedModelId !== undefined)
      fail('Explicit model cannot carry a default observation')
  } else {
    if (model.modelId !== undefined) fail('Default model cannot carry an explicit model')
    if (model.observedModelId !== undefined) string(model.observedModelId, 'observed model')
  }
  const workspace = object(envelope.workspace, ['kind', 'identity'], 'workspace')
  oneOf(workspace.kind, ['local-workspace', 'local-scratch', 'remote-session'], 'workspace kind')
  string(workspace.identity, 'workspace identity', 4096)
  if ((scope.source.mode === 'remote') !== (workspace.kind === 'remote-session'))
    fail('Workspace kind belongs to another source mode')
  const agent = object(envelope.agent, ['primaryAgentId', 'collaborators'], 'agent')
  if (agent.primaryAgentId !== null) string(agent.primaryAgentId, 'primary Agent ID')
  list(agent.collaborators, 'collaborators', 8)
  const selected = new Set<string>(),
    resumes = new Set<string>()
  for (const item of agent.collaborators) {
    const collaborator = object(item, ['agentId', 'resumeRunId'], 'collaborator')
    if (collaborator.agentId === undefined && collaborator.resumeRunId === undefined)
      fail('Collaborator needs an authored selector')
    if (collaborator.agentId !== undefined) {
      string(collaborator.agentId, 'collaborator Agent')
      if (!agentIds.has(collaborator.agentId) || selected.has(collaborator.agentId))
        fail('Collaborator is not selected by a unique Agent chip')
      selected.add(collaborator.agentId)
    }
    if (collaborator.resumeRunId !== undefined) {
      string(collaborator.resumeRunId, 'resume run')
      if (resumes.has(collaborator.resumeRunId)) fail('Duplicate resume run')
      resumes.add(collaborator.resumeRunId)
    }
  }
  if ([...agentIds].some((id) => !selected.has(id)))
    fail('Authored Agent chip is missing its collaborator selector')
  const resources = object(
    envelope.resources,
    ['skills', 'mcpServers', 'knowledgeBases'],
    'resources'
  )
  for (const name of ['skills', 'mcpServers', 'knowledgeBases']) selection(resources[name], name)
  const thinking = object(envelope.thinking, ['kind', 'effort'], 'thinking')
  oneOf(thinking.kind, ['inherit', 'off', 'effort'], 'thinking kind')
  if (thinking.kind === 'effort')
    oneOf(thinking.effort, ['low', 'medium', 'high'], 'thinking effort')
  else if (thinking.effort !== undefined) fail('Inherited/off thinking cannot carry effort')
  const memory = object(envelope.memory, ['kind', 'scope', 'version'], 'memory')
  oneOf(memory.kind, ['inherit', 'override'], 'memory kind')
  if (memory.kind === 'override') {
    oneOf(memory.scope, ['off', 'session', 'global'], 'memory scope')
    string(memory.version, 'memory version')
  } else if (memory.scope !== undefined || memory.version !== undefined)
    fail('Inherited memory cannot carry a scope override')
  const security = object(envelope.security, ['policy', 'observedVersion'], 'security')
  if (security.policy !== 'engine-session') fail('Queue cannot grant an access mode')
  if (security.observedVersion !== undefined)
    string(security.observedVersion, 'security observation')
  for (const name of ['subagentModel', 'utilityModel'])
    if (envelope[name] !== undefined) string(envelope[name], name)
  list(envelope.attachments, 'attachments', limits.maxAttachments)
  const attachmentIds = new Set<string>()
  let attachmentBytes = 0
  for (const item of envelope.attachments) {
    const attachment = object(
      item,
      ['kind', 'scope', 'path', 'name', 'mime', 'bytes', 'receiptId', 'sha256'],
      'attachment'
    )
    assertQueueScope(attachment.scope)
    if (!sameQueueScope(attachment.scope, scope))
      throw new NextTurnQueueError(
        'SCOPE',
        'Attachment receipt belongs to another task/source/account/namespace'
      )
    if (attachment.kind !== workspace.kind) fail('Attachment belongs to another workspace kind')
    string(attachment.path, 'attachment path', 4096)
    if (
      attachment.path.includes('\\') ||
      attachment.path.startsWith('/') ||
      /^[A-Za-z]:/.test(attachment.path) ||
      attachment.path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      fail('Attachment selector must be a strict relative path')
    string(attachment.name, 'attachment name', 512)
    string(attachment.mime, 'attachment MIME', 256)
    integer(attachment.bytes, 'attachment bytes')
    attachmentBytes += attachment.bytes
    if (!Number.isSafeInteger(attachmentBytes) || attachmentBytes > limits.maxAttachmentBytes)
      throw new NextTurnQueueError('CAPACITY', 'Attachment byte budget exceeded')
    string(attachment.receiptId, 'attachment receipt')
    string(attachment.sha256, 'attachment digest', 64)
    if (!/^[a-f0-9]{64}$/.test(attachment.sha256) || attachmentIds.has(attachment.receiptId))
      fail('Attachment receipt/digest is invalid or duplicated')
    attachmentIds.add(attachment.receiptId)
  }
  if (!draft.text.trim() && !envelope.attachments.length)
    fail('Queue entry must contain text or an attachment')
  if (bytes(JSON.stringify(value)) > limits.maxStateBytes)
    throw new NextTurnQueueError('CAPACITY', 'Queue envelope UTF-8 byte budget exceeded')
}
export function emptyNextTurnQueue(scope: NextTurnQueueScope): NextTurnQueueState {
  assertQueueScope(scope)
  return {
    schemaVersion: 1,
    scope: structuredClone(scope),
    revision: 0,
    paused: false,
    entries: [],
    removed: []
  }
}
export function assertQueueState(
  value: unknown,
  scope: NextTurnQueueScope,
  limits: NextTurnQueueLimits = DEFAULT_NEXT_TURN_QUEUE_LIMITS
): asserts value is NextTurnQueueState {
  assertQueueJsonValue(value, limits.maxStateBytes)
  const state = object(
    value,
    ['schemaVersion', 'scope', 'revision', 'paused', 'pauseReason', 'resumeAnchor', 'entries', 'removed'],
    'queue state'
  )
  if (state.schemaVersion !== 1) fail('Unsupported queue schema version')
  assertQueueScope(state.scope)
  if (!sameQueueScope(state.scope, scope))
    throw new NextTurnQueueError('SCOPE', 'Queue snapshot belongs to another scope')
  integer(state.revision, 'queue revision')
  if (typeof state.paused !== 'boolean') fail('Queue paused flag is invalid')
  if (state.pauseReason !== undefined) string(state.pauseReason, 'pause reason', 1024)
  if (state.resumeAnchor !== undefined && state.resumeAnchor !== null) {
    const anchor = object(state.resumeAnchor, ['runId', 'attemptId', 'version'], 'resume anchor')
    string(anchor.runId, 'resume run'); string(anchor.attemptId, 'resume attempt'); integer(anchor.version, 'resume version', 1)
  }
  list(state.entries, 'entries', limits.maxEntries)
  list(state.removed, 'removed entries', limits.maxRemoved)
  const ids = new Set<string>()
  for (const item of state.entries) {
    const entry = object(
      item,
      [
        'id',
        'revision',
        'createdAt',
        'updatedAt',
        'envelope',
        'phase',
        'frozen',
        'reason',
        'receipt',
        'outcome'
      ],
      'entry'
    )
    string(entry.id, 'entry ID')
    if (ids.has(entry.id)) fail('Duplicate entry ID')
    ids.add(entry.id)
    integer(entry.revision, 'entry revision', 1)
    integer(entry.createdAt, 'createdAt')
    integer(entry.updatedAt, 'updatedAt')
    if (entry.updatedAt < entry.createdAt) fail('Entry timestamp moves backwards')
    assertQueueEnvelope(entry.envelope, scope, limits)
    oneOf(
      entry.phase,
      ['pending', 'dispatching', 'admission-unknown', 'accepted', 'terminal'],
      'entry phase'
    )
    if (entry.reason !== undefined) string(entry.reason, 'entry reason', 1024)
    if (entry.phase === 'pending') {
      if (
        entry.frozen !== undefined ||
        entry.receipt !== undefined ||
        entry.outcome !== undefined ||
        entry.reason !== undefined
      )
        fail('Pending entry cannot claim delivery')
      continue
    }
    const frozen = object(
      entry.frozen,
      ['requestKey', 'bodyDigest', 'entryRevision', 'anchor', 'wireBody'],
      'frozen submission'
    )
    string(frozen.requestKey, 'request key')
    if (frozen.wireBody !== undefined) string(frozen.wireBody, 'frozen wire body', 2 * 1024 * 1024)
    string(frozen.bodyDigest, 'body digest', 64)
    integer(frozen.entryRevision, 'frozen entry revision', 1)
    if (frozen.entryRevision !== entry.revision || !/^[a-f0-9]{64}$/.test(frozen.bodyDigest))
      fail('Frozen submission revision/digest is invalid')
    if (frozen.anchor !== null) {
      const anchor = object(frozen.anchor, ['runId', 'attemptId', 'version'], 'anchor')
      string(anchor.runId, 'anchor run')
      string(anchor.attemptId, 'anchor attempt')
      integer(anchor.version, 'anchor version', 1)
    }
    if (entry.phase === 'dispatching' || entry.phase === 'admission-unknown') {
      if (entry.receipt !== undefined || entry.outcome !== undefined)
        fail('Unknown submission cannot claim an accepted outcome')
      continue
    }
    const receipt = object(
      entry.receipt,
      ['runId', 'turnId', 'userMessageId', 'assistantMessageId'],
      'accepted receipt'
    )
    for (const name of ['runId', 'turnId', 'userMessageId', 'assistantMessageId'])
      string(receipt[name], 'accepted ' + name)
    if (entry.phase === 'terminal')
      oneOf(entry.outcome, ['succeeded', 'failed', 'cancelled', 'interrupted'], 'terminal outcome')
    else if (entry.outcome !== undefined) fail('Accepted entry cannot claim a terminal outcome')
  }
  for (const item of state.removed) {
    const removed = object(item, ['id', 'entryRevision', 'removedAt'], 'removed')
    string(removed.id, 'removed ID')
    integer(removed.entryRevision, 'removed revision', 1)
    integer(removed.removedAt, 'removed time')
    if (ids.has(removed.id)) fail('Removed ID conflicts with a live/tombstoned entry')
    ids.add(removed.id)
  }
  if (bytes(JSON.stringify(value)) > limits.maxStateBytes)
    throw new NextTurnQueueError('CAPACITY', 'Queue snapshot UTF-8 byte budget exceeded')
}
export function applyNextTurnQueueMutation(
  state: NextTurnQueueState,
  expectedRevision: number,
  operation: NextTurnQueueMutation,
  limits: NextTurnQueueLimits = DEFAULT_NEXT_TURN_QUEUE_LIMITS
): NextTurnQueueState {
  assertQueueJsonValue(operation, limits.maxStateBytes + 8192)
  assertQueueState(state, state.scope, limits)
  integer(expectedRevision, 'expected revision')
  if (state.revision !== expectedRevision)
    throw new NextTurnQueueError('CAS', 'Queue revision changed')
  const next = structuredClone(state)
  const op = object(
    operation,
    ['kind', 'id', 'envelope', 'entryRevision', 'at', 'beforeId', 'reason', 'frozen', 'receipt', 'outcome', 'anchor'],
    'mutation'
  )
  oneOf(
    op.kind,
    [
      'enqueue',
      'edit',
      'move',
      'remove',
      'clear-pending',
      'pause',
      'resume',
      'recover-interrupted-submissions', 'claim', 'admission-unknown', 'accepted', 'terminal', 'confirm-resume'
    ],
    'mutation kind'
  )
  const pending = (id: unknown) => {
    string(id, 'entry ID')
    const entry = next.entries.find((item) => item.id === id)
    if (!entry || entry.phase !== 'pending')
      throw new NextTurnQueueError('CONFLICT', 'Only a pending entry can be changed')
    return entry
  }
  switch (operation.kind) {
    case 'confirm-resume':
      if (next.entries.some(item => item.phase === 'dispatching' || item.phase === 'admission-unknown')) throw new NextTurnQueueError('CONFLICT', 'Unconfirmed admission must be reconciled first')
      next.paused = false; delete next.pauseReason; next.resumeAnchor = structuredClone(operation.anchor)
      break
    case 'claim': {
      const entry = pending(operation.id)
      if (next.paused || next.entries.some(item => ['dispatching', 'admission-unknown', 'accepted'].includes(item.phase)))
        throw new NextTurnQueueError('CONFLICT', 'Queue is paused or already has an in-flight entry')
      if (next.entries.find(item => item.phase === 'pending')?.id !== entry.id || entry.revision !== operation.entryRevision)
        throw new NextTurnQueueError('CAS', 'Queue head or entry revision changed')
      integer(operation.at, 'claim time')
      delete next.resumeAnchor
      next.entries = next.entries.map(item => item.id === entry.id
        ? { ...item, phase: 'dispatching', frozen: structuredClone(operation.frozen), updatedAt: Math.max(item.updatedAt, operation.at) }
        : item)
      break
    }
    case 'admission-unknown': {
      string(operation.reason, 'unknown reason', 1024)
      integer(operation.at, 'unknown time')
      const entry = next.entries.find(item => item.id === operation.id)
      if (!entry || (entry.phase !== 'dispatching' && entry.phase !== 'admission-unknown'))
        throw new NextTurnQueueError('CONFLICT', 'Only an unconfirmed admission can become unknown')
      next.entries = next.entries.map(item => item.id === entry.id
        ? { ...entry, phase: 'admission-unknown', reason: operation.reason, updatedAt: Math.max(entry.updatedAt, operation.at) }
        : item)
      next.paused = true
      next.pauseReason = operation.reason
      break
    }
    case 'accepted': {
      integer(operation.at, 'acceptance time')
      const entry = next.entries.find(item => item.id === operation.id)
      if (!entry || (entry.phase !== 'dispatching' && entry.phase !== 'admission-unknown'))
        throw new NextTurnQueueError('CONFLICT', 'Only an unconfirmed admission can be accepted')
      next.entries = next.entries.map(item => item.id === entry.id
        ? { id: entry.id, revision: entry.revision, createdAt: entry.createdAt, updatedAt: Math.max(entry.updatedAt, operation.at),
            envelope: entry.envelope, phase: 'accepted', frozen: entry.frozen, receipt: structuredClone(operation.receipt) }
        : item)
      break
    }
    case 'terminal': {
      integer(operation.at, 'terminal time')
      const entry = next.entries.find(item => item.id === operation.id)
      if (!entry || entry.phase !== 'accepted')
        throw new NextTurnQueueError('CONFLICT', 'Only an accepted entry can finish')
      next.entries = next.entries.map(item => item.id === entry.id
        ? { ...entry, phase: 'terminal', outcome: operation.outcome, updatedAt: Math.max(item.updatedAt, operation.at) }
        : item)
      if (operation.outcome !== 'succeeded') {
        next.paused = true
        next.pauseReason = '上一轮未成功，队列已暂停'
      }
      break
    }
    case 'enqueue':
      string(operation.id, 'entry ID')
      integer(operation.at, 'enqueue time')
      assertQueueEnvelope(operation.envelope, state.scope, limits)
      if ([...next.entries, ...next.removed].some((item) => item.id === operation.id))
        throw new NextTurnQueueError('CONFLICT', 'Entry identity was already used')
      next.entries.push({
        id: operation.id,
        revision: 1,
        createdAt: operation.at,
        updatedAt: operation.at,
        envelope: structuredClone(operation.envelope),
        phase: 'pending'
      })
      break
    case 'edit': {
      const entry = pending(operation.id)
      integer(operation.entryRevision, 'entry revision', 1)
      integer(operation.at, 'edit time')
      if (entry.revision !== operation.entryRevision)
        throw new NextTurnQueueError('CAS', 'Entry revision changed')
      assertQueueEnvelope(operation.envelope, state.scope, limits)
      entry.envelope = structuredClone(operation.envelope)
      entry.revision++
      entry.updatedAt = operation.at
      break
    }
    case 'move': {
      const entry = pending(operation.id)
      if (operation.beforeId !== null) {
        string(operation.beforeId, 'before ID')
        pending(operation.beforeId)
      }
      if (operation.beforeId === entry.id)
        throw new NextTurnQueueError('INVALID', 'Entry cannot be moved before itself')
      next.entries = next.entries.filter((item) => item.id !== entry.id)
      const target =
        operation.beforeId === null
          ? next.entries.length
          : next.entries.findIndex((item) => item.id === operation.beforeId)
      next.entries.splice(target, 0, entry)
      break
    }
    case 'remove': {
      const entry = pending(operation.id)
      integer(operation.entryRevision, 'entry revision', 1)
      integer(operation.at, 'remove time')
      if (entry.revision !== operation.entryRevision)
        throw new NextTurnQueueError('CAS', 'Entry revision changed')
      next.removed.push({ id: entry.id, entryRevision: entry.revision, removedAt: operation.at })
      next.entries = next.entries.filter((item) => item.id !== entry.id)
      break
    }
    case 'clear-pending':
      integer(operation.at, 'clear time')
      next.removed.push(
        ...next.entries
          .filter((item) => item.phase === 'pending')
          .map((item) => ({ id: item.id, entryRevision: item.revision, removedAt: operation.at }))
      )
      next.entries = next.entries.filter((item) => item.phase !== 'pending')
      break
    case 'pause':
      string(operation.reason, 'pause reason', 1024)
      next.paused = true
      next.pauseReason = operation.reason
      break
    case 'resume':
      if (
        next.entries.some(
          (item) => item.phase === 'dispatching' || item.phase === 'admission-unknown'
        )
      )
        throw new NextTurnQueueError(
          'CONFLICT',
          'Unconfirmed submission must be reconciled before resuming'
        )
      next.paused = false
      delete next.pauseReason
      break
    case 'recover-interrupted-submissions':
      integer(operation.at, 'recovery time')
      next.entries = next.entries.map((entry) =>
        entry.phase === 'dispatching'
          ? {
              ...entry,
              phase: 'admission-unknown',
              reason: 'Process restarted before admission acknowledgement',
              updatedAt: Math.max(operation.at, entry.updatedAt)
            }
          : entry
      )
      if (next.entries.some((entry) => entry.phase === 'admission-unknown')) {
        next.paused = true
        next.pauseReason = 'Unconfirmed admission requires reconciliation'
      }
      break
  }
  next.revision++
  assertQueueState(next, state.scope, limits)
  return next
}
