import { memo, useMemo, type JSX } from 'react'
import type { EngineFileChange } from '@shared/ipc'
import type { ToolActivity as ToolActivityRecord } from '@renderer/core/engine/useChat'
import { getEngineSource } from '@renderer/core/engine/source'
import type { ChatFileContext } from './shared/chat-link'
import { CompactToolRow } from './shared/CompactToolRow'
import { CommandJobCard } from './shared/CommandJobCard'
import { SubagentCard } from '../collaboration/SubagentCard'
import { readActivityFiles, readActivityPreview } from './activity-presentation'
import { sessionActivityState } from './inline-activity-state'
import { sessionToolTarget } from './message-timeline'
import { sessionToolChanges, sessionToolHasImages, sessionToolKind } from './tool-presentation'
import { FileChangeRow } from '../artifacts/FileChangeRow'
import './inline-activity.css'

/** Timeline and inspector use the same cards, including their task-scoped actions. */
export const ToolActivity = memo(function ToolActivity({ tool, fileContext, onOpenFile, onOpenChange, defaultOpen, revealRevision, turnRunning, active = true, readOnly = false }: {
  tool: ToolActivityRecord
  fileContext: ChatFileContext
  onOpenFile?: (path: string) => void
  onOpenChange?: (change: EngineFileChange) => void
  defaultOpen?: boolean
  revealRevision?: number
  turnRunning?: boolean
  active?: boolean
  readOnly?: boolean
}): JSX.Element {
  const kind = sessionToolKind(tool)
  const outputOnly = tool.metadata?.archiveOutputOnly === true
  const imagePreview = kind === 'visual' || kind === 'file-change' && sessionToolHasImages(tool)
  // A completed turn starts closed even if its live preview was manually
  // opened. Separate memory also handles completion while this row is unmounted.
  const previewScope = imagePreview && turnRunning !== undefined ? `:preview:${turnRunning ? 'running' : 'settled'}` : ''
  const state = sessionActivityState(tool)
  const changes = useMemo(() => sessionToolChanges(tool, fileContext.sessionId, fileContext.receiptParentSessionId),
    [tool.change, tool.changes, fileContext.sessionId, fileContext.receiptParentSessionId])
  // The version envelope is useful for diagnostics, but the receipt's readable
  // file content is what belongs in the inline preview. The source stays intact.
  const readPreview = useMemo(() => readActivityPreview(tool), [tool])
  const readFiles = useMemo(() => outputOnly ? undefined : readActivityFiles(tool), [tool, outputOnly])
  const displayTool = useMemo(() => readPreview ? { ...tool, result: readPreview.content || '文件内容为空' } : tool, [tool, readPreview])
  const details = <CompactToolRow tool={displayTool} state={state} summary={outputOnly ? '调用记录未载入' : sessionToolTarget(tool, fileContext.workspaceRoot)}
    summaryDetail={outputOnly ? '调用记录未载入' : sessionToolTarget(tool, undefined, true)}
    memoryKey={`work-tool:${getEngineSource()}:${fileContext.sessionId}:${tool.id}${previewScope}`} fileContext={fileContext} onOpenFile={onOpenFile}
    structuredResult={tool.name !== 'read_file'} readRange={readPreview?.range} readFiles={readFiles} quiet defaultOpen={defaultOpen ?? false} revealRevision={revealRevision} />
  return <div className="work-tool-activity" data-tool-kind={kind} data-work-tool-id={tool.id}>
    {outputOnly ? <>
      {changes.map(change => <FileChangeRow key={change.id} change={change} state={state} onOpenChange={onOpenChange} />)}
      {details}
    </> : kind === 'subagent' ? <SubagentCard tool={tool} fileContext={fileContext} active={active} />
      : kind === 'command' && tool.commandJob && !tool.commandJob.background ? <CommandJobCard job={tool.commandJob} sessionId={fileContext.sessionId} active={active} readOnly={readOnly} />
        : kind === 'command' && tool.commandJob ? <div className="work-tool-activity__service-row" data-service-job-id={tool.commandJob.jobId}>{details}</div>
        : kind === 'file-change' && changes.length ? <div data-tool-id={tool.id}>
          {changes.map(change => <FileChangeRow key={change.id} change={change} state={state} onOpenChange={onOpenChange} />)}
          {readOnly || imagePreview || tool.error || state === 'error' || state === 'interrupted' ? details : null}
        </div>
          : details}
  </div>
})
