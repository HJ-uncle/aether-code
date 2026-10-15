import { memo, useId, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { toolFailureMessage } from '@renderer/core/engine/tool-feedback'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'
import type { ChatFileContext } from './chat-link'
import { openFileFromChat } from './open-file'
import { toolDisplayName, toolParamSummary, toolPathArg } from './tool-names'
import { toolPresentation } from './tool-presentation'
import { ToolResult } from './ToolResult'
import { useCollapseMemory } from './useCollapseMemory'
import { WorkErrorNotice } from '../work/WorkErrorNotice'

/** Code and Work share the same one-line receipt and result-only disclosure. */
export const CompactToolRow = memo(function CompactToolRow({
  tool, memoryKey, summary: summaryOverride, state = tool.state,
  fileContext, onOpenFile, defaultOpen
}: {
  tool: ToolActivity
  memoryKey?: string
  summary?: string
  state?: ToolActivity['state']
  fileContext?: ChatFileContext
  onOpenFile?: (path: string) => void
  defaultOpen?: boolean
}): JSX.Element {
  const { engine } = useApp()
  const [memory, setMemory] = useCollapseMemory(memoryKey ?? `tool:${tool.id}`)
  const detailId = useId()
  const result = toolPresentation(tool)
  const open = memory ?? defaultOpen ?? result.images.length > 0
  const label = toolDisplayName(tool.name)
  const summary = summaryOverride ?? toolParamSummary(tool.args)
  const failure = toolFailureMessage(tool)
  // Some durable subagent projections are stored both as `error` and as the
  // tool result.  WorkErrorNotice already keeps that diagnostic behind a
  // disclosure; rendering the same raw payload below would recreate the
  // giant red block this surface is meant to avoid.
  const duplicateWorkFailure = Boolean(fileContext && failure && result.text.trim() === failure.trim())
  const hasDetail = Boolean(result.text || result.images.length || result.browserSnapshots?.length || failure)
  const pathArg = toolPathArg(tool.args)
  // Work opens files in its own task; Code retains its editor and remote policy.
  const openablePath = pathArg && (fileContext ? onOpenFile && tool.name === 'read_file' : engine.snapshot.mode !== 'remote' && summary === pathArg) ? pathArg : null
  const dot = state === 'running' ? 'running' : state === 'done' ? 'done'
    : state === 'error' || state === 'interrupted' ? 'error' : state === 'waiting' ? 'waiting' : 'neutral'
  const openPath = async (): Promise<void> => {
    if (!openablePath) return
    try {
      if (onOpenFile) onOpenFile(openablePath)
      else await openFileFromChat(openablePath, fileContext)
    } catch (error) {
      toast.error(`打开文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="logline-wrap compact-tool-row" data-tool-id={tool.id} data-tool-state={state}>
      <button
        type="button"
        className={`logline${hasDetail ? '' : ' logline--static'}`}
        aria-label={hasDetail ? `${open ? '收起' : '展开'} ${label}${summary ? ` · ${summary}` : ''}` : `${label} · ${toolStatusLabel(tool)}`}
        aria-expanded={open}
        aria-controls={hasDetail ? detailId : undefined}
        disabled={!hasDetail}
        onClick={() => setMemory(!open)}
      >
        <span className={`logline__dot logline__dot--${dot}`} title={toolStatusLabel(tool)} aria-hidden="true" />
        <span className={`logline__name${state === 'error' ? ' logline__name--error' : ''}`}>{label}</span>
        <span className="pending-card__hint">{toolStatusLabel(tool)}{tool.durationMs !== undefined ? ` · ${tool.durationMs} ms` : ''}</span>
        {summary ? (
          openablePath ? (
            <span
              role="button"
              tabIndex={-1}
              className="logline__summary logline__summary--link"
              title={`${onOpenFile ? '在成果中打开' : '在编辑器中打开'} ${openablePath}`}
              onClick={event => { event.stopPropagation(); void openPath() }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.stopPropagation(); void openPath() }
              }}
            >{summary}</span>
          ) : <span className="logline__summary" title={summary}>{summary}</span>
        ) : null}
        {hasDetail ? <Icon name="chevron" size={16} className="logline__chevron" /> : null}
      </button>
      {open && hasDetail ? (
        <div id={detailId} className="logline__detail">
          {failure ? (
            fileContext ? <WorkErrorNotice error={failure} /> : <div className="message__error" role="alert">{failure}</div>
          ) : null}
          {!duplicateWorkFailure && (result.text || result.images.length || result.browserSnapshots?.length) ? <ToolResult parsed={result} toolName={tool.name} /> : null}
        </div>
      ) : null}
    </div>
  )
})
