/**
 * 分支切换栏（当前分支 + ahead/behind 徽标 + 分支切换浮层）
 *
 * 移植自 wuzu-client components/code/GitBranchBar.vue。源组件用 element-plus 的
 * filterable+allow-create el-select；aether 没有等价物，落地为 workbench Popover
 * + 内置搜索框：输入即过滤本地/远程分支，无匹配项时提供「创建新分支」入口
 * （用 PromptDialog 确认名字，与仓库既有新建交互一致）。
 *
 * 功能对齐源组件：
 * - 打开浮层时刷新本地 + 远程分支列表（Popover 的 trigger render-prop 拿到 open，
 *   用 ref 比对前后值实现 visible-change 语义）；
 * - 本地分支当前分支置顶（sortedBranchesOf），行内显示相对时间与最新提交摘要；
 * - 远程分支排除已被本地同名分支跟踪的，检出走 checkout（主进程自动 --track）；
 * - 写操作进行中（busyOperationOf 非空）禁用切换，避免并发抢 index.lock；
 * - 右侧附 fetch/pull/push/sync 菜单（ContextMenu），与源面板工具链一致。
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  useGitStore,
  busyOperationOf,
  sortedBranchesOf,
  loadBranches,
  loadRemoteBranches,
  checkout,
  createBranch,
  fetchRemote,
  pull,
  push,
  sync,
  type GitStoreState
} from '../../core/git/git-store'
import { Popover } from '../../workbench/Popover'
import { ContextMenu, type ContextMenuItem } from '../../workbench/ContextMenu'
import { PromptDialog } from '../../workbench/PromptDialog'
import { Icon } from '../../workbench/icons'

/** 相对时间（对齐 wuzu timelineFormat.relativeTime；aether 暂无该工具，就地实现） */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  if (diff < 365 * day) return `${Math.max(1, Math.floor(diff / (30 * day)))} 个月前`
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface BranchRow {
  name: string
  current: boolean
  remote: boolean
  when: string
  detail: string
}

function buildRows(s: GitStoreState): { local: BranchRow[]; remote: BranchRow[] } {
  const local = sortedBranchesOf(s).map((name) => {
    const info = s.branchInfos.find((i) => i.name === name)
    return {
      name,
      current: name === s.branch,
      remote: false,
      when: info?.date ? relativeTime(info.date) : '',
      detail: info?.subject ? `${info.subject}${info.author ? ` · @${info.author}` : ''}` : ''
    }
  })
  const remote = s.remoteBranches
    .filter((name) => !s.branches.includes(name.split('/').slice(1).join('/')))
    .map((name) => {
      const info = s.remoteBranchInfos.find((i) => i.name === name)
      return {
        name,
        current: false,
        remote: true,
        when: info?.date ? relativeTime(info.date) : '',
        detail: info?.subject ? `${info.subject}${info.author ? ` · @${info.author}` : ''}` : ''
      }
    })
  return { local, remote }
}

interface GitBranchBarProps {
  /** 摆放位置：top 向下弹，bottom 向上弹（对齐源组件的 placement 语义） */
  position?: 'top' | 'bottom'
}

