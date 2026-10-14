import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { GitFileChange, GitFileDiff, GitResult } from '@shared/git-types'
import { createGitClient, type ScopedGitClient } from '@renderer/core/git/git-client'
import {
  captureSessionGitTarget,
  gitUtilityChat,
  type GitTarget
} from '@renderer/core/git/git-target'
import { useApp } from '@renderer/core/app-context'
import { getEngineSource } from '@renderer/core/engine/source'
import { cleanAiCommitMessage } from '@renderer/core/git/commit-message'
import {
  workGitOwnerKey, getWorkGitOperation, subscribeWorkGitOperation, beginWorkGitOperation, finishWorkGitOperation,
  getWorkGitDraft, editWorkGitDraft, setWorkGitProposal, clearWorkGitDraft,
  getWorkGitRepositoryOperation, retainWorkGitRepositoryOperation, publishWorkGitSuccess, subscribeWorkGitSuccess
} from '@renderer/core/git/work-git-operation'
import { captureGitCommand, createRepositoryOperation } from '@renderer/core/git/git-repository-operation'
import { GitRepositoryNotice } from '@renderer/contrib/git/GitRepositoryNotice'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { toast } from '@renderer/core/toast'
import './work-git-panel.css'

export interface WorkGitPanelProps {
  cwd: string | null | undefined
  sessionId?: string | null
  active?: boolean
  workspaceRunId?: string | null
  onOpenFile?: (path: string) => void
  onOpenDiff?: (path: string, staged: boolean) => void
}

function label(change: GitFileChange): string {
  return change.changeType === 'untracked'
    ? '未跟踪'
    : change.changeType === 'added'
      ? '新增'
      : change.changeType === 'deleted'
        ? '删除'
        : change.changeType === 'renamed'
          ? '重命名'
          : '修改'
}
function stateClass(change: GitFileChange): string {
  return `work-git-file--${change.changeType}`
}

