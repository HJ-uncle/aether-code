import type { ChatMessage, ToolActivity } from '../../core/engine/useChat'
import { getMessageFinalResult } from '../../core/engine/final-result'
import { mergeFileChanges } from '../../core/engine/tool-file-changes'
import { workChangePathKey } from './work-file-changes'

export type WorkInlineFileResolver = (text: string) => string | undefined

interface ParsedPaths {
  args: string
  paths: string[]
  owners: string[]
}
interface Candidate {
  key: string
  path: string
  names: Set<string>
  order: number
}
type Evidence = Pick<ChatMessage, 'id' | 'role' | 'status' | 'tools' | 'attachments' | 'run' | 'runId' | 'conversationId' | 'finalResult'>
const parsedPaths = new WeakMap<ToolActivity, ParsedPaths>()
const resolverStates = new WeakMap<WorkInlineFileResolver, { scope: string; signature: string; evidence: Evidence[] }>()
const evidenceKeys = ['id', 'role', 'status', 'tools', 'attachments', 'run', 'runId', 'conversationId', 'finalResult'] as const

function pathText(value: string): boolean {
  // Receipts can contain spaces, Unicode, #, %, quotes and brackets. They are
  // filesystem names, never URLs to decode or code expressions to evaluate.
  return Boolean(value && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) &&
    (!/^[a-z][a-z\d+.-]*:/i.test(value) || /^[a-z]:[/\\]/i.test(value)))
}

function toolPaths(tool: ToolActivity): ParsedPaths {
  const cached = parsedPaths.get(tool)
  if (cached?.args === tool.args) return cached
  const parsed: ParsedPaths = { args: tool.args, paths: [], owners: [] }
  try {
    const value: unknown = JSON.parse(tool.args)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const fields = value as Record<string, unknown>
      for (const key of ['sessionId', 'session_id']) {
        if (typeof fields[key] === 'string') parsed.owners.push(fields[key])
      }
      for (const key of ['path', 'filePath', 'file_path', 'file']) {
        const path = fields[key]
        // Generic tools also accept directory paths. Only explicit file-like
        // arguments qualify; typed receipts below can identify extensionless files.
        if (typeof path === 'string' && pathText(path) && /\.[a-z\d_-]{1,20}$/i.test(path.split(/[/\\]/).at(-1) ?? '')) parsed.paths.push(path)
      }
    }
  } catch { /* Streaming/legacy argument fragments provide no file evidence. */ }
  parsedPaths.set(tool, parsed)
  return parsed
}

function addName(index: Map<string, Candidate | null>, name: string, candidate: Candidate): void {
  const previous = index.get(name)
  if (previous === undefined) index.set(name, candidate)
  else if (previous?.key !== candidate.key) index.set(name, null)
}

/** The caller supplies one session's transcript. Explicit foreign ownership is
 * still rejected, and child tool output is never recursively mined for paths. */
