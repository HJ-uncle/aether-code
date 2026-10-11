import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { GitFileChange, GitFileDiff } from '@shared/git-types'
import {
  gitBranchInfo,
  gitCommit,
  gitDiff,
  gitFetch,
  gitInit,
  gitPull,
  gitPush,
  gitPublishBranch,
  gitStage,
  gitStageAllAndCommit,
  gitStageFiles,
  gitStatus,
  gitSuggestCommitMessage,
  gitUnstage,
  gitUnstageFiles
} from '@renderer/core/git/git-client'
import { utilityChat } from '@renderer/core/engine/utility-chat'
import { useApp } from '@renderer/core/app-context'
import { isRemoteEngine } from '@renderer/core/engine/source'
import { setWorkspaceSessionOverride } from '@renderer/core/workspace/connection'
import { cleanAiCommitMessage } from '@renderer/contrib/git/GitCommitBar'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { toast } from '@renderer/core/toast'
import './work-git-panel.css'

export interface WorkGitPanelProps { cwd: string | null | undefined; sessionId?: string | null; active?: boolean; onOpenFile?: (path: string) => void; onOpenDiff?: (path: string, staged: boolean) => void }

function label(change: GitFileChange): string { return change.changeType === 'untracked' ? '未跟踪' : change.changeType === 'added' ? '新增' : change.changeType === 'deleted' ? '删除' : change.changeType === 'renamed' ? '重命名' : '修改' }
function stateClass(change: GitFileChange): string { return `work-git-file--${change.changeType}` }

/** A compact, cwd-scoped Git loop for Work. It intentionally uses git-client
 * directly instead of the Code singleton store, so two Work sessions cannot
 * overwrite Code's selected repository. */