/** Task-owned Git transport and draft; Code selection is never overridden. */
export function WorkGitPanel({
  cwd,
  sessionId,
  active = true,
  workspaceRunId,
  onOpenFile,
  onOpenDiff
}: WorkGitPanelProps): JSX.Element {
  const { settings } = useApp()
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [branch, setBranch] = useState('')
  const [upstream, setUpstream] = useState('')
  const [ahead, setAhead] = useState<number | null>(null)
  const [behind, setBehind] = useState<number | null>(null)
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [diffError, setDiffError] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const refreshGeneration = useRef(0)
  const diffGeneration = useRef(0)
  const scopeGeneration = useRef(0)
  const mounted = useRef(false)
  const source = getEngineSource()
  const operationOwner = useMemo(() => workGitOwnerKey(source, sessionId, cwd), [source, sessionId, cwd])
  const operation = useSyncExternalStore(
    useCallback(listener => subscribeWorkGitOperation(operationOwner, listener), [operationOwner]),
    useCallback(() => getWorkGitOperation(operationOwner), [operationOwner])
  )
  const draft = useSyncExternalStore(
    useCallback(listener => subscribeWorkGitOperation(operationOwner, listener), [operationOwner]),
    useCallback(() => getWorkGitDraft(operationOwner), [operationOwner])
  )
  const repositoryOperation = useSyncExternalStore(
    useCallback(listener => subscribeWorkGitOperation(operationOwner, listener), [operationOwner]),
    useCallback(() => getWorkGitRepositoryOperation(operationOwner), [operationOwner])
  )
  const message = draft.message, proposal = draft.proposal
  const editMessage = (value: string): void => editWorkGitDraft(operationOwner, value)
  const setProposal = (value: string): void => setWorkGitProposal(operationOwner, value)
  const busy = refreshing || operation?.kind === 'mutation'
  const suggesting = operation?.kind === 'suggestion'
  const remoteAction = operation?.remoteAction ?? ''
  useLayoutEffect(() => {
    mounted.current = true
    scopeGeneration.current += 1
    setRefreshing(false)
    return () => {
      mounted.current = false
      scopeGeneration.current += 1
    }
  }, [cwd, sessionId, active, source])
  const captureScope = (): {
    generation: number
    source: ReturnType<typeof getEngineSource>
    cwd: string | null | undefined
    sessionId?: string | null
    active: boolean
  } => ({
    generation: scopeGeneration.current,
    source,
    cwd,
    sessionId,
    active
  })
  const scopeCurrent = (scope: ReturnType<typeof captureScope>): boolean =>
    mounted.current &&
    scope.generation === scopeGeneration.current &&
    scope.source === getEngineSource() &&
    scope.cwd === cwd &&
    scope.sessionId === sessionId &&
    scope.active === active

  useEffect(() => {
    const scope = captureScope()
    return subscribeWorkGitSuccess(operationOwner, success => {
      if (scope.active && scopeCurrent(scope)) toast.success(success)
    })
  }, [active, cwd, sessionId, source, operationOwner])

  useEffect(() => {
    diffGeneration.current += 1
    setSelected('')
    setDiff(null)
    setDiffError('')
    setDiffLoading(false)
    setError('')
    setFiles([])
    setIsRepo(null)
    setBranch('')
    setUpstream('')
    setAhead(null)
    setBehind(null)
  }, [cwd, sessionId, source])

  const clientFor = async (
    scope: ReturnType<typeof captureScope>
  ): Promise<{ target: GitTarget; client: ScopedGitClient }> => {
    if (!scopeCurrent(scope) || !scope.sessionId)
      throw new Error('任务工作区尚未就绪')
    const target = await captureSessionGitTarget(scope.sessionId, scope.cwd ?? '')
    if (!scopeCurrent(scope)) throw new Error('Git 任务已切换')
    return { target, client: createGitClient(target) }
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (getWorkGitOperation(operationOwner)?.kind === 'mutation') return
    const generation = ++refreshGeneration.current
    const scope = captureScope()
    const isCurrent = (): boolean => generation === refreshGeneration.current && scopeCurrent(scope)
    if (!scope.active || !scope.sessionId) {
      if (isCurrent()) {
        setFiles([])
        setIsRepo(null)
        setBranch('')
        setUpstream('')
        setAhead(null)
        setBehind(null)
        setRefreshing(false)
      }
      return
    }
    setRefreshing(true)
    setError('')
    try {
      const { client } = await clientFor(scope)
      const result = await client.gitStatus()
      if (!isCurrent()) return
      if (!result.success) throw new Error(result.error ?? '读取 Git 状态失败')
      setIsRepo(result.isRepo === true)
      setFiles(result.files ?? [])
      if (!result.isRepo) {
        setBranch('')
        setUpstream('')
        setAhead(null)
        setBehind(null)
      } else {
        const info = await client.gitBranchInfo()
        if (!info.success) throw new Error(info.error ?? '读取分支状态失败')
        if (!isCurrent()) return
        setBranch(info.info?.branch ?? '')
        setUpstream(info.info?.upstream ?? '')
        setAhead(info.info?.ahead ?? null)
        setBehind(info.info?.behind ?? null)
      }
    } catch (reason: unknown) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (isCurrent()) setRefreshing(false)
    }
  // A scratch binding may not exist until the first acknowledged run. Its
  // identity refreshes reads without retiring drafts or mutation reservations.
  }, [active, cwd, sessionId, source, operationOwner, workspaceRunId])
  useEffect(() => {
    if (active && !operation) void refresh()
  }, [active, refresh, operation])

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selected),
    [files, selected]
  )
  const run = async (
    action: (client: ScopedGitClient) => Promise<GitResult>,
    success: string,
    options: { commit?: boolean; remoteAction?: 'fetch' | 'pull' | 'push' | 'publish' } = {}
  ): Promise<void> => {
    const scope = captureScope()
    if (!scope.active || !scopeCurrent(scope) || busy || suggesting)
      return
    const owner = operationOwner, revision = getWorkGitDraft(owner).revision, commit = options.commit === true
    const reservation = beginWorkGitOperation(owner, 'mutation', options.remoteAction)
    if (!reservation) return
    setError('')
    try {
      const { target } = await clientFor(scope)
      const controller = createRepositoryOperation({
        target,
        label: success.replace(/^已/, ''),
        run: action,
        onSuccess: () => {
          if (commit) clearWorkGitDraft(owner, revision)
          publishWorkGitSuccess(owner, success)
        }
      })
      await retainWorkGitRepositoryOperation(owner, controller, reservation).start()
    } catch (reason: unknown) {
      if (scopeCurrent(scope))
        toast.error(reason instanceof Error ? reason.message : String(reason))
    } finally {
      finishWorkGitOperation(reservation)
    }
  }
  const init = (): void => {
    if (sessionId) void run(captureGitCommand('gitInit'), '已初始化 Git 仓库')
  }
  const runRemote = (action: 'fetch' | 'pull' | 'push' | 'publish'): Promise<void> =>
    run(captureGitCommand(action === 'fetch' ? 'gitFetch' : action === 'pull' ? 'gitPull' : action === 'publish' ? 'gitPublishBranch' : 'gitPush'),
      action === 'fetch' ? '已获取远程更新' : action === 'pull' ? '已拉取远程更新' : action === 'publish' ? '已发布当前分支' : '已推送本地提交',
      { remoteAction: action })
  const open = (file: GitFileChange, staged = false): void => {
    const scope = captureScope()
    if (!scope.active || !scopeCurrent(scope)) return
    const generation = ++diffGeneration.current
    const current = (): boolean => generation === diffGeneration.current && scopeCurrent(scope)
    setSelected(file.path)
    setDiff(null)
    setDiffError('')
    setDiffLoading(true)
    void clientFor(scope)
      .then(async ({ client }) => {
        const result = await client.gitDiff(file.path, staged)
        if (!current()) return
        if (!result.success) throw new Error(result.error ?? '读取文件差异失败')
        setDiff(result.diff ?? null)
        onOpenFile?.(file.path)
        onOpenDiff?.(file.path, staged)
      })
      .catch((reason: unknown) => {
        if (current()) setDiffError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current()) setDiffLoading(false)
      })
  }

  const suggestMessage = async (): Promise<void> => {
    const scope = captureScope()
    if (
      !scopeCurrent(scope) ||
      !scope.active ||
      suggesting ||
      busy
    )
      return
    const reservation = beginWorkGitOperation(operationOwner, 'suggestion')
    if (!reservation) return
    const revision = getWorkGitDraft(operationOwner).revision
    setProposal('')
    setError('')
    try {
      const { target, client } = await clientFor(scope)
      const result = await client.gitSuggestCommitMessage()
      if (!scopeCurrent(scope)) return
      if (!result.success) throw new Error(result.error ?? '生成提交信息失败')
      if (result.aiContext?.trim()) {
        const ai = await gitUtilityChat(target, {
          model: settings.utilityModelId || settings.lastModelId || undefined,
          systemPrompt:
            '你是资深工程师，请根据 git 改动摘要生成提交信息。使用中文；第一行写 Conventional Commits 标题；标题后空一行，再写 3-6 条编号正文要点；只根据提供的内容，不要输出解释、引号或代码围栏。',
          userPrompt: `请生成完整的标题和正文提交信息：\n\n${result.aiContext}`,
          temperature: 0.35,
          maxTokens: 2000
        })
        if (!scopeCurrent(scope)) return
        const cleaned = cleanAiCommitMessage(ai.text)
        if (cleaned) {
          if (getWorkGitDraft(operationOwner).revision === revision) editMessage(cleaned)
          else setProposal(cleaned)
          return
        }
      }
      if (!scopeCurrent(scope)) return
      if (result.message?.trim()) {
        if (getWorkGitDraft(operationOwner).revision === revision) editMessage(result.message.trim())
        else setProposal(result.message.trim())
      } else throw new Error('AI 返回了空内容')
    } catch (reason: unknown) {
      if (scopeCurrent(scope)) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      finishWorkGitOperation(reservation)
    }
  }

  if (!sessionId)
    return (
      <div className="work-git-panel work-git-panel--empty">
        <Icon name="git" size={24} />
        <strong>任务工作区尚未就绪</strong>
        <span>任务建立后即可管理它的独立工作区或项目目录。</span>
      </div>
    )
  if (isRepo === false)
    return (
      <section className="work-git-panel" aria-label="Git">
        <GitRepositoryNotice operation={repositoryOperation} onRefresh={refresh} />
      <div className="work-git-panel work-git-panel--empty">
        <Icon name="git" size={24} />
        <strong>当前目录不是 Git 仓库</strong>
        <span>{cwd || '独立任务工作区'}</span>
        <button type="button" className="btn btn--primary" onClick={init} disabled={busy || suggesting}>
          {busy ? '初始化中…' : '初始化 Git 仓库'}
        </button>
      </div>
      </section>
    )
  const staged = files.filter((file) => file.stagedChange)
  const unstaged = files.filter((file) => file.unstagedChange || !file.stagedChange)
  const stageable = unstaged.filter(
    (file) => file.unstagedChange || file.changeType === 'untracked'
  )
  const renderFile = (file: GitFileChange, isStaged: boolean): JSX.Element => (
    <div
      className={`work-git-file ${stateClass(file)} ${selected === file.path ? 'is-selected' : ''}`}
      key={`${isStaged ? 's' : 'u'}:${file.path}`}
    >
      <button type="button" className="work-git-file__main" onClick={() => open(file, isStaged)}>
        <Icon name="file" size={15} />
        <span title={file.path}>{file.path}</span>
        <em>{label(file)}</em>
      </button>
      <button
        type="button"
        className="work-git-file__action"
        disabled={busy || suggesting}
        aria-label={isStaged ? `取消暂存 ${file.path}` : `暂存 ${file.path}`}
        onClick={() =>
          void run(
            captureGitCommand(isStaged ? 'gitUnstage' : 'gitStage', file.path),
            isStaged ? '已取消暂存' : '已暂存'
          )
        }
      >
        {isStaged ? '−' : '+'}
      </button>
    </div>
  )
  return (
    <section className="work-git-panel" aria-label="Git">
      <header className="work-git-panel__header">
        <div>
          <strong>Git</strong>
          <span>
            {branch || '当前分支'}
            {upstream ? ` · ${upstream}` : ''} · {files.length} 个文件
          </span>
        </div>
        <div className="work-git-panel__header-actions">
          {branch && (
            <button
              type="button"
              className="work-quiet-button"
              onClick={() => void runRemote('pull')}
              disabled={busy || suggesting || !upstream}
              title={upstream ? '拉取远程更新' : '当前分支尚未发布，无法拉取'}
            >
              {remoteAction === 'pull' ? (
                <Spinner size={14} />
              ) : (
                <Icon name="source-pull" size={14} />
              )}
              拉取{behind ? ` ${behind}` : ''}
            </button>
          )}
          {branch && (
            <button
              type="button"
              className="work-quiet-button"
              onClick={() => void runRemote(upstream ? 'push' : 'publish')}
              disabled={busy || suggesting}
              title={upstream ? '推送本地提交' : '发布当前分支'}
            >
              {remoteAction === 'push' || remoteAction === 'publish' ? (
                <Spinner size={14} />
              ) : (
                <Icon name="cloud-upload-outline" size={14} />
              )}
              {upstream ? '推送' : '发布'}
              {ahead ? ` ${ahead}` : ''}
            </button>
          )}
          {
            <button
              type="button"
              className="work-quiet-button"
              onClick={() => void runRemote('fetch')}
              disabled={busy || suggesting}
              title="获取远程更新"
            >
              {remoteAction === 'fetch' ? (
                <Spinner size={14} />
              ) : (
                <Icon name="cloud-download-outline" size={14} />
              )}
              获取
            </button>
          }
          <button
            type="button"
            className="work-quiet-button"
            onClick={() => void refresh()}
            disabled={busy || suggesting}
          >
            <Icon name="sync" size={14} />
            刷新
          </button>
        </div>
      </header>
      <GitRepositoryNotice operation={repositoryOperation} onRefresh={refresh} />
      {error && (
        <div role="alert" className="work-git-panel__error">
          {error}
        </div>
      )}
      <div className="work-git-panel__toolbar">
        <div className="work-git-panel__commit-input">
          <textarea
            rows={3}
            value={message}
            onChange={(event) => editMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && message.trim()) {
                event.preventDefault()
                void run(
                  captureGitCommand(staged.length > 0 ? 'gitCommit' : 'gitStageAllAndCommit', message.trim()),
                  staged.length > 0 ? '已提交' : '已暂存并提交', { commit: true }
                )
              }
            }}
            placeholder="提交标题与正文（Ctrl / ⌘ + Enter 提交）"
            aria-label="Git 提交信息"
          />
          <button
            type="button"
            className="work-git-panel__ai"
            onClick={() => void suggestMessage()}
            disabled={busy || suggesting || files.length === 0}
            aria-busy={suggesting}
            aria-label="AI 生成提交信息"
            title="AI 帮我写提交信息"
          >
            {suggesting ? <Spinner size={14} /> : <Icon name="sparkles" size={15} />}
          </button>
        </div>
        {stageable.length > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || suggesting}
            onClick={() =>
              void run(
                captureGitCommand('gitStageFiles', stageable.map((file) => file.path)),
                '已暂存全部更改'
              )
            }
          >
            全部暂存
          </button>
        )}
        {staged.length > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || suggesting}
            onClick={() =>
              void run(
                captureGitCommand('gitUnstageFiles', staged.map((file) => file.path)),
                '已取消全部暂存'
              )
            }
          >
            取消全部暂存
          </button>
        )}
        {staged.length > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || suggesting || !message.trim()}
            onClick={() => void run(captureGitCommand('gitCommit', message.trim()), '已提交', { commit: true })}
          >
            提交暂存
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy || suggesting || !message.trim() || files.length === 0}
          onClick={() =>
            void run(captureGitCommand('gitStageAllAndCommit', message.trim()), '已暂存并提交', { commit: true })
          }
        >
          全部提交
        </button>
      </div>
      {proposal && (
        <div className="work-git-panel__proposal" role="status">
          <span>AI 建议已生成。你的编辑已保留。</span>
          <button
            type="button"
            className="work-quiet-button"
            onClick={() => {
              editMessage(proposal)
              setProposal('')
            }}
          >
            采用建议
          </button>
          <button type="button" className="work-quiet-button" onClick={() => setProposal('')}>
            忽略
          </button>
        </div>
      )}
      <div className="work-git-panel__body">
        {busy && (
          <div className="work-git-panel__busy" role="status" aria-live="polite">
            <Spinner size={14} />
            {operation?.kind === 'mutation' ? '正在执行 Git 操作…' : '正在读取 Git 状态…'}
          </div>
        )}
        <Group title="暂存的更改" files={staged} renderFile={(file) => renderFile(file, true)} />
        <Group title="工作区更改" files={unstaged} renderFile={(file) => renderFile(file, false)} />
        {!files.length && !busy && (
          <p className="work-git-panel__clean">工作区干净，没有待提交的更改。</p>
        )}
      </div>
      {selectedFile && (
        <div className="work-git-panel__diff">
          <header>
            <strong>{selectedFile.path}</strong>
            <button
              type="button"
              className="work-quiet-button"
              onClick={() => {
                diffGeneration.current += 1
                setSelected('')
                setDiff(null)
                setDiffError('')
                setDiffLoading(false)
              }}
            >
              关闭
            </button>
          </header>
          {diffLoading ? (
            <span role="status">
              <Spinner size={14} />
              正在加载差异…
            </span>
          ) : diffError ? (
            <span role="alert" className="work-git-panel__error">
              {diffError}
            </span>
          ) : diff ? (
            <pre>
              {diff.hunks
                .flatMap((hunk) =>
                  hunk.lines.map(
                    (line) =>
                      `${line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}${line.content}`
                  )
                )
                .join('\n')}
            </pre>
          ) : (
            <span>此文件没有可显示的文本差异</span>
          )}
        </div>
      )}
    </section>
  )
}

function Group({
  title,
  files,
  renderFile
}: {
  title: string
  files: GitFileChange[]
  renderFile: (file: GitFileChange) => JSX.Element
}): JSX.Element | null {
  if (files.length === 0) return null
  return (
    <section className="work-git-group">
      <h3>
        {title}
        <span>{files.length}</span>
      </h3>
      {files.map(renderFile)}
    </section>
  )
}
