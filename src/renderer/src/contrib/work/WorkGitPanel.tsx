import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react'
import {
  getEngineSource,
  isEngineReady,
  sessionStorageKey,
  subscribeEngineReadiness,
  subscribeEngineSource
} from '@renderer/core/engine/source'
import { retainWorkGitStore, workGitStoreFor } from '@renderer/core/git/work-git-store'
import { wireGitStoreLiveSync } from '@renderer/core/git/store-live-sync'
import { getAppMode, onAppModeChanged } from '@renderer/core/platform/app-mode'
import { GitProvider } from '@renderer/core/git/git-context'
import { GitChangesPanel } from '@renderer/contrib/git/GitChangesPanel'
import { Icon } from '@renderer/workbench/icons'
import { PromptDialog } from '@renderer/workbench/PromptDialog'
import { gitFilePath } from '@renderer/core/git/git-target'
import type { GitCommitFileChange } from '@shared/git-types'
import { WorkGitDiff } from './WorkGitDiff'
import './work-git-panel.css'

export interface WorkGitPanelProps {
  cwd: string | null | undefined
  sessionId?: string | null
  active?: boolean
  workspaceRunId?: string | null
  onOpenFile?: (path: string) => void
  onOpenDiff?: (path: string, staged: boolean) => void
}

/** Work and Code share the full Git UI; only ownership and file navigation differ. */
export function WorkGitPanel(props: WorkGitPanelProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  if (!props.sessionId)
    return (
      <div className="work-git-panel work-git-panel--empty">
        <Icon name="git" size={24} />
        <strong>任务工作区尚未就绪</strong>
        <span>任务建立后即可管理它的独立工作区或项目目录。</span>
      </div>
    )
  return (
    <TaskGitPanel
      key={JSON.stringify([source, props.sessionId, props.cwd])}
      {...props}
      source={source}
      sessionId={props.sessionId}
    />
  )
}

function TaskGitPanel({
  cwd,
  sessionId,
  source,
  active = true,
  workspaceRunId,
  onOpenFile,
  onOpenDiff
}: WorkGitPanelProps & { sessionId: string; source: number }): JSX.Element {
  const engineReady = useSyncExternalStore(subscribeEngineReadiness, isEngineReady)
  const repositoryKey = sessionStorageKey(
    `aether:workGitRepository:${encodeURIComponent(sessionId)}:${encodeURIComponent(cwd || '')}`
  )
  const [repositoryPath, setRepositoryPath] = useState(() => {
    try {
      const path = localStorage.getItem(repositoryKey)
      return path ? gitFilePath(path) : ''
    } catch {
      return ''
    }
  })
  const [cloneOpen, setCloneOpen] = useState(false)
  const store = useMemo(
    () => workGitStoreFor(source, sessionId, cwd || '', repositoryPath),
    [source, sessionId, cwd, repositoryPath]
  )
  const selectedCwd = repositoryPath ? `${cwd || '.'}/${repositoryPath}` : cwd || '.'
  const [comparison, setComparison] = useState<{
    path: string
    staged: boolean
    commit?: { hash: string; file: GitCommitFileChange }
  } | null>(null)
  const selectRepository = (path: string): void => {
    try {
      localStorage.setItem(repositoryKey, path)
    } catch {
      /* Opening a completed clone does not depend on preference storage. */
    }
    setRepositoryPath(path)
    setComparison(null)
  }
  const openFile = useCallback(
    (path: string): void => onOpenFile?.(repositoryPath ? `${repositoryPath}/${path}` : path),
    [onOpenFile, repositoryPath]
  )
  useEffect(() => retainWorkGitStore(store), [store])
  useEffect(() => {
    return wireGitStoreLiveSync({
      store,
      target: () => JSON.stringify([source, getEngineSource(), sessionId, selectedCwd, workspaceRunId]),
      cwd: () => selectedCwd,
      profile: 'general',
      sessionId: () => sessionId,
      eligible: () => active && getAppMode() === 'work' && source === getEngineSource() && isEngineReady(),
      subscribe: wake => {
        const mode = onAppModeChanged(wake)
        const engine = subscribeEngineSource(wake)
        return () => { mode(); engine() }
      }
    })
  }, [store, active, source, sessionId, selectedCwd, workspaceRunId])
  const host = useMemo(
    () => ({
      task: true,
      cwd: selectedCwd,
      unavailableReason: engineReady ? undefined : '等待引擎就绪后读取 Git 状态',
      onOpenFile: openFile,
      onClone: (): void => setCloneOpen(true),
      onOpenCommitDiff: (file: GitCommitFileChange, hash: string): void =>
        setComparison({ path: file.path, staged: false, commit: { hash, file } }),
      onOpenDiff: (path: string, staged: boolean): void => {
        setComparison({ path, staged })
        onOpenDiff?.(path, staged)
      }
    }),
    [selectedCwd, openFile, onOpenDiff, engineReady]
  )
  return (
    <section
      className={`work-git-panel${comparison ? ' work-git-panel--comparing' : ''}`}
      aria-label="任务 Git"
    >
      {active ? (
        <GitProvider store={store} host={host}>
          {repositoryPath ? (
            <div className="work-git-panel__repository">
              <span title={repositoryPath}>{repositoryPath}</span>
              <button type="button" onClick={() => selectRepository('')}>
                返回任务根目录
              </button>
            </div>
          ) : null}
          <div className="work-git-panel__manager">
            <GitChangesPanel key={repositoryPath} />
          </div>
          {comparison ? (
            <WorkGitDiff
              store={store}
              {...comparison}
              onClose={() => setComparison(null)}
              onOpenFile={openFile}
            />
          ) : null}
          {cloneOpen ? (
            <PromptDialog
              title="克隆仓库到任务工作区"
              className="git-dialog"
              label="仓库地址"
              confirmLabel="克隆"
              validate={(value) =>
                /^(?:(?:https?|ssh|git|file):\/\/|[^\s/@:]+@[^\s:]+:).+/.test(value)
                  ? null
                  : '请输入 HTTP(S)、SSH、Git 或 file 仓库地址'
              }
              onClose={() => setCloneOpen(false)}
              onConfirm={async (url) => {
                const target = await store.captureTarget()
                const result = await store.cloneRepository(url)
                if (!result.success || !result.finalPath)
                  throw new Error(result.error || '克隆未完成')
                const root = target.root.replace(/\\/g, '/').replace(/\/+$/, '')
                const finalPath = result.finalPath.replace(/\\/g, '/')
                const windows = /^(?:[A-Za-z]:\/|\/\/)/.test(root)
                const normalize = (path: string): string => (windows ? path.toLowerCase() : path)
                if (!normalize(finalPath).startsWith(normalize(root) + '/'))
                  throw new Error('克隆目录不属于当前任务')
                if (source === getEngineSource())
                  selectRepository(gitFilePath(finalPath.slice(root.length + 1)))
              }}
            />
          ) : null}
        </GitProvider>
      ) : null}
    </section>
  )
}
