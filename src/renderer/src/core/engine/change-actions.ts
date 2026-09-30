import type { EngineFileChange, EngineRequestInput } from '@shared/ipc'
import type { GitResult } from '@shared/git-types'

type Request = <T>(input: EngineRequestInput) => Promise<T>

export function changeIdsOf(changes: EngineFileChange[]): string[] {
  return [...new Set(changes.flatMap(change => change.changeIds ?? [change.id]))]
}

export async function keepChanges(request: Request, sessionId: string, changes: EngineFileChange[]): Promise<void> {
  const ids = changeIdsOf(changes)
  if (!ids.length) return
  const result = await request<{ kept: number }>({ method: 'POST', path: '/changes/keep-many', body: { sessionId, ids } })
  if (result?.kept !== ids.length) throw new Error('部分改动未能保留，请刷新改动列表后重试')
}

/** Staging is an explicit user action. A failed acknowledgement must not reset their index. */
export async function stageAndKeepChanges(
  stage: (paths: string[]) => Promise<GitResult>,
  request: Request,
  sessionId: string,
  changes: EngineFileChange[]
): Promise<boolean> {
  const result = await stage([...new Set(changes.map(change => change.path))])
  if (!result.success) throw new Error(result.error ?? 'git add 执行失败')
  const staged = new Set(result.stagedPaths ?? [])
  if (!staged.size) return false
  try {
    await keepChanges(request, sessionId, changes.filter(change => staged.has(change.path)))
  } catch (error) {
    throw new Error(`文件已暂存，但待确认状态保存失败。暂存内容已保留，请刷新后重试“保留”：${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}
