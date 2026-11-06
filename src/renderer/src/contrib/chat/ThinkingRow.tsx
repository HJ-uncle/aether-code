import { useCallback, useEffect, useRef, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { MotionPresence } from '@renderer/workbench/MotionPresence'
import { useCollapseMemory } from './useCollapseMemory'

/** 思考行：紫色圆点 + 单行预览，展开看全文（左侧竖线表示从属于该行） */
export function ThinkingRow({
  text,
  autoOpen,
  memoryKey
}: {
  text: string
  autoOpen: boolean
  memoryKey?: string
}): JSX.Element | null {
  // 使用消息/过程/索引组成稳定 key；不能用思考文本本身，否则流式追加前 32 字变化时
  // 会把用户刚刚手动折叠的状态重置掉。
  const [memory, setMemory] = useCollapseMemory(memoryKey)
  const open = memory ?? autoOpen
  const detailRef = useRef<HTMLPreElement | null>(null)
  const followDetailRef = useRef(true)
  const THINKING_RESUME_PX = 40

  const syncDetailFollow = useCallback((): void => {
    const el = detailRef.current
    if (!el) return
    followDetailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= THINKING_RESUME_PX
  }, [])

  // 打开思考区时从底部开始；之后只在用户仍贴底时跟随新增文本。
  useEffect(() => {
    if (!open) return
    followDetailRef.current = true
    const frame = requestAnimationFrame(() => {
      const el = detailRef.current
      if (el && followDetailRef.current) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open || !followDetailRef.current) return
    const frame = requestAnimationFrame(() => {
      const el = detailRef.current
      if (el && followDetailRef.current) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [open, text])
  const preview = text.replace(/\s+/g, ' ').trim()
  // 空/纯空白思考不渲染（回放路径历史里可能残留，避免一列孤立箭头）
  if (!preview) return null
  const truncated = preview.length > 90 ? `${preview.slice(0, 87)}…` : preview

  return (
    <div className="logline-wrap">
      <button
        type="button"
        className="logline"
        aria-expanded={open}
        onClick={() => setMemory(!open)}
      >
        <span className="logline__dot logline__dot--think" />
        <span className="logline__text" title={preview}>
          {truncated}
        </span>
        <Icon name="chevron" size={16} className="logline__chevron" />
      </button>
      <MotionPresence show={open}>
        <div className="logline__detail logline__detail--thinking">
          <pre
            ref={detailRef}
            onScroll={syncDetailFollow}
            onWheel={(event) => event.stopPropagation()}
          >{text}</pre>
        </div>
      </MotionPresence>
    </div>
  )
}

