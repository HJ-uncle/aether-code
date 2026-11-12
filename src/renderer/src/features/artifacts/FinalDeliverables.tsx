import { useId, useRef, useState, type JSX } from 'react'
import type { FinalResult, FinalResultItem } from '@shared/final-result'
import { extensionOf, formatSize } from '@renderer/core/editor/preview'
import { Dialog } from '@renderer/ui/Dialog'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { FileGlyph } from '../explorer/FileGlyph'
import { FinalResult as FinalResultPreview } from './FinalResult'
import { finalResultPreviewFormat } from './final-result-preview-format'
import { downloadFinalResultAsset, readFinalResultAsset, useFinalAssetUrl, useFinalResultAsset } from './useFinalResultAsset'
import './final-result.css'
import { useDocumentContextMenu, type DocumentMenuOptions } from '@renderer/core/editor/useDocumentContextMenu'

export interface FinalDeliverablesProps {
  result: FinalResult
  active?: boolean
  onOpenItem?: (result: FinalResult, item: FinalResultItem) => void
}

/** Only explicitly published files enter the answer. Tool screenshots and
 * changed paths keep their original process location. */
export function FinalDeliverables({ result, active = true, onOpenItem }: FinalDeliverablesProps): JSX.Element | null {
  if (!result.items.length) return null
  return <section className="work-final-deliverables" aria-label="最终交付物" data-final-result-session={result.sessionId} data-final-result-run={result.runId}>
    <div className="work-final-deliverables__grid">
      {result.items.map(item => <FinalDeliverable key={JSON.stringify([result.sessionId, result.runId, item.id, item.assetId])}
        result={result} item={item} active={active} onOpenItem={onOpenItem} />)}
    </div>
  </section>
}

function FinalDeliverable({ result, item, active, onOpenItem }: { result: FinalResult; item: FinalResultItem; active: boolean; onOpenItem?: FinalDeliverablesProps['onOpenItem'] }): JSX.Element {
  const image = item.kind === 'image'
  const { asset, error, loading, retry, current, source } = useFinalResultAsset(result, item, active && image)
  const src = useFinalAssetUrl(asset)
  const [failedSource, setFailedSource] = useState('')
  const [imageSize, setImageSize] = useState<{ src: string; width: number; height: number }>()
  const [expanded, setExpanded] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [actionError, setActionError] = useState('')
  const infoRef = useRef<HTMLDivElement>(null)
  const metadataId = useId()
  const format = extensionOf(finalResultPreviewFormat(item)).toUpperCase()
  const dimensions = imageSize && imageSize.src === src && failedSource !== src ? `${imageSize.width} × ${imageSize.height}` : ''
  const failure = error || actionError || (src && failedSource === src ? '图片内容无法解码' : '')
  const metadata = `${format === 'BIN' ? '文件' : format} · ${formatSize(item.size)}${dimensions ? ` · ${dimensions}` : ''}${item.producerChildSessionId ? ' · 子代理提交，已采用' : ''}`
  const download = async (): Promise<void> => {
    if (!active || !current || downloading) return
    setDownloading(true); setActionError('')
    try { downloadFinalResultAsset(item, asset ?? await readFinalResultAsset(result, item, source), source) }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : '下载失败，请重试') }
    finally { setDownloading(false) }
  }
  const open = (): void => { if (onOpenItem) onOpenItem(result, item); else setExpanded(true) }
  const documentMenu: DocumentMenuOptions = {
    identity: `${source}:${result.sessionId}:${result.runId}:${item.assetId}`, path: item.path,
    active: active && current, hasContent: false,
    getExtraItems: () => [{ id: 'download', label: '下载', disabled: downloading, onSelect: () => void download() }]
  }
  const { menu } = useDocumentContextMenu(infoRef, documentMenu)
  return <article className={`work-final-deliverable${image ? ' work-final-deliverable--image' : ''}`} data-final-result-item={item.id} data-final-result-kind={item.kind} data-producer-child-session={item.producerChildSessionId} data-producer-run={item.producerRunId}>
    <div ref={infoRef} className="work-final-deliverable__info" tabIndex={active && current ? 0 : -1} role="group" aria-label={item.name} aria-describedby={metadataId}>
        <span className={`work-final-deliverable__thumbnail${image ? ' work-final-deliverable__thumbnail--image' : ''}`} aria-hidden="true">
          {image && !failure && src ? <img src={src} alt="" decoding="async"
            onLoad={event => setImageSize({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setFailedSource(src)} />
            : loading ? <Spinner size={18} /> : image ? <Icon name="image" size={24} /> : <FileGlyph name={finalResultPreviewFormat(item)} size={26} />}
        </span>
        <span className="work-final-deliverable__name"><strong title={item.name}>{item.name}</strong>
          {failure ? <span id={metadataId} className="work-final-deliverable__error" role="alert" title={failure}>
            <span>{actionError ? '下载失败，请重试' : image ? '缩略图暂不可用' : '文件暂不可用'}</span>
            {image && !actionError && current ? <button type="button" className="work-final-deliverable__retry" disabled={!active}
              aria-label={`重新加载 ${item.name}`} onClick={() => { setFailedSource(''); retry() }}>重试</button> : null}
          </span> : <span id={metadataId} title={metadata}>{metadata}</span>}
        </span>
    </div>
    <div className="work-final-deliverable__actions">
      <button type="button" className="work-final-deliverable__action" aria-label={`预览 ${item.name}`} aria-describedby={metadataId}
        disabled={!active || !current} onClick={open}>预览</button>
      <button type="button" className="work-final-deliverable__action work-final-deliverable__download" aria-label={`下载 ${item.name}`}
        aria-busy={downloading} disabled={!active || !current || downloading} onClick={() => void download()}>
        {downloading ? <Spinner size={12} /> : null}下载
      </button>
    </div>
    <Dialog title={item.name} width={960} className="modal--final-result-file"
      open={expanded && active && current} onClose={() => setExpanded(false)}>
      <FinalResultPreview result={result} itemId={item.id} active={expanded && active} />
    </Dialog>
    {menu}
  </article>
}
