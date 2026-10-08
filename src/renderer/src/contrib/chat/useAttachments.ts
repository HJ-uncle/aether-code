import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { getEngineSource, isRemoteEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
import { copyIntoWorkspace } from '@renderer/core/workspace/fs-client'
import { cancelAttachmentUpload, uploadAttachment } from '@renderer/core/engine/client'

/**
 * 聊天附件（图片 / 文本 / 文档）
 *
 * 上传链路：渲染层的 File / Blob 出于浏览器安全模型拿不到真实磁盘路径，
 * 因此把字节流经 IPC 落盘到工作区的 `.ae/attachments/`，再把**相对路径**
 * 交给引擎 —— 引擎的 `/workspace` 白名单只认工作区内的路径，这样它才能读回。
 *
 * 支持三种入口：回形针按钮选文件、拖拽到输入框、直接粘贴（截图/复制的文件）。
 */

/** 单文件上限：超大文件上传会长时间卡住，且几乎没有模型能消费 */
const MAX_FILE_BYTES = 20 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 120_000

/** 粘贴长文本的附件化阈值（与 wuzu-client 对齐） */
const PASTED_TEXT_MAX_CHARS = 2_000
const PASTED_TEXT_MAX_LINES = 200

/** 判断一段粘贴文本是否「长」到需要落成附件（照抄 wuzu-client 规则） */
export function shouldAttachPastedText(text: string): boolean {
  if (text.length > PASTED_TEXT_MAX_CHARS) return true
  const lines = text.split(/\r\n|\r|\n/)
  return lines.length > PASTED_TEXT_MAX_LINES
}

/** 把一段长文本包成「粘贴的文本-<首行>.txt」File（照抄 wuzu-client 命名规则） */
export function createPastedTextFile(text: string): File {
  const title = text
    .split(/\r\n|\r|\n/)
    .find((line) => line.trim())
    ?.trim()
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|-]/g, '')
    .slice(0, 48)
    .trim()
  return new File([text], `粘贴的文本${title ? `-${title}` : ''}.txt`, {
    type: 'text/plain;charset=utf-8'
  })
}

/** 图片类型：多模态模型直接看，非视觉模型走 OCR */
const IMAGE_RE = /^image\//

/** 文本/文档类型白名单（与引擎 smart_read 支持的格式对齐） */
const DOC_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'log',
  'csv',
  'tsv',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'sql',
  'lua',
  'dart',
  'r',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx'
])

/** 文本文件（MIME 常为空，主要靠扩展名识别） */
const TEXT_MIME_RE = /^text\//

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

/** 是否是可接受的附件类型 */
export function isSupportedFile(file: File): boolean {
  if (IMAGE_RE.test(file.type) || TEXT_MIME_RE.test(file.type)) return true
  // 浏览器对不少文档只给 application/octet-stream 甚至空 type，退回扩展名判断
  return DOC_EXTENSIONS.has(extensionOf(file.name))
}

/** 读取 File 的字节（结构化克隆经 IPC 传递，主进程侧是 Uint8Array） */
async function readBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

/** File reads and local IPC have no abort contract; stop waiting and ignore their late results. */
function waitForUpload<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('附件上传已取消'))
    // Attach both handlers even if cancellation already won, so a late IPC
    // rejection is consumed instead of becoming an unhandled rejection.
    operation.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) }
    )
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

interface PendingUpload {
  id: string
  file: File
  controller: AbortController
}

export interface UseAttachmentsResult {
  /** 已上传、待随下一条消息发出的附件 */
  attachments: ChatAttachment[]
  /** 是否有文件正在上传 */
  uploading: boolean
  /** 首个处理中或排队中的文件，用于定位等待项。 */
  uploadingFileName: string | null
  uploadingCount: number
  /** 取消所有未完成上传，保留已经成功添加的附件。 */
  cancelUpload: () => void
  /** 拖拽悬停在输入区（用于高亮） */
  dragging: boolean
  /** 隐藏的 <input type="file">，由 pick() 触发 */
  fileInputRef: RefObject<HTMLInputElement | null>
  /** 选择本地文件（回形针按钮） */
  pick: () => void
  /** 移除一个已上传附件 */
  remove: (path: string) => void
  /** 清空（发送后调用） */
  clear: () => void
  /** 接收来自拖拽 / 粘贴的 File 列表 */
  accept: (files: File[]) => void
  /** 拖拽进入 / 离开输入区 */
  setDragging: (value: boolean) => void
  /** 最近一次失败原因，保留到关闭、再次上传或切换会话。 */
  error: string | null
  clearError: () => void
}

