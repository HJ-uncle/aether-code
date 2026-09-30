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
  const cursor = editor.cursor

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

  if (doc.error && !isDirty(doc)) {
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

  // 非激活标签也要挂载：EditorArea 只渲染激活的文档，故这里恒为激活文档。
  // 但光标读数仍要按「光标报告的是哪个文件」过滤：切标签的瞬间 cursor 可能
  // 还停在上一个文件，直接显示会闪出错文件的行列号。
  return (
    <div className="doc-view">
      {doc.error ? <div className="notice notice--error" role="alert">{doc.error}</div> : null}
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
        {/* 光标位置：VS Code 放在这里而不是全局状态栏 —— 它属于「这个文件」，
            标签一换就该跟着消失，用文档自身的订阅即可，不必让状态栏去猜 */}
        {cursor && cursor.filePath === doc.path ? (
          <span data-testid="doc-cursor">
            行 {cursor.line}，列 {cursor.column}
          </span>
        ) : null}
        {isDirty(doc) ? <span className="doc-view__dirty">● 未保存</span> : <span>已保存</span>}
      </footer>
    </div>
  )
}
