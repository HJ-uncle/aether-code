import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@renderer/ui/icons'
import { MotionPresence } from '@renderer/ui/MotionPresence'
import { useCollapseMemory } from './shared/useCollapseMemory'
import { ProcessPanel } from './ProcessPanel'
import type { ProcessSection as Section } from './process-sections'

export function ProcessSection({ section, memoryKey, running, showThinking, revealTool, children }: {
  section: Section; memoryKey: string; running: boolean; showThinking: boolean
  revealTool?: { toolId: string; revision: number } | null; children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  const [manual, setOpen] = useCollapseMemory(`work-process-section:${memoryKey}`)
  const collapsible = section.toolCount > 3
  const open = manual ?? !collapsible
  const visible = section.toolCount > 0 || showThinking && section.thinkingCount > 0
  const consumedReveal = useRef<number | undefined>(undefined)
  const pendingJump = useRef<'first' | 'latest' | null>(null)
  const [jumpVersion, setJumpVersion] = useState(0)
  useLayoutEffect(() => {
    if (!revealTool || consumedReveal.current === revealTool.revision) return
    const ownsTarget = section.segments.some(item => item.kind === 'tool' ? item.tool.id === revealTool.toolId
      : item.kind === 'tools' || item.kind === 'collaboration' ? item.tools.some(tool => tool.id === revealTool.toolId) : false)
    if (!ownsTarget) return
    consumedReveal.current = revealTool.revision
    setOpen(true)
  }, [revealTool, section.segments, setOpen])
  useLayoutEffect(() => {
    const element = root.current
    const outer = element?.closest<HTMLElement>('.work-message__process-viewport')
    if (!element || !outer) return
    const jump = (direction: 'first' | 'latest'): void => {
      const sections = Array.from(outer.querySelectorAll<HTMLElement>('[data-process-section]'))
        .filter(candidate => candidate.closest('[data-process-scroll]') === outer)
      // Revealing reasoning must not hide the first/last tool stage behind a
      // reasoning-only prelude or epilogue when navigating execution steps.
      const toolSections = sections.filter(candidate => Number(candidate.dataset.toolCount) > 0)
      const targets = toolSections.length ? toolSections : sections
      if ((direction === 'first' ? targets[0] : targets.at(-1)) !== element) return
      pendingJump.current = direction
      setOpen(true)
      setJumpVersion(value => value + 1)
    }
    const first = (): void => jump('first')
    const latest = (): void => jump('latest')
    outer.addEventListener('work-process-first', first)
    outer.addEventListener('work-process-latest', latest)
    return () => {
      outer.removeEventListener('work-process-first', first)
      outer.removeEventListener('work-process-latest', latest)
    }
  }, [visible, setOpen])
  useLayoutEffect(() => {
    if (!open || !pendingJump.current) return
    root.current?.querySelector('[data-process-scroll]')?.dispatchEvent(new Event(`work-process-${pendingJump.current}`))
    pendingJump.current = null
  }, [open, jumpVersion])
  if (!visible) return null
  return <div ref={root} className="work-process-section" data-process-section={section.key}
    data-tool-count={section.toolCount} data-thinking-count={section.thinkingCount}>
    {collapsible ? <button type="button" className="work-process-section__toggle" aria-expanded={open} aria-controls={id}
      aria-label={`${open ? '收起' : '展开'}阶段过程，${section.toolCount} 次工具调用`}
      onClick={() => setOpen(!open)}>
      <span className="work-process-section__dot" aria-hidden="true" />
      <span>过程</span>
      <span className="work-process-section__count">工具调用 {section.toolCount}</span>
      {showThinking && section.thinkingCount ? <span className="work-process-section__count">思考 {section.thinkingCount} 段</span> : null}
      <Icon name="chevron-right" size={12} className="work-process-section__chevron" />
    </button> : null}
    {collapsible ? <MotionPresence show={open} className="work-process-section__disclosure" id={id}>
      <ProcessPanel nested memoryKey={`section:${memoryKey}`} running={running}>{children}</ProcessPanel>
    </MotionPresence> : <div className="work-process-section__content">{children}</div>}
  </div>
}
