/**
 * 提交详情弹窗（移植自 wuzu-client components/code/GitCommitDetailDialog.vue）
 *
 * 完整说明 + 作者/时间/哈希 + numstat 增删统计 + 变更文件清单。
 * 数据经 store 的 loadCommitShow(cwd, hash) 拉取（GitCommitInfo），
 * 弹窗壳复用 workbench 的 Dialog 控件（遮罩 / Esc 关闭 / 焦点管理统一收口）。
 *
 * 与源组件的差异：源直接调 window.api.codeGit.showCommitFile + workspace.openDiffOrPreview
 * 打开「父提交 vs 该提交」diff。aether 侧尚无 DiffHost/openDiffOrPreview 宿主，
 * 因此文件点击与工作区打开改为回调 prop（onOpenFileDiff / onOpenWorktree），
 * 由上层面板在 diff 宿主落地后接线；未传回调时文件行不响应点击。
 */
import { useEffect, useState, type JSX } from 'react'
import type { GitCommitFileChange, GitCommitInfo, GitCommitRef } from '@shared/git-types'
import { loadCommitShow, useGitStore } from '@renderer/core/git/git-store'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon } from '@renderer/workbench/icons'

export interface GitCommitDetailDialogProps {
  open: boolean
  hash: string
  /** 目标仓库目录；缺省用 store 当前 cwd */
  cwd?: string
  onClose: () => void
  /** 点击文件行：打开「父提交版本 vs 该提交版本」的 diff（宿主落地后由上层实现） */
  onOpenFileDiff?: (file: GitCommitFileChange, info: GitCommitInfo, cwd: string) => void
  /** 「在工作区中查看文件」（打开提交涉及的第一个文件） */
  onOpenWorktree?: (info: GitCommitInfo, cwd: string) => void
}

function formatFullDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