export function useAttachments(root: string | null, sessionId = ''): UseAttachmentsResult {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [pendingUploads, setPendingUploads] = useState<Array<{ id: string; fileName: string }>>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const renderSource = getEngineSource()
  const generationRef = useRef(0)
  const pendingUploadsRef = useRef(new Map<string, PendingUpload>())

  const syncPendingUploads = useCallback(() => {
    setPendingUploads([...pendingUploadsRef.current.values()].map(({ id, file }) => ({ id, fileName: file.name })))
  }, [])

  const abortUploads = useCallback((notify = true) => {
    for (const task of pendingUploadsRef.current.values()) {
      task.controller.abort(new DOMException('附件上传已取消', 'AbortError'))
    }
    pendingUploadsRef.current.clear()
    if (notify) setPendingUploads([])
  }, [])
  const cancelUpload = useCallback(() => abortUploads(), [abortUploads])

  const clear = useCallback(() => {
    generationRef.current++
    abortUploads()
    setAttachments([])
    setDragging(false)
    setError(null)
  }, [abortUploads])

  useEffect(() => {
    const generation = generationRef.current
    void Promise.resolve().then(() => { if (generation === generationRef.current) clear() })
    const off = subscribeEngineSource(clear)
    return () => { generationRef.current++; abortUploads(false); off() }
  }, [root, sessionId, clear, abortUploads])

  const accept = useCallback(
    (files: File[]) => {
      if (files.length === 0 || renderSource !== getEngineSource()) return
      const remote = isRemoteEngine()
      if (remote && !sessionId) {
        setError('请先建立远端会话，再上传附件')
        return
      }
      if (!remote && !root) {
        setError('请先打开一个项目目录，附件需要落盘到工作区')
        return
      }

      const generation = generationRef.current
      const isCurrent = (): boolean => generation === generationRef.current && renderSource === getEngineSource()
      const tasks: PendingUpload[] = []
      setError(null)
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          setError(`「${file.name}」超过 20MB，已跳过`)
          continue
        }
        if (!isSupportedFile(file)) {
          setError(`「${file.name}」类型不支持，已跳过`)
          continue
        }
        const task: PendingUpload = { id: crypto.randomUUID(), file, controller: new AbortController() }
        pendingUploadsRef.current.set(task.id, task)
        tasks.push(task)
      }
      syncPendingUploads()
      void (async () => {
        // A batch remains sequential to avoid retaining many 20 MB buffers at once.
        // Separate paste/drop batches are independent and share the same pending registry.
        for (const task of tasks) {
          const { file, controller, id } = task
          const { signal } = controller
          let remoteRequestStarted = false
          let timer: number | undefined
          const cancelRemote = (): void => {
            if (!remoteRequestStarted) return
            // Cancellation must never strand the renderer if the bridge is already gone.
            try { void cancelAttachmentUpload(id).catch(() => undefined) } catch { /* transport closed */ }
          }
          signal.addEventListener('abort', cancelRemote, { once: true })
          try {
            if (!isCurrent() || signal.aborted) continue
            timer = window.setTimeout(() => controller.abort(new DOMException('附件上传超时，请重试', 'TimeoutError')), UPLOAD_TIMEOUT_MS)
            const data = await waitForUpload(readBytes(file), signal)
            if (!isCurrent() || signal.aborted) continue
            remoteRequestStarted = remote
            const result = remote
              ? await waitForUpload(uploadAttachment({ requestId: id, sessionId, fileName: file.name, type: file.type || 'application/octet-stream', data }), signal)
              : await waitForUpload(copyIntoWorkspace({ root: root as string, fileName: file.name, data }), signal)
            if (!isCurrent() || signal.aborted) continue
            const attachmentPath = 'relativePath' in result ? result.relativePath : result.path
            setAttachments((prev) => [
              ...prev,
              {
                path: attachmentPath,
                ...(remote && 'remoteUploadId' in result ? { remoteUploadId: result.remoteUploadId } : {}),
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: result.size
              }
            ])
          } catch (e) {
            if (!isCurrent()) continue
            const reason: unknown = signal.aborted ? signal.reason : e
            if (reason instanceof Error && reason.name === 'AbortError') continue
            setError(`上传「${file.name}」失败：${ipcErrorMessage(reason)}`)
          } finally {
            window.clearTimeout(timer)
            signal.removeEventListener('abort', cancelRemote)
            // A cancelled/cleared task can finish after a new batch has started.
            // Only remove its own entry; never reset another batch's busy state.
            if (pendingUploadsRef.current.get(id) === task) {
              pendingUploadsRef.current.delete(id)
              if (isCurrent()) syncPendingUploads()
            }
          }
        }
      })()
    },
    [root, renderSource, sessionId, syncPendingUploads]
  )

  const pick = useCallback(() => {
    if (renderSource !== getEngineSource()) return
    if (isRemoteEngine() && !sessionId) {
      setError('请先建立远端会话，再上传附件')
      return
    }
    if (!isRemoteEngine() && !root) {
      setError('请先打开一个项目目录，附件需要落盘到工作区')
      return
    }
    inputRef.current?.click()
  }, [root, renderSource, sessionId])

  const remove = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((item) => item.path !== path))
  }, [])
  const clearError = useCallback(() => setError(null), [])

  return {
    attachments,
    uploading: pendingUploads.length > 0,
    uploadingFileName: pendingUploads[0]?.fileName ?? null,
    uploadingCount: pendingUploads.length,
    cancelUpload,
    dragging,
    fileInputRef: inputRef,
    pick,
    remove,
    clear,
    accept,
    setDragging,
    error,
    clearError
  }
}
