export interface CodegraphStatus {
  root?: string
  initialized: boolean
  indexing?: boolean
  error?: string
  run?: {
    root?: string
    phase: string
    progress?: { current: number; total: number } | null
    error?: string
  } | null
}

export interface CodegraphIndexState {
  known: boolean
  checking: boolean
  initialized: boolean
  busy: boolean
  label: string | null
  error: string | null
  queryFailed: boolean
}

export const EMPTY_CODEGRAPH_INDEX: CodegraphIndexState = {
  known: false, checking: false, initialized: false, busy: false,
  label: null, error: null, queryFailed: false
}

function normalizedRoot(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

export function codegraphIndexState(status: CodegraphStatus): CodegraphIndexState {
  // The engine has one global index job. Its progress/failure may belong to a
  // different project even though initialized describes the requested project.
  const ownRun = !status.run?.root || !status.root || normalizedRoot(status.run.root) === normalizedRoot(status.root)
  const failure = status.error || (!status.initialized && ownRun && status.run?.phase === 'failed' ? status.run.error || '索引未能完成，请重试。' : null)
  const progress = status.run?.progress
  const progressLabel = progress && Number.isFinite(progress.current) && Number.isFinite(progress.total) && progress.total > 0
    ? `索引中 ${progress.current}/${progress.total}` : '索引中…'
  return {
    known: true, checking: false, initialized: status.initialized, busy: Boolean(status.indexing),
    label: status.indexing ? ownRun ? progressLabel : '其他项目索引中' : failure ? '索引失败' : null,
    error: failure, queryFailed: Boolean(status.error)
  }
}