export function buildWorkInlineFileResolver(messages: readonly ChatMessage[], sessionId: string,
  workspaceRoot?: string | null, previous?: WorkInlineFileResolver): WorkInlineFileResolver {
  const scope = JSON.stringify([sessionId, workspaceRoot ? workChangePathKey(workspaceRoot) : ''])
  const previousState = previous ? resolverStates.get(previous) : undefined
  // Engine state replaces evidence arrays/objects when receipts change. Text
  // deltas can therefore retain this resolver without rescanning old tools.
  if (previous && previousState?.scope === scope && messages.length === previousState.evidence.length &&
    messages.every((message, index) => evidenceKeys.every(key => message[key] === previousState.evidence[index][key]))) return previous
  const evidence = messages.map(({ id, role, status, tools, attachments, run, runId, conversationId, finalResult }) =>
    ({ id, role, status, tools, attachments, run, runId, conversationId, finalResult }))
  const candidates = new Map<string, Candidate>()
  const receipts: NonNullable<ToolActivity['change']>[] = []
  const receiptOrder = new Map<string, number>(), deletedAt = new Map<string, number>()
  let order = 0
  const add = (path: string, at: number, name?: string): void => {
    if (!pathText(path)) return
    const key = workChangePathKey(path, workspaceRoot)
    if (!key || key.endsWith('/') || (deletedAt.get(key) ?? -1) > at) return
    const candidate = candidates.get(key) ?? { key, path, names: new Set<string>(), order: at }
    candidate.order = Math.max(candidate.order, at)
    const basename = key.split('/').at(-1)
    if (basename) candidate.names.add(basename)
    if (name && pathText(name) && !/[/\\]/.test(name)) candidate.names.add(name)
    candidates.set(key, candidate)
  }
  const remove = (path: string, at: number): void => {
    const key = workChangePathKey(path, workspaceRoot)
    deletedAt.set(key, Math.max(deletedAt.get(key) ?? -1, at))
    if ((candidates.get(key)?.order ?? -1) <= at) candidates.delete(key)
  }
  if (sessionId) for (const message of messages) {
    if (message.run && message.run.sessionId !== sessionId || message.finalResult && message.finalResult.sessionId !== sessionId) continue
    order++
    if (message.role === 'user') for (const attachment of message.attachments ?? []) add(attachment.path, order, attachment.name)
    for (const tool of message.tools) {
      order++
      if (tool.state !== 'done' || tool.error || tool.metadata?.success === false) continue
      const changes = mergeFileChanges(tool.changes, tool.change)
      // Typed receipts own their paths, including later keep/revert decisions;
      // their older request arguments must not independently resurrect a file.
      const claimed = new Set(changes.map(change => workChangePathKey(change.path, workspaceRoot)))
      const parsed = toolPaths(tool)
      if (parsed.owners.every(owner => owner === sessionId)) {
        for (const path of parsed.paths) {
          if (tool.name === 'delete_file') {
            // Old history may have no typed deletion receipt. A rejected or
            // reverted receipt, when present, must still prevent this fallback.
            if (!changes.length) remove(path, order)
          } else if (!claimed.has(workChangePathKey(path, workspaceRoot))) add(path, order)
        }
      }
      for (const change of changes) if (!change.sessionId || change.sessionId === sessionId) {
        receipts.push(change)
        if (!receiptOrder.has(change.id)) receiptOrder.set(change.id, order)
      }
    }
    order++
    for (const item of getMessageFinalResult(message, sessionId)?.items ?? []) add(item.path, order, item.name)
  }
  // A completed deletion must withdraw older read/write arguments as well as
  // the write receipt. Merge repeated receipt IDs before applying operation order.
  const changes = mergeFileChanges(receipts)
  const sequenced = changes.every(change => typeof change.seq === 'number')
  changes.sort((a, b) => sequenced ? a.seq! - b.seq! : a.createdAt - b.createdAt)
  for (const change of changes) {
    if (change.status === 'reverted') continue
    const at = receiptOrder.get(change.id)!
    if (change.kind === 'delete') remove(change.path, at)
    else add(change.path, at)
  }

  const signature = JSON.stringify([...candidates.values()].map(candidate => [candidate.key, [...new Set([...candidate.names].map(name =>
    /^(?:[a-z]:\/|\/\/)/i.test(candidate.key) ? name.toLowerCase() : name))].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  if (previous && previousState?.scope === scope && previousState.signature === signature) {
    resolverStates.set(previous, { scope, signature, evidence })
    return previous
  }

  const sensitive = new Map<string, Candidate | null>(), insensitive = new Map<string, Candidate | null>()
  for (const candidate of candidates.values()) {
    const windows = /^(?:[a-z]:\/|\/\/)/i.test(candidate.key)
    for (const name of candidate.names) addName(windows ? insensitive : sensitive, windows ? name.toLowerCase() : name, candidate)
  }
  const resolve: WorkInlineFileResolver = text => {
    if (!pathText(text)) return undefined
    if (/[/\\]/.test(text)) return candidates.get(workChangePathKey(text, workspaceRoot))?.path
    const exact = sensitive.get(text), folded = insensitive.get(text.toLowerCase())
    if (exact === null || folded === null || exact && folded && exact.key !== folded.key) return undefined
    return (exact ?? folded)?.path
  }
  resolverStates.set(resolve, { scope, signature, evidence })
  return resolve
}
