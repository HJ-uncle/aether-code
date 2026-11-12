import { useRef, useState, type JSX } from 'react'
import type { FinalResult, FinalResultItem } from '@shared/final-result'
import { formatSize } from '@renderer/core/editor/preview'
import { ImageViewerDialog } from '../conversation/shared/ImageViewerDialog'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { FilePreview } from '../editor/FilePreview'
import { TextPreview } from '../workspace/TextPreview'
import { finalResultPreviewFormat } from './final-result-preview-format'
import { downloadFinalResultAsset, useFinalAssetUrl, useFinalResultAsset } from './useFinalResultAsset'
import './final-result.css'
import { DocumentMenuProvider, useDocumentContextMenu } from '@renderer/core/editor/useDocumentContextMenu'

export interface FinalResultProps {
  result: FinalResult
  itemId?: string
  active?: boolean
}

/** This surface never opens the path on disk: the published asset remains the
 * same delivery after a later turn changes or deletes its original source. */
export function FinalResult({ result, itemId, active = true }: FinalResultProps): JSX.Element {
  const item = itemId ? result.items.find(candidate => candidate.id === itemId) : result.items[0]
  return item ? <FinalAssetPreview key={JSON.stringify([result.sessionId, result.runId, item.id, item.assetId])}
    result={result} item={item} active={active} /> : <div className="work-final-result__status" role="status">本轮没有文件交付物。</div>
}

function FinalAssetPreview({ result, item, active }: { result: FinalResult; item: FinalResultItem; active: boolean }): JSX.Element {
  const { asset, error, loading, retry, current, source } = useFinalResultAsset(result, item, active)
  const src = useFinalAssetUrl(item.kind === 'image' ? asset : undefined)
  const [failedSource, setFailedSource] = useState('')
  const [actionError, setActionError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const failure = error || actionError || (src && failedSource === src ? '图片内容无法解码' : '')
  const reload = (): void => { setFailedSource(''); setActionError(''); retry() }
  const download = (): void => {
    if (!asset) return
    try { downloadFinalResultAsset(item, asset, source); setActionError('') }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : '下载失败，请重试') }
  }
  return <DocumentMenuProvider value={{ identity: `${source}:${result.sessionId}:${result.runId}:${item.assetId}`, path: item.path, active: active && current,
    getExtraItems: () => [{ id: 'download', label: '下载', disabled: !asset || !current, onSelect: download }] }}>
    <section className="work-final-result" aria-label="交付物预览" data-final-result-session={result.sessionId}
    data-final-result-run={result.runId} data-final-result-item={item.id} data-final-result-asset={item.assetId}>
    <header className="work-final-result__toolbar">
      <div className="work-final-result__title"><strong title={item.name}>{item.name}</strong><span title={item.path}>{item.path}</span></div>
      <span className="work-final-result__size">{formatSize(item.size)}</span>
      <button type="button" className="work-quiet-button" aria-label={`下载 ${item.name}`} disabled={!active || !asset || !current} onClick={download}>
        <Icon name="download" size={14} />下载
      </button>
    </header>
    <div className="work-final-result__body">
      {failure ? <div className="work-final-result__status work-final-result__status--error" role="alert">
        <span>{failure}</span>{current ? <button type="button" disabled={!active} onClick={reload}>重新加载</button> : null}
      </div> : loading || !asset ? <div className="work-final-result__status" role="status"><Spinner size={16} />正在加载交付物…</div>
        : item.kind === 'image' ? src ? <FinalImage src={src} name={item.name} className="work-final-result__image"
          disabled={!active} onExpand={() => setExpanded(true)} onError={() => setFailedSource(src)} />
          : <span role="status">正在加载图片…</span> : asset.text !== undefined ? <TextPreview content={asset.text} name={item.name} active={active} />
          : <FilePreview name={item.name} formatName={finalResultPreviewFormat(item)} path={item.path} groupId={`${result.sessionId}:${result.runId}:${item.assetId}`}
            bytes={asset.bytes} base64={asset.base64} size={item.size} active={active} />}
    </div>
    <ImageViewerDialog src={src ?? null} title={item.name} filePath={item.path}
      open={expanded && active && current && !!src && !failure} onClose={() => setExpanded(false)} />
  </section></DocumentMenuProvider>
}

function FinalImage({ src, name, className, disabled, onExpand, onError }: {
  src: string; name: string; className: string; disabled?: boolean; onExpand?: () => void; onError: () => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const { menu } = useDocumentContextMenu(host, { hasContent: false, allowButtons: true })
  const image = <img src={src} alt={name} decoding="async" onError={onError} />
  return <div ref={host} tabIndex={onExpand ? undefined : 0} className={className}>
    {onExpand ? <button type="button" aria-label={`放大查看 ${name}`} disabled={disabled} onClick={onExpand}>{image}</button> : image}
    {menu}
  </div>
}