export function WorkGitPanel({ cwd, sessionId, active = true, onOpenFile, onOpenDiff }: WorkGitPanelProps): JSX.Element {
  const { settings } = useApp()
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [branch, setBranch] = useState('')
  const [upstream, setUpstream] = useState('')
  const [ahead, setAhead] = useState<number | null>(null)
  const [behind, setBehind] = useState<number | null>(null)
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState<string>('')
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [remoteAction, setRemoteAction] = useState<'fetch' | 'pull' | 'push' | 'publish' | ''>('')
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (active && isRemoteEngine() && sessionId) {
      setWorkspaceSessionOverride({ sessionId })
      return () => setWorkspaceSessionOverride(null)
    }
    return undefined
  }, [active, sessionId])

  useEffect(() => {
    setSelected('')
    setDiff(null)
    setMessage('')
    setError('')
  }, [cwd])

  const refresh = useCallback(async (): Promise<void> => {
    if (!active || !cwd) { setFiles([]); setIsRepo(null); return }
    setBusy(true); setError('')
    try {
      const result = await gitStatus(cwd)
      if (!result.success) throw new Error(result.error ?? '读取 Git 状态失败')
      setIsRepo(result.isRepo === true)
      setFiles(result.files ?? [])
      if (!result.isRepo) {
        setBranch('')
        setUpstream('')
        setAhead(null)
        setBehind(null)
      }
      else {
        const info = await gitBranchInfo(cwd)
        setBranch(info.info?.branch ?? '')
        setUpstream(info.info?.upstream ?? '')
        setAhead(info.info?.ahead ?? null)
        setBehind(info.info?.behind ?? null)
      }
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }, [active, cwd])
  useEffect(() => { if (active) void refresh() }, [active, refresh])

  const selectedFile = useMemo(() => files.find((file) => file.path === selected), [files, selected])
  const run = async (action: () => Promise<{ success: boolean; error?: string }>, success: string): Promise<void> => {
    setBusy(true)
    try { const result = await action(); if (!result.success) throw new Error(result.error ?? 'Git 操作失败'); toast.success(success); await refresh() }
    catch (reason: unknown) { toast.error(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const init = (): void => { if (cwd) void run(() => gitInit(cwd), '已初始化 Git 仓库') }
  const runRemote = async (action: 'fetch' | 'pull' | 'push' | 'publish'): Promise<void> => {
    if (!cwd || busy || suggesting) return
    setBusy(true)
    setRemoteAction(action)
    setError('')
    try {
      const result = action === 'fetch' ? await gitFetch(cwd) : action === 'pull' ? await gitPull(cwd) : action === 'publish' ? await gitPublishBranch(cwd) : await gitPush(cwd)
      if (!result.success) throw new Error(result.error ?? 'Git 远程操作失败')
      toast.success(action === 'fetch' ? '已获取远程更新' : action === 'pull' ? '已拉取远程更新' : action === 'publish' ? '已发布当前分支' : '已推送本地提交')
      await refresh()
    } catch (reason: unknown) {
      const text = reason instanceof Error ? reason.message : String(reason)
      setError(text)
      toast.error(text)
    } finally {
      setRemoteAction('')
      setBusy(false)
    }
  }
  const open = (file: GitFileChange, staged = false): void => {
    setSelected(file.path)
    onOpenFile?.(file.path)
    onOpenDiff?.(file.path, staged)
    void gitDiff(cwd!, file.path, staged).then((result) => setDiff(result.diff ?? null)).catch(() => setDiff(null))
  }

  const suggestMessage = async (): Promise<void> => {
    if (!cwd || suggesting || busy) return
    setSuggesting(true)
    setError('')
    try {
      const result = await gitSuggestCommitMessage(cwd)
      if (!result.success) throw new Error(result.error ?? '生成提交信息失败')
      if (result.aiContext?.trim()) {
        try {
          const ai = await utilityChat({
            model: settings.utilityModelId || settings.lastModelId || undefined,
            systemPrompt: '你是资深工程师，请根据 git 改动摘要生成提交信息。使用中文；第一行写 Conventional Commits 标题；标题后空一行，再写 3-6 条编号正文要点；只根据提供的内容，不要输出解释、引号或代码围栏。',
            userPrompt: `请生成完整的标题和正文提交信息：\n\n${result.aiContext}`,
            temperature: 0.35,
            maxTokens: 2000
          })
          const cleaned = cleanAiCommitMessage(ai.text)
          if (cleaned) {
            setMessage(cleaned)
            return
          }
        } catch {
          // Keep the deterministic server-side suggestion when the utility model is unavailable.
        }
      }
      if (result.message?.trim()) setMessage(result.message.trim())
      else throw new Error('AI 返回了空内容')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSuggesting(false)
    }
  }

  if (!cwd) return <div className="work-git-panel work-git-panel--empty"><Icon name="git" size={24} /><strong>选择工作目录后管理 Git</strong><span>为当前 Work 任务选择一个项目目录，Git 状态会显示在这里。</span></div>
  if (isRepo === false) return <div className="work-git-panel work-git-panel--empty"><Icon name="git" size={24} /><strong>当前目录不是 Git 仓库</strong><span>{cwd}</span><button type="button" className="btn btn--primary" onClick={init} disabled={busy}>{busy ? '初始化中…' : '初始化 Git 仓库'}</button></div>
  const staged = files.filter((file) => file.stagedChange)
  const unstaged = files.filter((file) => file.unstagedChange || !file.stagedChange)
  const stageable = unstaged.filter((file) => file.unstagedChange || file.changeType === 'untracked')
  const renderFile = (file: GitFileChange, isStaged: boolean): JSX.Element => <div className={`work-git-file ${stateClass(file)} ${selected === file.path ? 'is-selected' : ''}`} key={`${isStaged ? 's' : 'u'}:${file.path}`}><button type="button" className="work-git-file__main" onClick={() => open(file, isStaged)}><Icon name="file" size={15} /><span title={file.path}>{file.path}</span><em>{label(file)}</em></button><button type="button" className="work-git-file__action" aria-label={isStaged ? `取消暂存 ${file.path}` : `暂存 ${file.path}`} onClick={() => void run(() => (isStaged ? gitUnstage(cwd, file.path) : gitStage(cwd, file.path)), isStaged ? '已取消暂存' : '已暂存')}>{isStaged ? '−' : '+'}</button></div>
  return <section className="work-git-panel" aria-label="Git">
    <header className="work-git-panel__header"><div><strong>Git</strong><span>{branch || '当前分支'}{upstream ? ` · ${upstream}` : ''} · {files.length} 个文件</span></div><div className="work-git-panel__header-actions">{branch && <button type="button" className="work-quiet-button" onClick={() => void runRemote('pull')} disabled={busy || suggesting || !upstream} title={upstream ? '拉取远程更新' : '当前分支尚未发布，无法拉取'}>{remoteAction === 'pull' ? <Spinner size={14} /> : <Icon name="source-pull" size={14} />}拉取{behind ? ` ${behind}` : ''}</button>}{branch && <button type="button" className="work-quiet-button" onClick={() => void runRemote(upstream ? 'push' : 'publish')} disabled={busy || suggesting} title={upstream ? '推送本地提交' : '发布当前分支'}>{remoteAction === 'push' || remoteAction === 'publish' ? <Spinner size={14} /> : <Icon name="cloud-upload-outline" size={14} />}{upstream ? '推送' : '发布'}{ahead ? ` ${ahead}` : ''}</button>}{<button type="button" className="work-quiet-button" onClick={() => void runRemote('fetch')} disabled={busy || suggesting} title="获取远程更新">{remoteAction === 'fetch' ? <Spinner size={14} /> : <Icon name="cloud-download-outline" size={14} />}获取</button>}<button type="button" className="work-quiet-button" onClick={() => void refresh()} disabled={busy || suggesting}><Icon name="sync" size={14} />刷新</button></div></header>
    {error && <div className="work-git-panel__error">{error}</div>}
    <div className="work-git-panel__toolbar"><div className="work-git-panel__commit-input"><input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' && !event.shiftKey && message.trim()) { event.preventDefault(); void run(() => staged.length > 0 ? gitCommit(cwd, message.trim()) : gitStageAllAndCommit(cwd, message.trim()), staged.length > 0 ? '已提交' : '已暂存并提交') } }} placeholder="提交信息" aria-label="Git 提交信息" /><button type="button" className="work-git-panel__ai" onClick={() => void suggestMessage()} disabled={busy || suggesting || files.length === 0} aria-busy={suggesting} aria-label="AI 生成提交信息" title="AI 帮我写提交信息">{suggesting ? <Spinner size={14} /> : <Icon name="sparkles" size={15} />}</button></div>{stageable.length > 0 && <button type="button" className="btn btn--sm" disabled={busy || suggesting} onClick={() => void run(() => gitStageFiles(cwd, stageable.map((file) => file.path)), '已暂存全部更改')}>全部暂存</button>}{staged.length > 0 && <button type="button" className="btn btn--sm" disabled={busy || suggesting} onClick={() => void run(() => gitUnstageFiles(cwd, staged.map((file) => file.path)), '已取消全部暂存')}>取消全部暂存</button>}{staged.length > 0 && <button type="button" className="btn btn--sm" disabled={busy || suggesting || !message.trim()} onClick={() => void run(() => gitCommit(cwd, message.trim()), '已提交')} >提交暂存</button>}<button type="button" className="btn btn--sm" disabled={busy || suggesting || !message.trim() || files.length === 0} onClick={() => void run(() => gitStageAllAndCommit(cwd, message.trim()), '已暂存并提交')}>全部提交</button></div>
    <div className="work-git-panel__body">{busy && <div className="work-git-panel__busy"><Spinner size={14} />正在更新…</div>}<Group title="暂存的更改" files={staged} renderFile={(file) => renderFile(file, true)} /><Group title="工作区更改" files={unstaged} renderFile={(file) => renderFile(file, false)} />{!files.length && !busy && <p className="work-git-panel__clean">工作区干净，没有待提交的更改。</p>}</div>
    {selectedFile && <div className="work-git-panel__diff"><header><strong>{selectedFile.path}</strong><button type="button" className="work-quiet-button" onClick={() => setDiff(null)}>关闭</button></header>{diff ? <pre>{diff.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}${line.content}`)).join('\n')}</pre> : <span>选择文件查看差异</span>}</div>}
  </section>
}

function Group({ title, files, renderFile }: { title: string; files: GitFileChange[]; renderFile: (file: GitFileChange) => JSX.Element }): JSX.Element | null {
  if (files.length === 0) return null
  return <section className="work-git-group"><h3>{title}<span>{files.length}</span></h3>{files.map(renderFile)}</section>
}
