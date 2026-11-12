import type { EngineRequestInput, EngineRequestResult, FilesExclude, SearchHit, SearchOptions, SearchOutcome } from '@shared/ipc'
import { hasEncodedPathTraversal } from '@shared/path-safety'
import { request } from '../../core/engine/client'
import { assertSessionFileTarget, type SessionFileTarget } from '../../core/workspace/fs-client'

export interface SessionSearchApiDependencies {
  assertTarget(target: SessionFileTarget): void
  request(input: EngineRequestInput): Promise<EngineRequestResult<unknown>>
  newId(): string
}
const defaults: SessionSearchApiDependencies = { assertTarget: assertSessionFileTarget, request, newId: () => crypto.randomUUID() }

function sameRoot(left: string, right: string): boolean {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = normalize(left), b = normalize(right)
  return /^(?:[A-Za-z]:|\/\/)/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b
}

function decodeResult(raw: unknown, target: SessionFileTarget): SearchOutcome {
  if (!raw || typeof raw !== 'object') throw new Error('工作区搜索响应无效，请更新引擎后重试')
  const result = raw as Record<string, unknown>
  if (typeof result.root !== 'string' || !sameRoot(result.root, target.root) ||
      target.bindingEpoch !== undefined && result.bindingEpoch !== target.bindingEpoch) {
    throw new Error('任务工作区已变化，请重新打开工作区搜索')
  }
  if (!Array.isArray(result.hits) || result.hits.length > 2000 || typeof result.truncated !== 'boolean' ||
      typeof result.strategy !== 'string' || !['git', 'scan'].includes(result.strategy) || result.error !== undefined && typeof result.error !== 'string') {
    throw new Error('工作区搜索响应无效，请更新引擎后重试')
  }
  const hits: SearchHit[] = result.hits.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('工作区搜索结果无效')
    const hit = value as Record<string, unknown>
    if (typeof hit.path !== 'string' || hasEncodedPathTraversal(hit.path) || /[\\\u0000-\u001f\u007f:]/.test(hit.path) ||
        hit.path.split('/').some(part => !part || part === '.' || part === '..') ||
        typeof hit.text !== 'string' || hit.text.length > 240 ||
        typeof hit.line !== 'number' || !Number.isSafeInteger(hit.line) || hit.line < 1 ||
        typeof hit.column !== 'number' || !Number.isSafeInteger(hit.column) || hit.column < 1 ||
        typeof hit.length !== 'number' || !Number.isSafeInteger(hit.length) || hit.length < 0) {
      throw new Error('工作区搜索结果包含无效路径或位置')
    }
    return { path: hit.path, line: hit.line, text: hit.text, column: hit.column, length: hit.length }
  })
  return { hits, truncated: result.truncated, strategy: result.strategy as SearchOutcome['strategy'], error: result.error as string | undefined }
}

/** One session-bound request searches beside the files. A query change also
 * stops the worker, instead of only hiding its eventual renderer response. */
export function startSessionSearch(target: SessionFileTarget, current: () => boolean, query: string,
  options: SearchOptions, excludes: FilesExclude, useIgnoreFiles: boolean, deps = defaults): {
  promise: Promise<SearchOutcome>; cancel(): void
} {
  const requestId = deps.newId()
  let cancelled = false, settled = false, started = false
  const assertCurrent = (): void => {
    if (cancelled || !current()) throw new Error('工作区搜索已取消')
    deps.assertTarget(target)
  }
  const promise = (async (): Promise<SearchOutcome> => {
    assertCurrent()
    started = true
    const result = await deps.request({ method: 'POST', path: '/workspace/search', expectedEngine: target.expectedEngine,
      toolProfile: 'general', body: { sessionId: target.sessionId, expectedRoot: target.root, bindingEpoch: target.bindingEpoch,
        requestId, query, options, excludes, useIgnoreFiles } })
    assertCurrent()
    if (!result.ok) {
      if (result.code === 404 || result.code === 40400) throw new Error('当前引擎尚不支持项目全文搜索，请重新构建并重启引擎')
      throw new Error(result.message || '项目搜索失败，请重试')
    }
    return decodeResult(result.data, target)
  })().finally(() => { settled = true })
  return { promise, cancel() {
    if (cancelled || settled) return
    cancelled = true
    // The captured engine identity prevents a late cancel reaching a different
    // connection. The request ID never cancels another panel's search.
    if (started) void deps.request({ method: 'POST', path: '/workspace/search/cancel', expectedEngine: target.expectedEngine,
      toolProfile: 'general', body: { sessionId: target.sessionId, requestId } }).catch(() => {})
  } }
}
