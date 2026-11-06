import { memo, useMemo, useState, type JSX } from 'react'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'
import { useMotionPresence } from '@renderer/workbench/MotionPresence'
import { workToolTechnicalFields } from './work-tool-presentation'
import './work-tool-details.css'

/** Mount long raw receipts only on request; readable tool cards never replace them. */
export const WorkToolTechnicalDetails = memo(function WorkToolTechnicalDetails({ tool, iconOnly = false }: { tool: ToolActivity; iconOnly?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const presence = useMotionPresence(open)
  const fields = useMemo(() => workToolTechnicalFields(tool), [tool.args, tool.result, tool.error])
  const copy = async (label: string, raw: string): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持复制，请展开后手动复制。')
      await navigator.clipboard.writeText(raw)
      toast.success(`已复制${label}`)
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '复制失败，请重试') }
  }
  return <details className={`work-tool-technical${iconOnly ? ' work-tool-technical--icon' : ''}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary title="工具技术详情" aria-label="工具技术详情"><Icon name={iconOnly ? 'info' : 'chevron-right'} size={iconOnly ? 13 : 11} />{!iconOnly ? <span>技术详情</span> : null}</summary>
    {presence.present ? <div className="work-tool-technical__body" {...presence.motionProps}>
      <div className="work-tool-technical__identity"><code>{tool.name}</code><span title={tool.id}>调用 {tool.id}</span></div>
      {fields.map(field => <section key={field.key} className="work-tool-technical__field" aria-label={field.label}>
        <header><span>{field.label}</span><button type="button" aria-label={`复制${field.label}`} onClick={() => void copy(field.label, field.raw)}>
          <Icon name="copy" size={12} />复制
        </button></header>
        {field.raw ? <pre tabIndex={0}>{field.raw}</pre> : <p className="work-tool-technical__empty">（空）</p>}
      </section>)}
    </div> : null}
  </details>
})
