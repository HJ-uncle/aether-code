import { useCallback, useRef, useState, type RefObject } from 'react'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { copyIntoWorkspace } from '@renderer/core/workspace/fs-client'

/**
 * 聊天附件（图片 / 文本 / 文档）
 *
 * 上传链路：渲染层的 File / Blob 出于浏览器安全模型拿不到真实磁盘路径，
 * 因此把字节流经 IPC 落盘到工作区的 `.aether/attachments/`，再把**相对路径**
 * 交给引擎 —— 引擎的 `/workspace` 白名单只认工作区内的路径，这样它才能读回。
 *
 * 支持三种入口：回形针按钮选文件、拖拽到输入框、直接粘贴（截图/复制的文件）。
 */

/** 单文件上限：超大文件上传会长时间卡住，且几乎没有模型能消费 */
const MAX_FILE_BYTES = 20 * 1024 * 1024

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

export interface UseAttachmentsResult {
  /** 已上传、待随下一条消息发出的附件 */
  attachments: ChatAttachment[]
  /** 是否有文件正在上传 */
  uploading: boolean
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
  /** 最近一次失败原因（供界面提示；读取后自动清空由调用方决定） */
  error: string | null
  clearError: () => void
}

export function useAttachments(root: string | null): UseAttachmentsResult {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const accept = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      if (!root) {
        setError('请先打开一个项目目录，附件需要落盘到工作区')
        return
      }

      void (async () => {
        setUploading(true)
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
          try {
            const data = await readBytes(file)
            const result = await copyIntoWorkspace({ root, fileName: file.name, data })
            setAttachments((prev) => [
              ...prev,
              {
                path: result.relativePath,
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: result.size
              }
            ])
          } catch (e) {
            setError(e instanceof Error ? e.message : `上传「${file.name}」失败`)
          }
        }
        setUploading(false)
      })()
    },
    [root]
  )

  const pick = useCallback(() => {
    if (!root) {
      setError('请先打开一个项目目录，附件需要落盘到工作区')
      return
    }
    inputRef.current?.click()
  }, [root])

  const remove = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((item) => item.path !== path))
  }, [])

  const clear = useCallback(() => setAttachments([]), [])

  return {
    attachments,
    uploading,
    dragging,
    fileInputRef: inputRef,
    pick,
    remove,
    clear,
    accept,
    setDragging,
    error,
    clearError: () => setError(null)
  }
}
