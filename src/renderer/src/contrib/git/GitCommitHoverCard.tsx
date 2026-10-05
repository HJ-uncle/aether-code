/**
 * 提交 hover 卡片（移植自 wuzu-client components/code/GitCommitHoverCard.vue）
 *
 * 鼠标悬停提交行时展示完整提交说明（subject + body）、作者/相对时间、
 * 可复制的哈希与全部分支/标签装饰（ref 排序对齐 VSCode：当前分支 > 远程 > 标签）。
 * 定位：默认从行右侧滑出、垂直居中对齐行（鼠标沿行上下移动不经过卡片），
 * 右侧放不下翻到左侧；上下贴边钳制。首帧先移出屏幕量完尺寸再定位，避免闪现在左上角。
 * 鼠标在「行 → 卡片」间移动不消失（onKeep/onLeave 由父组件控制显隐）。
 */
import { useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { GitCommitRef } from '@shared/git-types'
import { compareRefs } from '@renderer/core/git/git-history-graph'
import { Icon } from '@renderer/workbench/icons'

/** 卡片只用到提交这几个字段：提交历史（GitLogEntry）与文件时间线条目都能直接喂进来 */
export interface CommitHoverData {
  hash: string
  shortHash: string
  subject: string
  body?: string
  author: string
  date: string
  refs?: GitCommitRef[]
}

export interface GitCommitHoverCardProps {
  commit: CommitHoverData | null
  visible: boolean
  anchor: DOMRect | null
  /** 元信息行末尾的语境标注（时间线用它显示本条对该文件的变更类型） */
  hint?: string
  /** 改动行数（行内 blame 用；取自 commitShow 的 numstat 统计） */
  stats?: { additions: number; deletions: number } | null
  onKeep?: () => void
  onLeave?: () => void
}

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
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fullDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** refs 装饰徽章 class（颜色用 class 表达，hex 归 CSS 管） */
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

export function GitCommitHoverCard({
  commit,
  visible,
  anchor,
  hint,
  stats,
  onKeep,
  onLeave
}: GitCommitHoverCardProps): JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null)

  const allRefs = useMemo(() => (commit?.refs ?? []).slice().sort(compareRefs), [commit])

  /**
   * 定位：优先在行右侧滑出、垂直居中对齐行；右侧放不下翻到左侧；上下贴边钳制。
   * 刻意不经过 React state —— 定位是「跟随外部锚点」的 DOM 同步，用
   * useLayoutEffect 在绘制前直接写 style，既避免首帧闪现在左上角，也避免
   * setState → 重渲染 → 再定位 的级联渲染（react-hooks/set-state-in-effect）。
   * 依赖里放 anchor 的位置字段：换行/内容变化导致锚点矩形变化时会自动重新定位。
   */
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    if (!visible || !anchor) return
    const margin = 8
    const gap = 6
    const rect = el.getBoundingClientRect()
    const w = rect.width || 420
    const h = rect.height || 120
    const rowH = anchor.bottom - anchor.top
    let y = anchor.top + (rowH - h) / 2
    y = Math.min(Math.max(margin, y), window.innerHeight - h - margin)
    let x = anchor.right + gap
    if (x + w > window.innerWidth - margin) {
      x = anchor.left - gap - w
    }
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [visible, anchor, anchor?.left, anchor?.top, anchor?.bottom, commit?.hash, commit?.body])

  if (!visible || !commit) return null

  const copyHash = (): void => {
    void navigator.clipboard.writeText(commit.hash)
  }

  /** 复制完整提交说明（subject + body） */
  const copyMessage = (): void => {
    const text = commit.body ? `${commit.subject}\n${commit.body}` : commit.subject
    void navigator.clipboard.writeText(text)
  }

  return createPortal(
    <div ref={cardRef} className="git-hovercard" onMouseEnter={onKeep} onMouseLeave={onLeave}>
      <div className="git-hovercard__body">
        <div className="git-hovercard__title group">
          <div className="git-hovercard__message">
            {commit.subject}
            {commit.body ? `\n${commit.body}` : ''}
          </div>
          <button
            type="button"
            className="git-hovercard__copy"
            title="复制提交信息"
            onClick={(e) => {
              e.stopPropagation()
              copyMessage()
            }}
          >
            <Icon name="copy" size={16} />
          </button>
        </div>
        <div className="git-hovercard__meta">
          <span className="git-hovercard__meta-item">
            <Icon name="account-outline" size={16} />
            {commit.author}
          </span>
          <span className="git-hovercard__meta-item" title={fullDate(commit.date)}>
            <Icon name="restart" size={16} />
            {relativeTime(commit.date)}
          </span>
          <button
            type="button"
            className="git-hovercard__meta-item git-hovercard__hash"
            title="点击复制完整哈希"
            onClick={(e) => {
              e.stopPropagation()
              copyHash()
            }}
          >
            {commit.shortHash}
            <Icon name="copy" size={16} />
          </button>
          {stats ? (
            <span className="git-hovercard__meta-item git-hovercard__stats">
              <span className="git-row__add">+{stats.additions}</span>
              <span className="git-row__del">-{stats.deletions}</span>
            </span>
          ) : null}
          {hint ? <span className="git-hovercard__hint">{hint}</span> : null}
        </div>
        {allRefs.length > 0 ? (
          <div className="git-hovercard__refs">
            {allRefs.map((ref, ri) => (
              <span key={ri} className={badgeClass(ref)} title={ref.name}>
                {badgeText(ref)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
