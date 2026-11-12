import { useMemo, useState, useSyncExternalStore, type JSX } from 'react'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { Icon } from '@renderer/workbench/icons'
import { Select } from '@renderer/workbench/Select'
import { FileGlyph } from '../explorer/FileGlyph'
import { WorkSessionArtifacts, type WorkSessionArtifactsProps } from './WorkSessionArtifacts'
import { WorkFinalResult } from './WorkFinalResult'
import { workFinalResultCatalog, type WorkFinalResultSelection } from './work-final-results'
import { finalResultPreviewFormat } from './final-result-preview-format'
import './work-final-result.css'

export type { WorkFinalResultSelection } from './work-final-results'
export interface WorkArtifactsWorkspaceProps extends WorkSessionArtifactsProps {
  finalSelection?: WorkFinalResultSelection | null
}

export function WorkArtifactsWorkspace(props: WorkArtifactsWorkspaceProps): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <ArtifactsWorkspace key={JSON.stringify([source, props.sessionId])} {...props} />
}

function ArtifactsWorkspace({ finalSelection, ...props }: WorkArtifactsWorkspaceProps): JSX.Element {
  const { sessionId, messages, selection, active = true } = props
  const catalog = useMemo(() => workFinalResultCatalog(messages, sessionId), [messages, sessionId])
  const requestKey = JSON.stringify(finalSelection?.sessionId === sessionId ? finalSelection : null)
  const reviewKey = JSON.stringify(selection?.sessionId === sessionId ? selection : null)
  const [dismissedReview, setDismissedReview] = useState('')
  const [choice, setChoice] = useState<{ requestKey: string; deliveryKey: string; runId: string; itemId?: string }>()
  const local = choice?.requestKey === requestKey && choice.deliveryKey === catalog.deliveryKey &&
    catalog.results.some(result => result.runId === choice.runId &&
      (!choice.itemId || result.items.some(item => item.id === choice.itemId))) ? choice : undefined
  const requested = finalSelection?.sessionId === sessionId ? finalSelection : null
  const defaultResult = catalog.latestDelivery ?? catalog.current ?? catalog.results[0]
  const validRequest = requested && catalog.results.some(result => result.runId === requested.runId &&
    result.items.some(item => item.id === requested.itemId)) ? requested : null
  const selectedRun = local?.runId ?? validRequest?.runId ?? defaultResult?.runId
  const result = selectedRun ? catalog.results.find(candidate => candidate.runId === selectedRun) : undefined
  const selectedItemId = local?.itemId ?? (validRequest && validRequest.runId === selectedRun ? validRequest.itemId : undefined)
  const item = result?.items.find(candidate => candidate.id === selectedItemId) ?? result?.items[0]
  const reviewing = !requested && selection?.sessionId === sessionId && reviewKey !== dismissedReview
  if (reviewing) return <div className="work-artifacts-workspace work-artifacts-workspace--review">
    <div className="work-artifacts-workspace__review-header"><button type="button" className="work-quiet-button" disabled={!active}
      onClick={() => setDismissedReview(reviewKey)}><Icon name="chevron-left" size={14} />返回成果</button><span>过程文件</span></div>
    <WorkSessionArtifacts {...props} />
  </div>
  // A session can contain real file changes even when the model did not
  // publish a `deliver_files` manifest (for example an interrupted run or a
  // legacy engine). Keep those files reachable from 成果 instead of showing
  // an empty final-delivery panel. The change ledger remains the source of
  // truth here; it is deliberately labelled as file changes rather than as a
  // fabricated final delivery.
  if (!requested && !catalog.current && !catalog.results.length) return <section className="work-artifacts-workspace work-artifacts-workspace--changes-fallback"
    aria-label="本会话成果" data-final-result-fallback="changes">
    <WorkSessionArtifacts {...props} />
  </section>
  const options = [{ value: '', label: defaultResult && defaultResult.runId === catalog.current?.runId ? '本轮成果' : '最近成果', description: defaultResult ? `${defaultResult.items.length} 个交付物` : '本轮尚未发布交付物' },
    ...catalog.results.filter(entry => entry.runId !== defaultResult?.runId).map(entry => ({ value: entry.runId,
      label: new Date(entry.publishedAt).toLocaleString(),
      description: entry.items.length ? entry.items.map(file => file.name).join('、') : '本轮仅有文字回复' }))]
  const selectRun = (runId: string): void => setChoice({ requestKey, deliveryKey: catalog.deliveryKey, runId: runId || defaultResult?.runId || '' })
  return <section className="work-artifacts-workspace" aria-label="本会话成果" data-final-result-session={sessionId}>
    <header className="work-artifacts-workspace__toolbar">
      <Select ariaLabel="选择交付轮次" value={result?.runId === defaultResult?.runId ? '' : result?.runId ?? ''} options={options} onChange={selectRun} disabled={!active} />
      <span>{result?.items.length ?? 0} 个交付物</span>
    </header>
    {result?.items.length ? <div className="work-artifacts-workspace__split">
      <nav className="work-artifacts-workspace__files" data-scroll-axis="x" aria-label="本轮交付物">
        {result.items.map(entry => <button key={entry.id} type="button" data-final-result-item={entry.id} aria-current={entry.id === item?.id ? 'true' : undefined}
          title={entry.path} disabled={!active} onClick={() => setChoice({ requestKey, deliveryKey: catalog.deliveryKey, runId: result.runId, itemId: entry.id })}>
          <FileGlyph name={finalResultPreviewFormat(entry)} size={16} /><span>{entry.name}</span>
        </button>)}
      </nav>
      {item ? <WorkFinalResult result={result} itemId={item.id} active={active && props.ready} /> : <div className="work-final-result__status" role="status">所选交付物不在本轮发布清单中。</div>}
    </div> : <div className="work-artifacts-workspace__empty" role="status"><Icon name="file-check" size={28} />
      <strong>{result ? '本轮没有文件交付物' : '本轮尚无成果'}</strong>
      <span>{result ? '本轮结果已在对话中回复。' : props.streaming ? '完成后，最终交付的文件和图片会显示在这里。' : '明确交付的文件和图片会显示在这里。'}</span>
    </div>}
  </section>
}
