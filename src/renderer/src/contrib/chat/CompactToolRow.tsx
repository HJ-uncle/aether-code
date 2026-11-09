import { memo, useId, type JSX, type ReactNode } from 'react'
import { useApp } from '@renderer/core/app-context'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { toolFailureMessage } from '@renderer/core/engine/tool-feedback'
import { toast } from '@renderer/core/toast'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { MotionPresence } from '@renderer/workbench/MotionPresence'
import type { ChatFileContext } from './chat-link'
import { openFileFromChat } from './open-file'
import { toolDisplayName, toolParamSummary, toolPathArg } from './tool-names'
import { toolPresentation } from './tool-presentation'
import { ToolResult } from './ToolResult'
import { useCollapseMemory } from './useCollapseMemory'
import { WorkToolOutcome } from '../work/WorkToolOutcome'
import { WorkErrorNotice } from '../work/WorkErrorNotice'
import { workToolFeedback } from '../work/work-tool-feedback'
import type { ReadActivityFileSummary, ReadActivityLineRange } from '../work/work-activity-presentation'
import { quietToolIcon } from './quiet-tool-icon'

/** Code and Work share the same one-line receipt and result-only disclosure. */
export const CompactToolRow = memo(function CompactToolRow({
  tool, memoryKey, summary: summaryOverride, state = tool.state,
  fileContext, onOpenFile, defaultOpen, structuredResult = false, quiet = false, detailFooter, readRange, readFiles
}: {
  tool: ToolActivity
  memoryKey?: string
  summary?: string
  state?: ToolActivity['state']
  fileContext?: ChatFileContext
  onOpenFile?: (path: string) => void
  defaultOpen?: boolean
  structuredResult?: boolean
  /** Work keeps routine receipts quiet while retaining the full Code presentation. */
  quiet?: boolean
  detailFooter?: ReactNode
  readRange?: ReadActivityLineRange
  readFiles?: ReadActivityFileSummary[]
}): JSX.Element {
  const { engine } = useApp()
  const [memory, setMemory] = useCollapseMemory(memoryKey ?? `tool:${tool.id}`)
  const detailId = useId()
  const result = toolPresentation(tool)
  const open = memory ?? defaultOpen ?? result.images.length > 0
  const label = toolDisplayName(tool.name)
  const visibleFiles = quiet && readFiles?.length ? readFiles : undefined
  const fileStateLabel = (file: ReadActivityFileSummary): string => file.state === 'error' ? '失败' : file.state === 'cancelled' ? '已取消' : file.state === 'pending' ? '未读取' : ''
  const summary = visibleFiles ? visibleFiles.map(file => [file.label, file.range, fileStateLabel(file)].filter(Boolean).join(' ')).join(' · ')
    : summaryOverride ?? toolParamSummary(tool.args)
  const failure = toolFailureMessage(tool)
  const feedback = quiet ? workToolFeedback(tool, state) : null
  // Only omit an exact, fully visible one-line duplicate. Multiline errors
  // and long logs must remain readable here without copying them elsewhere.
  const duplicateWorkFailure = Boolean(quiet && failure && feedback?.detail === failure.trim()
    && !/[\r\n]/.test(failure) && result.text.trim() === failure.trim() && !result.images.length && !result.browserSnapshots?.length)
  const hasDetail = Boolean(result.text || result.images.length || result.browserSnapshots?.length || failure || feedback || detailFooter)
  const pathArg = toolPathArg(tool.args)
  // Routine Work targets describe an operation; only explicit change receipts
  // navigate to its artifacts. Code retains its editor and remote policy.
  const openablePath = !quiet && pathArg && (fileContext ? onOpenFile && tool.name === 'read_file' : engine.snapshot.mode !== 'remote' && summary === pathArg) ? pathArg : null
  const statusLabel = feedback?.label ?? toolStatusLabel(quiet && state !== tool.state ? { ...tool, state } : tool)
  const visibleReadRange = quiet && state === 'done' && !visibleFiles ? readRange : undefined
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
    <div className={`logline-wrap compact-tool-row${quiet ? ' compact-tool-row--quiet' : ''}${visibleFiles ? ' compact-tool-row--files' : ''}`} data-tool-id={tool.id} data-tool-state={state}>
      <button
        type="button"
        className={`logline${hasDetail ? '' : ' logline--static'}`}
        aria-label={`${hasDetail ? `${open ? '收起' : '展开'} ${label}${summary ? ` · ${summary}` : ''}${quiet && state !== 'done' ? ` · ${statusLabel}` : ''}` : `${label} · ${toolStatusLabel(tool)}`}${visibleReadRange ? ` · ${visibleReadRange.label}` : ''}`}
        aria-expanded={open}
        aria-controls={hasDetail ? detailId : undefined}
        disabled={!hasDetail}
        onClick={() => setMemory(!open)}
      >
        {quiet ? <span className={`logline__icon logline__icon--${state}`} aria-hidden="true">
          {state === 'running' ? <Spinner size={13} /> : <Icon size={13} name={state === 'waiting' ? 'clock-outline' : state === 'cancelled' ? 'stop' : state === 'unknown' ? 'info' : quietToolIcon(tool.name)} />}
        </span> : <span className={`logline__dot logline__dot--${dot}`} title={toolStatusLabel(tool)} aria-hidden="true" />}
        <span className={`logline__name${!quiet && state === 'error' ? ' logline__name--error' : ''}`}>{label}</span>
        {!quiet ? <span className="pending-card__hint">{toolStatusLabel(tool)}{tool.durationMs !== undefined ? ` · ${tool.durationMs} ms` : ''}</span> : null}
        {visibleFiles ? <span className="logline__files">
          {visibleFiles.map((file, index) => <span className="logline__file" key={`${index}:${file.path}`} title={file.title}>
            <span className="logline__file-name">{file.label}</span>
            {file.range ? <span className="logline__file-range">{file.range}</span> : null}
            {file.state ? <span className="logline__file-state">{fileStateLabel(file)}</span> : null}
          </span>)}
        </span> : summary ? (
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
        {quiet && state !== 'done' ? <span className="logline__status">{statusLabel}</span> : null}
        {visibleReadRange ? <span className="logline__read-range" title={visibleReadRange.title}>{visibleReadRange.label}</span> : null}
        {hasDetail ? <Icon name={quiet ? 'chevron-right' : 'chevron'} size={quiet ? 12 : 16} className="logline__chevron" /> : null}
      </button>
      <MotionPresence show={open && hasDetail}>
        <div id={detailId} className="logline__detail">
          {quiet ? <WorkToolOutcome tool={tool} state={state} /> : failure ? fileContext
            ? <WorkErrorNotice error={failure} /> : <div className="message__error" role="alert">{failure}</div> : null}
          {!duplicateWorkFailure && (result.text || result.images.length || result.browserSnapshots?.length) ? <ToolResult parsed={result} toolName={tool.name} structured={structuredResult} surfaceMode={quiet ? 'work' : 'code'} /> : null}
          {detailFooter}
        </div>
      </MotionPresence>
    </div>
  )
})
