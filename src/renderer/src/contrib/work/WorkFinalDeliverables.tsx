import { useState, type JSX } from 'react'
import type { FinalResult, FinalResultItem } from '@shared/final-result'
import { formatSize } from '@renderer/core/editor/preview'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon } from '@renderer/workbench/icons'
import { WorkFinalResult } from './WorkFinalResult'
import { downloadFinalResultAsset, readFinalResultAsset, useFinalAssetUrl, useFinalResultAsset } from './useFinalResultAsset'
import './work-final-result.css'

export interface WorkFinalDeliverablesProps {
  result: FinalResult
  active?: boolean
  onOpenItem?: (result: FinalResult, item: FinalResultItem) => void
}

/** Only explicitly published files enter the answer. Tool screenshots and
 * changed paths keep their original process location. */
export function WorkFinalDeliverables({ result, active = true, onOpenItem }: WorkFinalDeliverablesProps): JSX.Element | null {
  if (!result.items.length) return null
  return <section className="work-final-deliverables" aria-label="最终交付物" data-final-result-session={result.sessionId} data-final-result-run={result.runId}>
    {result.items.map(item => <FinalDeliverable key={JSON.stringify([result.sessionId, result.runId, item.id, item.assetId])}
      result={result} item={item} active={active} onOpenItem={onOpenItem} />)}
  </section>
}

function FinalDeliverable({ result, item, active, onOpenItem }: { result: FinalResult; item: FinalResultItem; active: boolean; onOpenItem?: WorkFinalDeliverablesProps['onOpenItem'] }): JSX.Element {
  const image = item.kind === 'image'
  const { asset, error, retry, current, source } = useFinalResultAsset(result, item, active && image)
  const src = useFinalAssetUrl(asset)
  const [failedSource, setFailedSource] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [actionError, setActionError] = useState('')
  const failure = error || actionError || (src && failedSource === src ? '图片内容无法解码' : '')
  const download = async (): Promise<void> => {
    if (!active || !current || downloading) return
    setDownloading(true); setActionError('')
    try { downloadFinalResultAsset(item, asset ?? await readFinalResultAsset(result, item, source), source) }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : '下载失败，请重试') }
    finally { setDownloading(false) }
  }
  return <article className={`work-final-deliverable${image ? ' work-final-deliverable--image' : ''}`} data-final-result-item={item.id} data-final-result-kind={item.kind}>
    {image ? failure ? null : src ? <button type="button" className="work-final-deliverable__image" aria-label={`放大查看 ${item.name}`}
      disabled={!active || !current} onClick={() => setExpanded(true)}>
      <img src={src} alt={item.name} decoding="async" onError={() => setFailedSource(src)} />
    </button> : <div className="work-final-deliverable__loading" role="status">正在加载图片…</div> : null}
    <div className="work-final-deliverable__info">
      <Icon name={image ? 'image' : 'file'} size={18} />
      <div className="work-final-deliverable__name"><strong title={item.name}>{item.name}</strong><span>{formatSize(item.size)}</span></div>
      <button type="button" className="work-quiet-button" aria-label={`预览 ${item.name}`} disabled={!active || !current}
        onClick={() => onOpenItem ? onOpenItem(result, item) : setExpanded(true)}>预览</button>
      <button type="button" className="work-quiet-button" aria-label={`下载 ${item.name}`} disabled={!active || !current || downloading} onClick={() => void download()}>
        <Icon name="cloud-download-outline" size={14} />{downloading ? '正在下载…' : '下载'}
      </button>
    </div>
    {failure ? <div className="work-final-deliverable__error" role="alert"><span>{failure}</span>{current ? <button type="button" disabled={!active} onClick={() => {
      setFailedSource(''); setActionError(''); if (image) retry(); else void download()
    }}>重新加载</button> : null}</div> : null}
    <Dialog title={item.name} width={960} className={image ? 'modal--final-result-image' : 'modal--final-result-file'}
      open={expanded && active && current && (!image || !!src && !failure)} onClose={() => setExpanded(false)}>
      {image ? <div className="work-final-result__expanded"><img src={src} alt={item.name} onError={() => setFailedSource(src ?? '')} /></div>
        : <WorkFinalResult result={result} itemId={item.id} active={expanded && active} />}
    </Dialog>
  </article>
}
