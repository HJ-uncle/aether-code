/**
 * 同步按钮（sync / publish 主按钮 + 拉取/推送/获取下拉）
 *
 * 移植自 wuzu-client components/code/GitSyncButton.vue：
 * - 有上游时主按钮为「同步」（先拉取再推送），无上游时为「发布」；
 * - 上游存在且 ahead/behind 非零时显示 behind↓ ahead↑ 数字徽标；
 * - 分叉时经 runGitRemoteAction 的 choosePullStrategy 回调弹
 *   「合并(merge)/变基(rebase)/取消」Dialog，选 null 即放弃；
 * - SSH 私钥口令经 PromptDialog 询问后重试；
 * - 下拉菜单与源一一对应：同步 / 拉取 / 拉取（变基）/ 推送|发布 / 获取所有远程更新。
 *   源的「更多 Git 操作…」依赖 workspaceStore.openSideView，aether 无此宿主，未移植。
 *
 * 与源的差异：toast/错误弹窗用行内 feedback 文本代替（aether 暂无 toast 服务）。
 */
import { useState, type JSX } from 'react'
import {
  useGitStore,
  busyOperationOf,
  forceRefreshGit,
  gitRemoteStore,
  mergeStrategyStore
} from '../../core/git/git-store'
import { runGitRemoteAction, type GitRemoteAction } from '../../core/git/git-remote-actions'
import { chooseMergeStrategy, type ChooseStrategy } from '../../core/git/git-merge-strategy'
import { ContextMenu, type ContextMenuItem } from '../../workbench/ContextMenu'
import { PromptDialog } from '../../workbench/PromptDialog'
import { pickDivergedStrategy } from './DivergedStrategyDialog'
import { Icon } from '../../workbench/icons'

/** 远程操作的中文名（进度文案与失败提示共用） */
const labels: Record<GitRemoteAction, string> = {
  sync: '同步',
  pull: '拉取',
  pullRebase: '拉取（变基）',
  push: '推送',
  fetch: '获取',
  publish: '发布分支'
}

export function GitSyncButton(): JSX.Element {
  const s = useGitStore()
  const [pending, setPending] = useState<GitRemoteAction | ''>('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [feedback, setFeedback] = useState('')
  const [sshAsk, setSshAsk] = useState<{ resolve: (v: string | null) => void } | null>(null)

  const busy = pending !== '' || busyOperationOf(s) !== ''
  const disabled = busy || !s.isRepo || !s.branch || s.loading

  const primaryTitle = pending
    ? `正在${labels[pending]}…`
    : busyOperationOf(s)
      ? '正在执行 Git 操作…'
      : !s.upstream
        ? '发布当前分支到 origin 并设置上游'
        : `同步更改：${s.behind} 个待拉取，${s.ahead} 个待推送（${s.upstream}）`

  const requestSshPassphrase = (): Promise<string | null> =>
    new Promise((resolve) => setSshAsk({ resolve }))

  const chooseStrategy: ChooseStrategy = (info) => pickDivergedStrategy(info.detail)

  const handleAction = async (action: GitRemoteAction): Promise<void> => {
    if (disabled) return
    setPending(action)
    const cwd = s.cwd
    try {
      const result = await runGitRemoteAction(gitRemoteStore, action, {
        requestSshPassphrase,
        choosePullStrategy: () => chooseMergeStrategy(mergeStrategyStore, chooseStrategy)
      })
      // 拉取失败也可能已产生冲突文件，刷新状态以展示真实结果
      if (
        gitRemoteStore.cwd === cwd &&
        (action === 'sync' || action === 'pull' || action === 'pullRebase')
      ) {
        await forceRefreshGit()
      }
      if (!result) return
      setFeedback(
        result.success ? `${labels[action]}完成` : (result.error ?? `${labels[action]}失败`)
      )
    } finally {
      setPending('')
    }
  }

  const menuItems: ContextMenuItem[] = [
    {
      id: 'sync',
      label: '同步更改（先拉取再推送）',
      disabled: disabled || !s.upstream,
      onSelect: () => void handleAction('sync')
    },
    {
      id: 'pull',
      label: '拉取',
      disabled: disabled || !s.upstream,
      onSelect: () => void handleAction('pull')
    },
    {
      id: 'pullRebase',
      label: '拉取（变基）',
      disabled: disabled || !s.upstream,
      onSelect: () => void handleAction('pullRebase')
    },
    {
      id: 'push',
      label: s.upstream ? '推送' : '发布分支到 origin',
      disabled,
      onSelect: () => void handleAction(s.upstream ? 'push' : 'publish')
    },
    { id: 'fetch', label: '获取所有远程更新', disabled, onSelect: () => void handleAction('fetch') }
  ]

  return (
    <div className="git-sync">
      <button
        type="button"
        className="git-sync__primary"
        disabled={disabled}
        title={primaryTitle}
        aria-label={primaryTitle}
        aria-busy={busy}
        onClick={() => void handleAction(s.upstream ? 'sync' : 'publish')}
      >
        <Icon
          name={s.upstream ? 'sync' : 'cloud-upload-outline'}
          size={13}
          className={busy ? 'is-spinning' : undefined}
        />
        {!s.upstream && !busy ? (
          <span className="git-sync__label">发布</span>
        ) : s.upstream && (s.behind || s.ahead) ? (
          <span className="git-sync__badge">
            <span>{s.behind}↓</span>
            <span>{s.ahead}↑</span>
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="git-sync__more"
        disabled={disabled}
        title="更多同步操作"
        aria-label="更多同步操作"
        onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}
      >
        <Icon name="chevron-up" size={11} />
      </button>

      {feedback ? <span className="git-sync__feedback">{feedback}</span> : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}

      {sshAsk ? (
        <PromptDialog
          title="加载 SSH 私钥"
          label="请输入 SSH 私钥口令，加载后重试本次操作。"
          confirmLabel="加载并重试"
          validate={(v) => (v ? null : '请输入口令')}
          onConfirm={(v) => sshAsk.resolve(v)}
          onClose={() => {
            sshAsk.resolve(null)
            setSshAsk(null)
          }}
        />
      ) : null}

    </div>
  )
}
