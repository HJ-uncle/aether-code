import './change-revert.css'
import './apple-chat-panels.css'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import { Icon } from '@renderer/workbench/icons'
import { onSnapshot, requestOrThrow } from '@renderer/core/engine/client'
import { dismissRevertReport, getRevertReport, groupRevertResults, revertChanges, revertComplete, revertStatusLabel, revertSummary, subscribeReverts } from '@renderer/core/engine/change-revert'
import { gitStageFiles } from '@renderer/core/git/git-client'
import { changeIdsOf, keepChanges, stageAndKeepChanges } from '@renderer/core/engine/change-actions'
import { assertEngineSource, getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { toast } from '@renderer/core/toast'
import { useApp } from '@renderer/core/app-context'
import { ActionMenu } from '@renderer/workbench/ActionMenu'

import {
  DIFF_APPROXIMATION_HINT,
  computeLineDiff,
  diffForDeletedFile,
  diffForNewFile,
  diffStats,
  type DiffStats
} from './diff'

/**
 * 改动确认面板（输入框上方）
 *
 * 列出本会话 Agent 产生的待确认文件改动：每行 = 文件名 + 目录 + 增删统计 +
 * 状态徽章 + 待确认按钮；底部 = 改动数 | 全部撤回 | 全部保留。
 *
 * 数据源是引擎的 /changes REST（SQLite 里的快照），不依赖 SSE 在线：
 * 一轮对话结束时刷新，确认/撤回后立即刷新。
 */

type ChangeBadge = 'A' | 'M' | 'D'

function badgeOf(change: EngineFileChange): ChangeBadge {
  if (change.kind === 'delete') return 'D'
  return (change.isNew ?? (!change.truncated && change.oldContent === null)) ? 'A' : 'M'
}

/** 估算增删行数；内容未存档时返回 null（不显示数字） */
function statsOf(change: EngineFileChange): DiffStats | null {
  if (change.truncated) return null
  let rows
  if (change.kind === 'delete') {
    if (change.oldContent === null) return null
    rows = diffForDeletedFile(change.oldContent)
  } else if ((change.isNew ?? (!change.truncated && change.oldContent === null))) {
    if (change.newContent === null) return null
    rows = diffForNewFile(change.newContent)
  }
  else {
    if (change.oldContent === null || change.newContent === null) return null
    rows = computeLineDiff(change.oldContent, change.newContent)
  }
  return diffStats(rows)
}

function splitPath(change: EngineFileChange): { name: string; dir: string } {
  const display = (change.displayPath || change.path).replace(/\\/g, '/')
  const index = display.lastIndexOf('/')
  if (index === -1) return { name: display, dir: '' }
  return { name: display.slice(index + 1), dir: display.slice(0, index) }
}

type ChangesPanelProps = {
  sessionId: string
  streaming: boolean
  onCountChange?: (count: number) => void
  onReportChange?: (visible: boolean) => void
  bare?: boolean
}

/** Discard rows and in-flight results when either the conversation or engine changes. */
export function ChangesPanel(props: ChangesPanelProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <ChangesPanelContent key={`${source}:${props.sessionId}`} {...props} source={source} />
}

const issueLabels: Record<NonNullable<EngineFileChange['projectionIssue']>, string> = {
  'discontinuous-history': '存在中途修改或已确认操作，按独立阶段展示',
  'later-change': '存在后续改动，撤回前将检查版本',
  'disk-diverged': '文件已被另行修改，当前展示记录中的差异',
  'path-changed': '文件路径的实际目标已变化',
  'snapshot-unavailable': '缺少完整快照，无法自动撤回',
  unreadable: '当前文件无法读取，未自动抵消记录'
}

function ChangesPanelContent({
  sessionId,
  streaming,
  onCountChange,
  onReportChange,
  bare,
  source
}: ChangesPanelProps & { source: number }): JSX.Element | null {
  const [changes, setChanges] = useState<EngineFileChange[]>([])
  const { engine } = useApp()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const workspace = useWorkspace()
  const report = useSyncExternalStore(subscribeReverts, () => getRevertReport(sessionId))
  const mounted = useRef(false)
  const refreshGeneration = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; refreshGeneration.current++ }
  }, [])

  const refresh = useCallback(async () => {
    if (!sessionId) return
    const generation = ++refreshGeneration.current
    try {
      const data = await requestOrThrow<EngineFileChange[]>({
        method: 'GET',
        path: '/changes',
        query: { sessionId, status: 'pending', view: 'net' }
      })
      if (!mounted.current || generation !== refreshGeneration.current) return
      setChanges(Array.isArray(data) ? data : [])
      setError(null)
    } catch (err) {
      if (mounted.current && generation === refreshGeneration.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [sessionId])

  // setState 放进定时器回调：effect 体内同步触发级联渲染是 lint 禁止的模式
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0)
    return () => clearTimeout(timer)
  }, [refresh, report])

  useEffect(() => onSnapshot((snapshot) => {
    if (snapshot.phase === 'ready') { setError(null); void refresh() }
  }), [refresh])

  // 一轮对话结束（true→false）时快照刚落库，此时刷新
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refresh()
    wasStreaming.current = streaming
  }, [streaming, refresh])

  // 受控模式下向父级托盘上报改动数
  useEffect(() => {
    onCountChange?.(changes.length)
  }, [changes.length, onCountChange])

  useEffect(() => {
    onReportChange?.(Boolean(report || error))
  }, [report, error, onReportChange])

  const act = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      if (remoteReadOnly) return
      if (!mounted.current) return
      setBusy(true)
      setError(null)
      try {
        assertEngineSource(source)
        await action()
        await refresh()
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [refresh, remoteReadOnly, source]
  )

  const keepOne = (change: EngineFileChange): Promise<void> =>
    act(() => keepChanges(requestOrThrow, sessionId, [change]))

  const revertOne = (change: EngineFileChange): Promise<void> =>
    act(() => revertChanges(requestOrThrow, { sessionId, ids: changeIdsOf([change]), scope: 'all' }))

  /** 版本匹配才恢复；冲突和缺失快照均保留原文件并逐项报告。 */
  const confirmRevert = async (message: string, run: () => Promise<void>): Promise<void> => {
    const ok = await confirmDialog({
      title: '撤回改动',
      body: `${message}\n\n仅恢复版本匹配的改动；冲突或缺少快照的文件将保留并报告。`,
      confirmText: '撤回',
      danger: true
    })
    if (!ok) return
    await run()
  }

  const revertOneWithConfirm = (change: EngineFileChange): Promise<void> =>
    confirmRevert(
      `撤回对 ${change.displayPath || change.path} 的改动？文件将按快照恢复到改动前。`,
      () => revertOne(change)
    )

  const keepAll = (): Promise<void> =>
    act(() => requestOrThrow({ method: 'POST', path: '/changes/keep-all', body: { sessionId } }))

  /**
   * 暂存 = git add + 保留（对齐 wuzu-client 的 keepAndStage 语义）。
   * 保留失败时保留暂存结果并报告，不能用 unstage 抹掉用户已有的暂存。
   */
  const stageChanges = useCallback(
    async (targets: EngineFileChange[]): Promise<void> => {
      if (remoteReadOnly) return
      if (!mounted.current) return
      setBusy(true)
      setError(null)
      try {
        assertEngineSource(source)
        const root = workspace.root
        if (!root) throw new Error('未打开工作区，无法暂存')
        const staged = await stageAndKeepChanges(
          paths => gitStageFiles(root, paths),
          input => { assertEngineSource(source); return requestOrThrow(input) },
          sessionId,
          targets
        )
        if (!staged) {
          toast.warning('没有可暂存的改动（全部被 .gitignore 忽略或文件已不存在）')
          return
        }
        await refresh()
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [refresh, remoteReadOnly, sessionId, source, workspace.root]
  )

  const revertAll = async (): Promise<void> =>
    confirmRevert(
      '撤回本会话全部待确认改动？同一文件会按操作顺序恢复。',
      () => act(() => revertChanges(requestOrThrow, { sessionId, scope: 'pending' }))
    )

  if (changes.length === 0 && !report && !error) return null

  return (
    <div className="changes-panel">
      {report ? (
        <section className="changes-panel__report" aria-label="文件回退结果" aria-live="polite">
          <div>{revertSummary(report)}</div>
          {!revertComplete(report) ? <div>部分改动未恢复，请查看下列文件。</div> : null}
          <details open={!revertComplete(report)}>
            <summary>逐文件结果</summary>
            <ul>
              {groupRevertResults(report).map(({ path, items }) => (
                <li key={path}>
                  <span title={path}>{path.replace(/\\/g, '/')}</span>
                  {' — '}{Array.from(new Set(items.map((item) => item.status))).map((status) => (
                    <span key={status}>{revertStatusLabel[status]} {items.filter((item) => item.status === status).length} 处；</span>
                  ))}
                  {Array.from(new Set(items.map((item) => item.message).filter(Boolean))).map((message) => (
                    <div key={message}>{message}</div>
                  ))}
                </li>
              ))}
            </ul>
          </details>
          <button type="button" className="changes-panel__footer-btn" onClick={() => dismissRevertReport(sessionId)}>关闭结果</button>
        </section>
      ) : null}
      <ul className="changes-panel__list">        {changes.map((change) => {
          const { name, dir } = splitPath(change)
          const stats = statsOf(change)
          const badge = badgeOf(change)
          return (
            <li key={change.id} className="changes-panel__item">
              <Icon name="file" size={16} />
              <span className="changes-panel__identity">
                <span className="changes-panel__name" title={change.displayPath || change.path}>
                  {name}
                </span>
                {dir ? <span className="changes-panel__dir" title={dir}>{dir}</span> : null}
              </span>
              {change.projectionIssue ? <span title={issueLabels[change.projectionIssue]} aria-label={issueLabels[change.projectionIssue]}>⚠</span> : null}
              <span className="changes-panel__spacer" />
              {stats ? (
                <span className="changes-panel__stats" title={stats.approximate ? DIFF_APPROXIMATION_HINT : undefined}>
                  {stats.added > 0 ? (
                    <span className="changes-panel__add">{stats.approximate ? '≈' : ''}+{stats.added}</span>
                  ) : null}
                  {stats.removed > 0 ? (
                    <span className="changes-panel__del">{stats.approximate ? '≈' : ''}-{stats.removed}</span>
                  ) : null}
                </span>
              ) : null}
              <span className={`changes-panel__badge changes-panel__badge--${badge.toLowerCase()}`}>
                {badge}
              </span>
              <button
                type="button"
                className="changes-panel__confirm"
                disabled={remoteReadOnly || busy || streaming}
                title="确认保留本组文件改动"
                onClick={() => void keepOne(change)}
              >
                保留
              </button>
              <ActionMenu
                label={`${name} 的更多操作`}
                disabled={remoteReadOnly || busy || streaming}
                items={[
                  {
                    id: 'stage',
                    label: '暂存并保留',
                    description: '写入 Git 暂存区后移除待确认记录',
                    icon: 'copy',
                    disabled: !workspace.root || remoteReadOnly || busy || streaming,
                    onSelect: () => stageChanges([change])
                  },
                  {
                    id: 'revert',
                    label: '撤回改动',
                    description: '检查版本后恢复到改动前',
                    icon: 'restart',
                    danger: true,
                    disabled: remoteReadOnly || busy || streaming,
                    onSelect: () => revertOneWithConfirm(change)
                  }
                ]}
              />
            </li>
          )
        })}
      </ul>

      {error ? <div className="changes-panel__error">{error}</div> : null}
      {remoteReadOnly && changes.length > 0 ? <div>远端改动快照只读；尚未配置工作区映射，不能撤回或暂存到本地仓库。</div> : null}

      {changes.length > 1 ? (
        <div className="changes-panel__footer">
          {bare ? null : <span className="changes-panel__count">改动 {changes.length}</span>}
          <span className="changes-panel__spacer" />
          <button
            type="button"
            className="changes-panel__footer-btn"
            disabled={remoteReadOnly || busy || streaming}
            title="检查版本后撤回本会话全部待确认改动"
            onClick={() => void revertAll()}
          >
            <Icon name="restart" size={16} />
            全部撤回
          </button>
          <button
            type="button"
            className="changes-panel__footer-btn"
            disabled={remoteReadOnly || busy || streaming || !workspace.root}
            title="暂存所列文件的当前全部内容，并保留改动记录"
            onClick={() => void stageChanges(changes)}
          >
            <Icon name="copy" size={16} />
            全部暂存
          </button>
          <button
            type="button"
            className="changes-panel__footer-btn changes-panel__footer-btn--keep"
            disabled={remoteReadOnly || busy || streaming}
            title="确认保留全部改动（从待确认列表移除）"
            onClick={() => void keepAll()}
          >
            <Icon name="check" size={16} />
            全部保留
          </button>
        </div>
      ) : null}
    </div>
  )
}
