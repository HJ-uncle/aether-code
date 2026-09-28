/**
 * 存储（stash）行 hover 卡片（移植自 wuzu-client components/code/GitStashHoverCard.vue，
 * 与提交 hover 卡片同款布局）：
 * 展示完整说明（去「On <branch>:」前缀后的展示文本）、分支 / 相对时间、可复制的哈希。
 * 定位与提交 hover 卡片一致：默认从行右侧滑出、垂直居中对齐行，右侧放不下翻到左侧。
 * 鼠标在「行 → 卡片」间移动不消失，滚动时关闭（由父组件控制）。
 */
import { useLayoutEffect, useMemo, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { GitStashEntry } from '@shared/git-types'
import { Icon } from '@renderer/workbench/icons'

export interface GitStashHoverCardProps {
  stash: GitStashEntry | null
  visible: boolean
  anchor: DOMRect | null
  onKeep?: () => void
  onLeave?: () => void
}

const STASH_DEFAULT_RE = /^On ([^:]+):\s*/

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

export function GitStashHoverCard({
  stash,
  visible,
  anchor,
  onKeep,
  onLeave
}: GitStashHoverCardProps): JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null)

  /** 展示用消息：去掉「On <branch>:」前缀 */
  const message = useMemo(() => {
    const raw = stash?.message ?? ''
    const m = STASH_DEFAULT_RE.exec(raw)
    const rest = m ? raw.slice(m[0].length).trim() : raw.trim()
    return rest || ''
  }, [stash?.message])

  /** 分支标签；用户自定义消息（没有 On 前缀）返回空串不显示 */
  const branch = useMemo(() => {
    const m = STASH_DEFAULT_RE.exec(stash?.message ?? '')
    return m?.[1] ?? ''
  }, [stash?.message])

  const shortHash = (stash?.hash ?? '').slice(0, 7)

  /**
   * 定位：优先在行右侧滑出、垂直居中对齐行；右侧放不下翻到左侧；上下贴边钳制。
   * 与 GitCommitHoverCard 同策略：绘制前直接写 DOM style，不经 setState。
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
  }, [visible, anchor, anchor?.left, anchor?.top, anchor?.bottom, stash?.index])

  if (!visible || !stash) return null

  const copyHash = (): void => {
    if (!stash.hash) return
    void navigator.clipboard.writeText(stash.hash)
  }

  /** 复制完整存储说明（去前缀后的展示文本；自定义消息原样） */
  const copyMessage = (): void => {
    const text = message || stash.message
    if (!text) return
    void navigator.clipboard.writeText(text)
  }

  return createPortal(
    <div ref={cardRef} className="git-stashcard" onMouseEnter={onKeep} onMouseLeave={onLeave}>
      <div className="git-stashcard__body">
        <div className="git-stashcard__title">
          <div className="git-stashcard__message">
            {`stash@{${stash.index}}`}
            {message ? `\n${message}` : ''}
          </div>
          {message ? (
            <button
              type="button"
              className="git-stashcard__copy"
              title="复制存储说明"
              onClick={(e) => {
                e.stopPropagation()
                copyMessage()
              }}
            >
              <Icon name="copy" size={13} />
            </button>
          ) : null}
        </div>
        <div className="git-stashcard__meta">
          {branch ? (
            <span className="git-stashcard__meta-item">
              <Icon name="git" size={13} />
              {branch}
            </span>
          ) : null}
          {stash.date ? (
            <span className="git-stashcard__meta-item" title={fullDate(stash.date)}>
              <Icon name="restart" size={13} />
              {relativeTime(stash.date)}
            </span>
          ) : null}
          <button
            type="button"
            className="git-stashcard__meta-item git-stashcard__hash"
            title="点击复制哈希"
            onClick={(e) => {
              e.stopPropagation()
              copyHash()
            }}
          >
            {shortHash}
            <Icon name="copy" size={12} />
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
