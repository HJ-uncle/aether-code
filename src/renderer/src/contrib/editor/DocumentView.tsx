import type { JSX } from 'react'
import { isDirty, setDocumentContent, useEditor } from '@renderer/core/editor/editor-store'
import { formatSize } from '@renderer/core/editor/preview'
import { FilePreview } from './FilePreview'
import { MonacoEditor } from './MonacoEditor'

/**
 * 单个文档的视图
 *
 * 按文档类型分流：文本走 Monaco，二进制走只读预览（图片/视频/十六进制）。
 * 二进制**不提供编辑与保存** —— 用文本编辑器改二进制必然损坏文件。
 * 超限的二进制给出明确说明而不是硬读（见主进程 MAX_BINARY_BYTES）。
 */
export function DocumentView({ filePath }: { filePath: string }): JSX.Element {
  const editor = useEditor()
  const doc = editor.docs.get(filePath)

  if (!doc) {
    return (
      <div className="doc-placeholder">
        <p>文件已关闭。</p>
      </div>
    )
  }

  if (doc.loading) {
    return (
      <div className="doc-placeholder">
        <p>正在读取 {doc.name} …</p>
      </div>
    )
  }

  if (doc.error) {
    return (
      <div className="doc-placeholder">
        <div className="notice notice--error">{doc.error}</div>
      </div>
    )
  }

  if (doc.isBinary) {
    // 超过读取上限：主进程没有返回内容，别装作能预览
    if (doc.tooLarge || !doc.base64) {
      return (
        <div className="doc-placeholder">
          <p>
            文件过大（{formatSize(doc.size)}），不做预览。
            <br />
            二进制内容以 base64 驻留内存会显著膨胀，请用外部工具打开。
          </p>
        </div>
      )
    }

    return <FilePreview name={doc.name} path={doc.path} base64={doc.base64} size={doc.size} />
  }

  return (
    <div className="doc-view">
      {doc.truncated ? (
        <div className="doc-view__banner">
          文件较大，仅载入了前 4 MB。直接保存会截断文件，请用外部工具处理。
        </div>
      ) : null}
      <MonacoEditor
        filePath={doc.path}
        value={doc.content}
        onChange={(value) => setDocumentContent(doc.path, value)}
        reveal={editor.reveals[doc.path]}
      />
      <footer className="doc-view__status">
        <span>{doc.content.length.toLocaleString()} 字符</span>
        {isDirty(doc) ? <span className="doc-view__dirty">● 未保存</span> : <span>已保存</span>}
      </footer>
    </div>
  )
}
