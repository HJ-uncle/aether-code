import { useEffect, useState, type JSX } from 'react'
import { getEngineSource } from '@renderer/core/engine/source'
import { sessionWorkspaceContext } from '@renderer/core/workspace/fs-client'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'

/** A task's saved folder is a selection hint. Existing conversations display
 * the engine's binding, including scratch and remote directories. */
export function WorkComposerWorkspace({ sessionId, selectedPath, runId, draft, ready, active, remote }: {
  sessionId: string | null
  selectedPath: string | null
  runId?: string
  draft: boolean
  ready: boolean
  active: boolean
  remote: boolean
}): JSX.Element {
  const source = getEngineSource()
  const scope = JSON.stringify([source, sessionId, selectedPath, runId, draft])
  const [resolved, setResolved] = useState<{ scope: string; root?: string; error?: string }>()
  useEffect(() => {
    if (!active || !ready || draft || !sessionId) return
    let current = true
    void sessionWorkspaceContext(sessionId).then(context => {
      if (current && source === getEngineSource()) setResolved({ scope, root: context.root })
    }).catch((cause: unknown) => {
      if (current && source === getEngineSource()) setResolved({ scope, error: cause instanceof Error ? cause.message : '暂时无法确认工作区' })
    })
    return () => { current = false }
  }, [active, ready, draft, sessionId, scope, source])
  const current = resolved?.scope === scope ? resolved : undefined
  const root = draft ? selectedPath : current?.root
  const name = root?.split(/[\\/]/).filter(Boolean).at(-1) || root
  const label = name ? `工作区 · ${name}` : draft ? '默认工作区' : !ready ? '工作区未连接' : current?.error ? '工作区未确认' : '正在确认工作区…'
  const detail = root ?? (draft ? '任务将使用默认工作区。' : current?.error ?? (!ready ? '连接引擎后可确认当前工作区。' : '正在读取当前会话的工作区。'))
  return <Popover key={scope} className="work-composer-workspace" panelClassName="work-composer-workspace__details"
    placement="up" align="start" width={360} label="当前工作区" disabled={!active}
    trigger={({ open }) => <button type="button" className="work-composer-workspace__trigger"
      title={detail} aria-label={`当前工作区：${root ?? label}`} aria-haspopup="dialog" aria-expanded={open}>
      <Icon name="folder-outline" size={13} aria-hidden="true" />
      <span>{label}</span>
    </button>}>
    <strong>{draft ? '已选工作区' : remote ? '当前远端工作区' : '当前工作区'}</strong>
    <p>{detail}</p>
  </Popover>
}
