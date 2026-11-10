import { memo, useId, useMemo, useState, type JSX } from 'react'
import { ImageViewerDialog } from './ImageViewerDialog'
import { BrowserSnapshotResult } from './BrowserSnapshotResult'
import { parseToolResult, type ParsedToolResult, type ToolResultImage } from './tool-result'
import { AutomationCard } from '../automations/AutomationCard'
import { parseAutomationReceipt } from '../automations/automation-draft'
import { looksLikeStructuredResult, ToolResultData } from './ToolResultData'
import { parseToolResultData } from './tool-result-data'
import { useToolImageGallery } from './ToolImageGalleryProvider'
import { buildToolImageGallery, toolImageReference, type ToolImageGalleryGroup } from './tool-image-gallery'
import './tool-result.css'

function ResultImage({ image, onOpen }: { image: ToolResultImage; onOpen: () => void }): JSX.Element {
  const [failedSource, setFailedSource] = useState('')
  const failed = failedSource === image.src
  return (
    <figure className="tool-result__image">
      {failed ? <div className="tool-result__image-error" role="status">图片无法显示</div> : (
        <button type="button" className="tool-result__preview" aria-label={`放大查看 ${image.alt}`} onClick={onOpen}>
          <img src={image.src} alt={image.alt} decoding="async" onError={() => setFailedSource(image.src)} />
        </button>
      )}
    </figure>
  )
}

/** The same renderer is used for parent tools, child tools and restored history. */
export const ToolResult = memo(function ToolResult({
  value,
  parsed,
  toolId,
  toolName,
  toolArgs,
  textClassName,
  structured = false,
  surfaceMode = 'code'
}: {
  value?: unknown
  parsed?: ParsedToolResult
  toolId?: string
  toolName?: string
  toolArgs?: unknown
  textClassName?: string
  structured?: boolean
  surfaceMode?: 'code' | 'work'
}): JSX.Element {
  const result = useMemo(() => parsed ?? parseToolResult(value), [parsed, value])
  const fallbackId = useId(), owner = useToolImageGallery()
  const localId = toolId ?? fallbackId
  const local = useMemo(() => buildToolImageGallery([{ toolId: localId, toolName: toolName ?? '', args: toolArgs, result }],
    { source: 0, sessionId: owner?.index.scope ?? fallbackId }), [localId, toolName, toolArgs, result, owner?.index.scope, fallbackId])
  // Freeze the opened receipts while annotating. A new render can enrich a
  // legacy group or replace the same page, but must not discard an active edit.
  const scope = owner?.index.scope ?? fallbackId
  const [selection, setSelection] = useState<{ group: ToolImageGalleryGroup; identity: string; open: boolean; scope: string } | null>(null)
  const group = selection?.group
  const selectedIndex = group?.items.findIndex(item => item.identity === selection?.identity) ?? -1
  const selected = selectedIndex >= 0 ? group?.items[selectedIndex] : undefined
  const openImage = (index: number): void => {
    const reference = toolImageReference(localId, index)
    const shared = owner?.index.images.get(reference)
    const sharedImage = shared && owner?.index.groups.get(shared.groupId)?.items.find(item => item.identity === shared.identity)
    // A newer receipt of the same page may replace an older one in the index.
    // Never substitute different pixels for the thumbnail the user selected.
    const target = sharedImage?.image.src === result.images[index].src ? shared : local.images.get(reference)
    const targetGroup = target && (owner?.index.groups.get(target.groupId) ?? local.groups.get(target.groupId))
    if (target && targetGroup) setSelection({ group: targetGroup, identity: target.identity, open: true, scope })
  }
  const navigate = (delta: number): void => {
    const next = group?.items[selectedIndex + delta]
    if (next && group) setSelection({ group, identity: next.identity, open: true, scope })
  }
  const data = useMemo(() => (structured || surfaceMode === 'work') && !result.images.length && !result.browserSnapshots?.length ? parseToolResultData(result.text) : null, [structured, surfaceMode, result])
  const receipt = useMemo(() => ['cron_create', 'cron_update'].includes(toolName ?? '')
    ? parseAutomationReceipt(value ?? result.text) : null, [toolName, value, result.text])
  if (receipt) return <><AutomationCard receipt={receipt} />{surfaceMode === 'code' ? <details className="automation-card-receipt"><summary>原始收据</summary><pre className={textClassName}>{result.text}</pre></details> : null}</>
  if (data) return <ToolResultData data={data} raw={result.text} surfaceMode={surfaceMode} />
  if (!result.images.length && !result.browserSnapshots?.length) {
    // Unbounded or incomplete JSON is not a useful user-facing fallback. Keep
    // ordinary prose/logs verbatim, without exposing a second diagnostic view.
    if (surfaceMode === 'work' && looksLikeStructuredResult(result.text)) return <div className="tool-result__summary">结果已返回，暂无可展示的摘要</div>
    return <pre className={textClassName}>{result.text}</pre>
  }
  return (
    <div className="tool-result">
      <div className="tool-result__images">
        {result.images.map((image, index) => <ResultImage key={`${index}:${image.alt}`} image={image} onOpen={() => openImage(index)} />)}
        {result.browserSnapshots?.map((snapshot, index) => <BrowserSnapshotResult key={`${index}:${snapshot.url}`} snapshot={snapshot} clickResult={toolName === 'browser_click'} surfaceMode={surfaceMode} />)}
      </div>
      {result.text && surfaceMode === 'code' ? (
        <details className="tool-result__metadata">
          <summary>{result.browserSnapshots?.length ? '原始数据' : '结果详情'}</summary>
          <pre className={textClassName}>{result.text}</pre>
        </details>
      ) : null}
      <ImageViewerDialog src={selected?.image.src ?? null} title={selected?.image.alt ?? '工具输出图片'}
        imageIdentity={selected?.identity} filePath={selected?.image.documentPage?.path}
        positionLabel={group && group.items.length > 1 ? `${selectedIndex + 1} / ${group.items.length}` : undefined}
        open={Boolean(selection?.open && selection.scope === scope && selected && owner?.active !== false)}
        onClose={() => setSelection(previous => previous ? { ...previous, open: false } : null)}
        onPrevious={group && group.items.length > 1 ? () => navigate(-1) : undefined}
        onNext={group && group.items.length > 1 ? () => navigate(1) : undefined}
        canPrevious={selectedIndex > 0} canNext={Boolean(group && selectedIndex >= 0 && selectedIndex < group.items.length - 1)} />
    </div>
  )
})