function dirName(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

/** 变更类型字母着色：class 后缀与 components.css 的 git-panel__commit-code is-* 同口径 */
function codeClass(code: string): string {
  switch (code) {
    case 'A':
    case 'U':
      return 'git-commitdlg__code git-commitdlg__code--added'
    case 'D':
      return 'git-commitdlg__code git-commitdlg__code--deleted'
    case 'R':
      return 'git-commitdlg__code git-commitdlg__code--renamed'
    default:
      return 'git-commitdlg__code git-commitdlg__code--modified'
  }
}

/** refs 装饰徽章 class（与 hover 卡片同款口径） */
function badgeClass(ref: GitCommitRef): string {
  if (ref.type === 'head') return 'git-hovercard__badge git-hovercard__badge--head'
  if (ref.type === 'remote') return 'git-hovercard__badge git-hovercard__badge--remote'
  if (ref.type === 'tag') return 'git-hovercard__badge git-hovercard__badge--tag'
  return 'git-hovercard__badge'
}

function badgeText(ref: GitCommitRef): string {
  if (ref.type === 'head') return `● ${ref.name}`
  if (ref.type === 'tag') return `⚑ ${ref.name}`
  return ref.name
}

export function GitCommitDetailDialog({
  open,
  hash,
  cwd,
  onClose,
  onOpenFileDiff,
  onOpenWorktree
}: GitCommitDetailDialogProps): JSX.Element | null {
  const store = useGitStore()
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState<GitCommitInfo | null>(null)
  const [error, setError] = useState('')
  /** 弹窗从关闭到打开（或换了一个提交）时自增，作为拉取详情的触发信号 */
  const [request, setRequest] = useState({ open: false, hash: '', cwd: '', seq: 0 })
  const nextOpen = open && Boolean(hash)
  const nextCwd = cwd ?? store.cwd
  if (
    nextOpen !== request.open ||
    (nextOpen && (hash !== request.hash || nextCwd !== request.cwd))
  ) {
    // 渲染期派生：等价于 Vue watch(open/hash) 的 reset 语义，避免在 effect 里 setState
    setRequest({ open: nextOpen, hash, cwd: nextCwd, seq: request.seq + 1 })
    setInfo(null)
    setError('')
    setLoading(nextOpen)
  }

  useEffect(() => {
    if (!request.open) return
    let cancelled = false
    void loadCommitShow(request.cwd, request.hash)
      .then((commit) => {
        if (cancelled) return
        if (commit) setInfo(commit)
        else setError('读取提交详情失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [request])

  if (!open) return null
  const detailCwd = request.cwd

  const copyHash = (): void => {
    if (!info) return
    void navigator.clipboard.writeText(info.hash)
  }

  /** 复制完整提交说明（subject + body） */
  const copyMessage = (): void => {
    if (!info) return
    const text = info.body ? `${info.subject}\n${info.body}` : info.subject
    void navigator.clipboard.writeText(text)
  }

  return (
    <Dialog
      title={`提交 ${info?.shortHash ?? ''}`}
      width={640}
      className="git-commitdlg"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={!info || info.fileChanges.length === 0 || !onOpenWorktree}
            onClick={() => info && onOpenWorktree?.(info, detailCwd)}
          >
            在工作区中查看文件
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {loading ? (
        <div className="git-commitdlg__loading">加载中…</div>
      ) : error ? (
        <div className="git-commitdlg__loading">{error}</div>
      ) : info ? (
        <div className="git-commitdlg__content">
          <div className="git-commitdlg__head">
            <div className="git-commitdlg__subject">{info.subject}</div>
            <div className="git-commitdlg__meta">
              <span className="git-commitdlg__meta-item">
                <Icon name="settings" size={16} />
                {info.author}
              </span>
              <span className="git-commitdlg__meta-item">
                <Icon name="restart" size={16} />
                {formatFullDate(info.date)}
              </span>
              <button
                type="button"
                className="git-commitdlg__meta-item git-commitdlg__hash"
                title="复制完整哈希"
                onClick={copyHash}
              >
                <span className="git-commitdlg__mono">{info.shortHash}</span>
                <Icon name="copy" size={16} />
              </button>
              {info.parents.length > 1 ? (
                <span className="git-commitdlg__meta-item">
                  <Icon name="graph" size={16} />
                  合并提交
                </span>
              ) : null}
            </div>
            <div className="git-commitdlg__stats">
              <span className="git-row__add">+{info.additions}</span>
              <span className="git-row__del">-{info.deletions}</span>
              <span className="git-commitdlg__filecount">共 {info.fileChanges.length} 个文件</span>
              {(info.refs ?? []).map((ref, ri) => (
                <span key={ri} className={badgeClass(ref)} title={ref.name}>
                  {badgeText(ref)}
                </span>
              ))}
            </div>
            {info.body ? (
              <div className="git-commitdlg__body-wrap group">
                <div className="git-commitdlg__body">{info.body}</div>
                <button
                  type="button"
                  className="git-commitdlg__body-copy"
                  title="复制提交信息"
                  onClick={copyMessage}
                >
                  <Icon name="copy" size={16} />
                </button>
              </div>
            ) : null}
          </div>

          <div className="git-commitdlg__files">
            <div className="git-commitdlg__files-head">变更文件</div>
            <div className="git-commitdlg__files-list">
              {info.fileChanges.map((f) => (
                <div
                  key={f.path}
                  className={`git-commitdlg__file${onOpenFileDiff ? '' : ' is-disabled'}`}
                  title={onOpenFileDiff ? `点击查看 ${f.path} 的变更内容` : f.path}
                  onClick={() => onOpenFileDiff?.(f, info, detailCwd)}
                >
                  <span className={codeClass(f.code)}>{f.code || 'M'}</span>
                  <span className="git-commitdlg__file-name" title={f.path}>
                    {fileName(f.path)}
                  </span>
                  <span className="git-commitdlg__file-dir">{dirName(f.path)}</span>
                  <Icon name="chevron-right" size={16} className="git-commitdlg__file-arrow" />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}
