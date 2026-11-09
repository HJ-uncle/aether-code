import { memo, useMemo, type JSX } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { ToolActivity } from '@renderer/core/engine/useChat'
import { getEngineSource } from '@renderer/core/engine/source'
import type { ChatFileContext } from '../chat/chat-link'
import { CompactToolRow } from '../chat/CompactToolRow'
import { CommandJobCard } from '../chat/CommandJobCard'
import { WorkSubagentCard } from './WorkSubagentCard'
import { readActivityFiles, readActivityPreview } from './work-activity-presentation'
import { workActivityState } from './work-inline-activity-state'
import { workToolTarget } from './work-message-timeline'
import { workToolChanges, workToolHasImages, workToolKind } from './work-tool-presentation'
import { WorkFileChangeRow } from './WorkFileChangeRow'
import './work-inline-activity.css'

/** Timeline and inspector use the same cards, including their task-scoped actions. */
export const WorkToolActivity = memo(function WorkToolActivity({ tool, fileContext, onOpenFile, onOpenChange, defaultOpen, turnRunning, active = true, readOnly = false }: {
  tool: ToolActivity
  fileContext: ChatFileContext
  onOpenFile?: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  defaultOpen?: boolean
  turnRunning?: boolean
  active?: boolean
  readOnly?: boolean
}): JSX.Element {
  const kind = workToolKind(tool)
  const outputOnly = tool.metadata?.archiveOutputOnly === true
  const imagePreview = kind === 'visual' || kind === 'file-change' && workToolHasImages(tool)
  // A completed turn starts closed even if its live preview was manually
  // opened. Separate memory also handles completion while this row is unmounted.
  const previewScope = imagePreview && turnRunning !== undefined ? `:preview:${turnRunning ? 'running' : 'settled'}` : ''
  const state = workActivityState(tool)
  const changes = useMemo(() => workToolChanges(tool, fileContext.sessionId, fileContext.receiptParentSessionId),
    [tool.change, tool.changes, fileContext.sessionId, fileContext.receiptParentSessionId])
  // The version envelope is useful for diagnostics, but the receipt's readable
  // file content is what belongs in the inline preview. The source stays intact.
  const readPreview = useMemo(() => readActivityPreview(tool), [tool])
  const readFiles = useMemo(() => outputOnly ? undefined : readActivityFiles(tool), [tool, outputOnly])
  const displayTool = useMemo(() => readPreview ? { ...tool, result: readPreview.content || '文件内容为空' } : tool, [tool, readPreview])
  const details = <CompactToolRow tool={displayTool} state={state} summary={outputOnly ? '调用记录未载入' : workToolTarget(tool, fileContext.workspaceRoot)}
    summaryDetail={outputOnly ? '调用记录未载入' : workToolTarget(tool, undefined, true)}
    memoryKey={`work-tool:${getEngineSource()}:${fileContext.sessionId}:${tool.id}${previewScope}`} fileContext={fileContext} onOpenFile={onOpenFile}
    structuredResult={tool.name !== 'read_file'} readRange={readPreview?.range} readFiles={readFiles} quiet defaultOpen={defaultOpen ?? (imagePreview && turnRunning === true)} />
  return <div className="work-tool-activity" data-tool-kind={kind} data-work-tool-id={tool.id}>
    {outputOnly ? <>
      {changes.map(change => <WorkFileChangeRow key={change.id} change={change} state={state} onOpenChange={onOpenChange} />)}
      {details}
    </> : kind === 'subagent' ? <WorkSubagentCard tool={tool} fileContext={fileContext} active={active} />
      : kind === 'command' && tool.commandJob && !tool.commandJob.background ? <CommandJobCard job={tool.commandJob} sessionId={fileContext.sessionId} surfaceMode="work" active={active} readOnly={readOnly} />
        : kind === 'command' && tool.commandJob ? <div className="work-tool-activity__service-row" data-service-job-id={tool.commandJob.jobId}>{details}</div>
        : kind === 'file-change' && changes.length ? <div data-tool-id={tool.id}>
          {changes.map(change => <WorkFileChangeRow key={change.id} change={change} state={state} onOpenChange={onOpenChange} />)}
          {readOnly || imagePreview || tool.error || state === 'error' || state === 'interrupted' ? details : null}
        </div>
          : details}
  </div>
})
