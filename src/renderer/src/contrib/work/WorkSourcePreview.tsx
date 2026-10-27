import { useEffect, useMemo, useState, type JSX } from 'react'
import type { FsFileContent } from '@shared/ipc'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { getEngineSource, isRemoteEngine } from '@renderer/core/engine/source'
import { paths, readFile, readLocalRecoveryFile, readSessionFile, workspaceRecoveryCandidates } from '@renderer/core/workspace/fs-client'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { TextPreview } from '@renderer/core/editor/TextPreview'
import { FilePreview } from '../editor/FilePreview'
import { fileContentUrl } from '@renderer/core/workspace/file-content-bytes'

/** The task owns uploaded files even when the user has not opened a project. */
export function useWorkSourceFile(source: ChatAttachment, sessionId?: string, root?: string | null, enabled = true) {
  const epoch = getEngineSource()
  const key = JSON.stringify([epoch, sessionId, root, source.path, source.type, enabled])
  const [attempt, retry] = useState(0)
  const [state, setState] = useState<{ key: string; file?: FsFileContent; error?: string }>({ key })
  useEffect(() => {
    let active = true
    setState({ key })
    if (!enabled) return () => { active = false }
    const request = sessionId ? readSessionFile(sessionId, source.path, root).catch(async (reason: unknown) => {
      if (isRemoteEngine() || !root) throw reason
      const candidates = workspaceRecoveryCandidates(source.path, root)
      for (const candidate of candidates) {
        try { return await readLocalRecoveryFile(candidate) } catch { /* try the next bounded root */ }
      }
      throw reason
    })
      : root ? readFile(paths.join(root, source.path))
        : Promise.reject(new Error('资料没有关联任务，请重新选择任务'))
    void request.then(file => {
      if (active && epoch === getEngineSource()) setState({ key, file })
    }).catch((reason: unknown) => {
      if (active && epoch === getEngineSource()) setState({ key, error: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { active = false }
  }, [key, epoch, sessionId, root, source.path, enabled, attempt])
  return { ...(state.key === key ? state : { key }), retry: () => retry(value => value + 1) }
}

export function WorkSourcePreview({ source, sessionId, root }: { source: ChatAttachment; sessionId?: string; root: string | null }): JSX.Element | null {
  const { file, error, retry } = useWorkSourceFile(source, sessionId, root)
  const isImage = source.type.startsWith('image/')
  const image = useMemo(() => file && isImage ? fileContentUrl(file, source.type) : null, [file, isImage, source.type])
  useEffect(() => () => image?.revoke(), [image])
  const unavailable = error || (file?.tooLarge ? '文件超过当前预览读取上限。' : '') || (file?.isBinary && !file.base64 && !file.bytes ? '未能读取完整文件，请重试。' : '')
  if (unavailable) return <div className="work-sources__preview-empty" role="alert">
    <Icon name="warning" size={18} />
    <span>{unavailable}</span>
    <button type="button" className="work-quiet-button" onClick={retry}>重试读取</button>
  </div>
  if (!file) return <div className="work-sources__preview-empty" role="status">
    <Spinner size={16} /><span>{isImage ? '正在读取图片…' : '正在读取文件…'}</span>
  </div>
  if (isImage) return image ? <img className="work-sources__preview-image" src={image.url} alt={source.name} /> : null
  if (file.isBinary && (file.base64 || file.bytes)) return <FilePreview name={source.name} path={source.path} base64={file.base64} bytes={file.bytes} size={file.size} />
  const text = file.truncated ? `${file.content}\n\n…（内容过长已截断）` : file.content
  return <div className="work-sources__preview-text"><TextPreview content={text} name={source.name} /></div>
}