export function GitBranchBar({ position = 'bottom' }: GitBranchBarProps): JSX.Element {
  const s = useGitStore()
  const busy = busyOperationOf(s) !== ''
  const [keyword, setKeyword] = useState('')
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [feedback, setFeedback] = useState('')
  /** 上一次 Popover 的 open 值：render-prop 没有 onOpen 回调，靠渲染期比对模拟 visible-change */
  const prevOpenRef = useRef(false)

  const { local, remote } = useMemo(() => buildRows(s), [s])
  const kw = keyword.trim().toLowerCase()
  const match = (r: BranchRow): boolean =>
    !kw || r.name.toLowerCase().includes(kw) || r.detail.toLowerCase().includes(kw)
  const localRows = local.filter(match)
  const remoteRows = remote.filter(match)
  /** 关键字与任何本地分支都不同名时，允许作为新分支名创建 */
  const canCreate = kw.length > 0 && !s.branches.some((b) => b.toLowerCase() === kw)

  const run = async (
    action: () => Promise<{ success: boolean; error?: string }>,
    ok: string
  ): Promise<void> => {
    const res = await action()
    setFeedback(res.success ? ok : (res.error ?? '操作失败'))
  }

  // 操作结果提示只是瞬时反馈，常驻会让人误以为还有事情没完成：几秒后自动消失
  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(''), 3000)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const switchTo = (row: BranchRow): void => {
    if (row.current) return
    void run(
      () => checkout(row.name),
      row.remote ? `已检出远程分支 ${row.name}` : `已切换到 ${row.name}`
    )
  }

  const menuItems: ContextMenuItem[] = [
    {
      id: 'fetch',
      label: '获取（fetch）',
      disabled: busy,
      onSelect: () => void run(fetchRemote, '已获取远程更新')
    },
    {
      id: 'pull',
      label: '拉取（pull）',
      disabled: busy || !s.upstream,
      onSelect: () => void run(pull, '拉取完成')
    },
    {
      id: 'push',
      label: s.upstream ? '推送（push）' : '发布分支到 origin',
      disabled: busy,
      onSelect: () => void run(push, '推送完成')
    },
    {
      id: 'sync',
      label: '同步（先拉取再推送）',
      disabled: busy || !s.upstream,
      onSelect: () => void run(sync, '同步完成')
    }
  ]

  const renderOption = (row: BranchRow): JSX.Element => (
    <button
      key={`${row.remote ? 'r' : 'l'}:${row.name}`}
      type="button"
      className={`git-branchbar__option${row.current ? ' is-current' : ''}`}
      onClick={() => switchTo(row)}
    >
      <span className="git-branchbar__option-row">
        <Icon name={row.current ? 'check' : 'git'} size={11} />
        <span className="git-branchbar__option-name">{row.name}</span>
        {row.when ? <span className="git-branchbar__option-time">{row.when}</span> : null}
      </span>
      {row.detail ? <span className="git-branchbar__option-detail">{row.detail}</span> : null}
    </button>
  )

  return (
    <div
      className={`git-branchbar git-branchbar--${position}`}
      title={s.upstream ? `上游：${s.upstream}` : '切换 / 新建分支'}
    >
      <span className="git-branchbar__icon">
        <Icon name="git" size={13} />
      </span>

      <Popover
        placement={position === 'top' ? 'down' : 'up'}
        align="start"
        width={320}
        flush
        label="切换或新建分支"
        trigger={({ open }) => {
          if (open !== prevOpenRef.current) {
            prevOpenRef.current = open
            if (open) {
              setKeyword('')
              setFeedback('')
              void loadBranches()
              void loadRemoteBranches()
            }
          }
          return (
            <button type="button" className="git-branchbar__trigger" disabled={busy}>
              <span className="git-branchbar__name">{s.branch || '选择分支'}</span>
              {s.upstream && ((s.ahead ?? 0) > 0 || (s.behind ?? 0) > 0) ? (
                <span className="git-branchbar__badge">
                  {s.behind ? `${s.behind}↓` : ''}
                  {s.ahead ? `${s.ahead}↑` : ''}
                </span>
              ) : null}
              <Icon name="chevron" size={11} />
            </button>
          )
        }}
      >
        <div className="git-branchbar__panel">
          <input
            className="git-branchbar__search"
            value={keyword}
            placeholder="筛选分支，或输入新分支名"
            onChange={(event) => setKeyword(event.target.value)}
          />
          <div className="git-branchbar__list">
            {localRows.map(renderOption)}
            {remoteRows.length > 0 ? <div className="git-branchbar__group">远程分支</div> : null}
            {remoteRows.map(renderOption)}
            {localRows.length === 0 && remoteRows.length === 0 && !canCreate ? (
              <div className="git-branchbar__empty">无匹配分支</div>
            ) : null}
            {canCreate ? (
              <button
                type="button"
                className="git-branchbar__option git-branchbar__create"
                onClick={() => setCreating(true)}
              >
                <span className="git-branchbar__option-row">
                  <Icon name="plus" size={11} />
                  <span className="git-branchbar__option-name">创建新分支「{keyword.trim()}」</span>
                </span>
              </button>
            ) : null}
          </div>
        </div>
      </Popover>

      <button
        type="button"
        className="git-branchbar__menu-btn"
        disabled={busy}
        title="获取 / 拉取 / 推送 / 同步"
        onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}
      >
        <Icon name="chevron-up" size={11} />
      </button>

      {feedback ? <span className="git-branchbar__feedback">{feedback}</span> : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}

      {creating ? (
        <PromptDialog
          title="新建分支"
          label="分支名"
          initialValue={keyword.trim()}
          confirmLabel="创建并切换"
          onConfirm={async (name) => {
            const res = await createBranch(name)
            if (!res.success) throw new Error(res.error ?? '创建分支失败')
            setFeedback(`已创建并切换到 ${name}`)
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  )
}
