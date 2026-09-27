import { useMemo, type JSX } from 'react'
import {
  DEFAULT_HEX_BYTES,
  base64ToBytes,
  formatSize,
  hexDump,
  previewKindFor,
  toDataUrl
} from '@renderer/core/editor/preview'

interface FilePreviewProps {
  /** 文件名（用于判定预览方式与 MIME） */
  name: string
  /** 绝对路径（展示与排错用） */
  path: string
  /** 磁盘内容（base64） */
  base64: string
  size: number
}

/**
 * 二进制文件预览
 *
 * 只读。二进制**不提供编辑与保存**入口 —— 用文本编辑器改二进制必然损坏文件，
 * 宁可不给这个按钮。
 */
export function FilePreview({ name, path, base64, size }: FilePreviewProps): JSX.Element {
  const kind = previewKindFor(name)

  // 十六进制视图只解码前 16 KB：见 preview.ts 的 base64ToBytes 说明
  const dump = useMemo(
    () => (kind === 'hex' ? hexDump(base64ToBytes(base64, DEFAULT_HEX_BYTES)) : ''),
    [kind, base64]
  )

  const dataUrl = useMemo(
    () => (kind === 'hex' ? '' : toDataUrl(base64, name)),
    [kind, base64, name]
  )

  return (
    <div className="preview">
      <div className="preview__body">
        {kind === 'image' ? (
          <img className="preview__image" src={dataUrl} alt={name} title={path} />
        ) : kind === 'video' ? (
          <video
            className="preview__video"
            src={dataUrl}
            controls
            preload="metadata"
            title={path}
          />
        ) : (
          <pre className="preview__hex">{dump}</pre>
        )}
      </div>

      <footer className="preview__status">
        <span>{previewLabel(kind)}</span>
        <span>{formatSize(size)}</span>
        {kind === 'hex' ? <span>仅显示前 {formatSize(DEFAULT_HEX_BYTES)}</span> : null}
        <span className="preview__path" title={path}>
          {path}
        </span>
      </footer>
    </div>
  )
}

function previewLabel(kind: string): string {
  if (kind === 'image') return '图片预览'
  if (kind === 'video') return '视频预览'
  return '十六进制预览'
}
