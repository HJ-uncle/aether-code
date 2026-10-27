import type { FsFileContent } from '@shared/ipc'

export interface WorkArtifactContent {
  content: string | null
  isBinary?: boolean
  base64?: string
  bytes?: ArrayBuffer
  size?: number
  coverage: 'current' | 'partial' | 'receipt' | 'unavailable'
  notice: string
}

/** A write receipt describes a past version; it cannot certify the current file. */
export function workArtifactReadFailure(receipt: string | null, reason: unknown): WorkArtifactContent {
  const error = reason instanceof Error ? reason.message : String(reason)
  return receipt === null
    ? { content: null, coverage: 'unavailable', notice: error }
    : { content: receipt, coverage: 'receipt', notice: `当前文件读取失败，显示写入回执中的历史版本。${error}` }
}

export function workArtifactReadResult(file: Pick<FsFileContent, 'content' | 'isBinary' | 'truncated' | 'tooLarge'> & Partial<Pick<FsFileContent, 'base64' | 'bytes' | 'size'>>): WorkArtifactContent {
  if (file.isBinary) return (file.base64 || file.bytes) && !file.tooLarge && !file.truncated
    ? { content: null, isBinary: true, base64: file.base64, bytes: file.bytes, size: file.size, coverage: 'current', notice: '' }
    : { content: null, isBinary: true, coverage: 'unavailable', notice: file.tooLarge ? '文件超过当前预览读取上限，可保存原文件。' : '未能读取完整文件，请刷新后重试。' }
  if (typeof file.content !== 'string') return { content: null, coverage: 'unavailable', notice: '工作区返回了无效的文件内容。' }
  if (file.tooLarge && !file.content) return { content: null, coverage: 'unavailable', notice: '文件过大，无法在此预览，请在编辑器打开。' }
  if (file.truncated || file.tooLarge) return { content: file.content, coverage: 'partial', notice: '仅显示文件的预览片段。复制和保存只包含此片段，添加到对话会引用当前文件路径。' }
  return { content: file.content, coverage: 'current', notice: '' }
}

export function workArtifactExportName(name: string, coverage: WorkArtifactContent['coverage']): string {
  return coverage === 'partial' ? `${name}.preview.txt` : coverage === 'receipt' ? `${name}.receipt.txt` : name
}

export function workArtifactSelectionQuote(name: string, path: string, selection: string, coverage?: WorkArtifactContent['coverage']): string {
  const source = coverage === 'receipt' ? '历史写入回执' : coverage === 'partial' ? '文件预览片段' : '文件预览'
  return `引用「${name}」${source}中的选中内容（${path}）：\n${selection.split('\n').map(line => `> ${line}`).join('\n')}\n`
}
