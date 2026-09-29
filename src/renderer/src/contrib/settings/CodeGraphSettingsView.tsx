import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { Icon } from '@renderer/workbench/icons'
import { SettingsContent, SettingsGroup } from './SettingsGroup'

/**
 * 代码图索引设置
 *
 * 展示当前项目的代码图（codegraph）索引状态与规模，并提供「重建索引」：
 * 删库重建后全量重新索引，用于索引异常 / 大量依赖变更后的修复。
 * 与对话页脚的「建索引」共用同一条引擎链路（POST /codegraph/index），
 * 这里固定传 force:true —— 已有索引时不再提示「已有索引」而是直接重建。
 */

interface CgStats {
  nodeCount?: number
  edgeCount?: number
  fileCount?: number
  dbSizeBytes?: number
}

interface CgRun {
  root: string
  mode?: 'create' | 'rebuild'
  phase: 'preparing' | 'indexing' | 'complete' | 'failed'
  progress: { phase: string; current: number; total: number } | null
  error?: string
  filesIndexed?: number
}

interface CgStatus {
  root: string
  initialized: boolean
  indexing: boolean
  run: CgRun | null
  stats?: CgStats
}

function fmtBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function CodeGraphSettingsView(): JSX.Element {
  const workspace = useWorkspace()
  const [status, setStatus] = useState<CgStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!workspace.root) {
      setStatus(null)
      return
    }
    try {
      const s = await requestOrThrow<CgStatus>({
        method: 'GET',
        path: '/codegraph/status',
        query: { path: workspace.root ?? undefined }
      })
      setStatus(s)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message.slice(0, 80) : '状态查询失败')
    }
  }, [workspace.root])

  /** 索引任务期间轮询状态，结束后停在最终结果（status 自带统计） */
  const poll = useCallback(() => {
    stopPoll()
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const s = await requestOrThrow<CgStatus>({
            method: 'GET',
            path: '/codegraph/status',
            query: { path: workspace.root ?? undefined }
          })
          setStatus(s)
          if (!s.indexing) {
            stopPoll()
            setWorking(false)
          }
        } catch {
          stopPoll()
          setWorking(false)
          setActionError('状态查询失败')
        }
      })()
    }, 1500)
  }, [workspace.root, stopPoll])

  // 切换页面会让本组件卸载再挂载：卸载时必须停掉旧定时器，否则会泄漏多个轮询。
  useEffect(() => stopPoll, [stopPoll])

  // 打开设置页 / 切换项目 / 重新挂载时加载一次。
  // refresh 开头可能同步 setState，挪进微任务避免 effect 执行期内联触发级联渲染
  useEffect(() => {
    void Promise.resolve().then(refresh)
  }, [refresh])

  // 挂载时若任务仍在进行，续上轮询 —— 否则进度会永远停在离开页面那一刻的快照上。
  // 依赖只看 indexing 的翻转，不会因每次进度更新反复重启定时器。
  useEffect(() => {
    if (status?.indexing) poll()
    else stopPoll()
  }, [status?.indexing, poll, stopPoll])

  const rebuild = useCallback(async () => {
    if (!workspace.root || working) return
    setWorking(true)
    setActionError(null)
    try {
      const r = await requestOrThrow<{ started: boolean; alreadyRunning?: boolean }>({
        method: 'POST',
        path: '/codegraph/index',
        body: { path: workspace.root, force: true }
      })
      if (r.started) {
        poll()
      } else {
        setWorking(false)
        setActionError(r.alreadyRunning ? '已有索引任务进行中' : '无法启动索引任务')
      }
    } catch (e) {
      setWorking(false)
      setActionError(e instanceof Error ? e.message.slice(0, 80) : '请求失败')
    }
  }, [workspace.root, working, poll])

  const run = status?.run
  const runActive = status?.indexing === true
  const runLabel =
    run?.phase === 'failed'
      ? `上次任务失败${run.error ? `：${run.error.slice(0, 60)}` : ''}`
      : run?.phase === 'complete'
        ? `上次任务完成（${run.mode === 'rebuild' ? '重建' : '创建'}，${run.filesIndexed ?? 0} 个文件）`
        : null

  return (
    <div className="settings-view">
      <SettingsGroup
        title="代码图索引"
        footer="建索引时自动排除依赖与构建产物（node_modules、dist、build、out 等），并遵循项目内的 .gitignore 规则；对话页脚的「建索引」按钮可完成首次创建，已有索引时无需重复操作。"
      >
        <SettingsContent>
          {!workspace.root ? (
            <p className="sg__note">先打开一个项目目录，再在这里管理它的代码图索引。</p>
          ) : status == null && !loadError ? (
            <p className="sg__note">正在加载索引状态…</p>
          ) : (
            <dl className="kv">
              <dt>项目</dt>
              <dd className="kv__mono" title={status?.root ?? workspace.root}>
                {workspace.root.replace(/\\/g, '/').split('/').pop()}
              </dd>
              <dt>状态</dt>
              <dd>
                {status?.initialized ? '已建立索引' : loadError ? '状态查询失败' : '未建立索引'}
              </dd>
              {status?.stats ? (
                <>
                  <dt>文件</dt>
                  <dd>{status.stats.fileCount ?? 0}</dd>
                  <dt>符号节点</dt>
                  <dd>{status.stats.nodeCount ?? 0}</dd>
                  <dt>关系边</dt>
                  <dd>{status.stats.edgeCount ?? 0}</dd>
                  <dt>索引大小</dt>
                  <dd>{fmtBytes(status.stats.dbSizeBytes)}</dd>
                </>
              ) : null}
              {runActive && run ? (
                <>
                  <dt>进度</dt>
                  <dd>
                    {run.mode === 'rebuild' ? '重建中' : '建索引中'}
                    {run.progress
                      ? ` · ${run.progress.phase} ${run.progress.current}/${run.progress.total}`
                      : '…'}
                  </dd>
                </>
              ) : runLabel ? (
                <>
                  <dt>最近任务</dt>
                  <dd>{runLabel}</dd>
                </>
              ) : null}
            </dl>
          )}
          {loadError ? <div className="settings-view__error">{loadError}</div> : null}
          {run?.phase === 'failed' && run.error ? (
            <div className="settings-view__error">{run.error.slice(0, 120)}</div>
          ) : null}
          {actionError ? <div className="settings-view__error">{actionError}</div> : null}
        </SettingsContent>
      </SettingsGroup>

      <div className="settings-view__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!workspace.root || working || runActive}
          title={
            status?.initialized
              ? '丢弃现有索引并全量重建（依赖大量变更或索引异常时使用；依赖目录、构建产物等会被自动排除）'
              : '为当前项目创建代码图索引（Agent 随之可查询符号 / 调用关系 / 影响面）'
          }
          onClick={() => void rebuild()}
        >
          <Icon name="restart" size={16} />
          {status?.initialized ? '重建索引' : '创建索引'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!workspace.root || working}
          onClick={() => void refresh()}
        >
          刷新状态
        </button>
      </div>
    </div>
  )
}
