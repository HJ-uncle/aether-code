import { useRef, useState, type JSX } from 'react'
import { isDirty, reloadDocumentFromDisk, setDocumentContent, useEditor } from '@renderer/core/editor/editor-store'
import { formatSize } from '@renderer/core/editor/preview'
import { useEditorGroups } from '@renderer/core/editor/editor-groups'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Icon } from '@renderer/workbench/icons'
import { toast } from '@renderer/core/toast'
import { FilePreview } from './FilePreview'
import { MonacoEditor } from './MonacoEditor'
import { EditorToolbar } from './EditorToolbar'
import { EditorOutline } from './EditorOutline'
import { EditorBlameStatus } from './EditorBlameStatus'
import { SourcePreview, type SourcePreviewHandle } from './SourcePreview'
import { useEditorPreviewScroll } from './useEditorPreviewScroll'

type PreviewMode = 'edit' | 'split' | 'preview'
const PREVIEW_MODES: { mode: PreviewMode; label: string; title: string }[] = [
  { mode: 'edit', label: '编辑', title: '仅显示源码' },
  { mode: 'split', label: '分屏预览', title: '并排显示源码与实时预览' },
  { mode: 'preview', label: '预览', title: '仅显示实时预览' }
]

/**
 * 单个文档的视图
 *
 * 按文档类型分流：文本走 Monaco，二进制走只读预览（图片/视频/十六进制）。
 * 二进制**不提供编辑与保存** —— 用文本编辑器改二进制必然损坏文件。
 * 超限的二进制给出明确说明而不是硬读（见主进程 MAX_BINARY_BYTES）。
 */
export function DocumentView({ filePath, groupId }: { filePath: string; groupId?: string }): JSX.Element {
  const editor = useEditor()
  const doc = editor.docs.get(filePath)
  const cursor = editor.cursor
  const { focusedGroupId } = useEditorGroups()
  const [previewMode, setPreviewMode] = useState<PreviewMode>('edit')
  const [outlineVisible, setOutlineVisible] = useState(false)
  const sourceContainer = useRef<HTMLDivElement>(null)
  const previewRef = useRef<SourcePreviewHandle>(null)
  const previewKind = /\.(md|markdown|mdown)$/i.test(filePath) ? 'markdown'
    : /\.(html?|xhtml)$/i.test(filePath) ? 'html' : null
  const onPreviewScroll = useEditorPreviewScroll(sourceContainer, previewRef, previewMode === 'split', filePath)

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
      <EditorToolbar filePath={doc.path} groupId={groupId}>
        {previewKind ? <div className="editor-preview-modes" aria-label="文档显示模式">
          {PREVIEW_MODES.map(({ mode, label, title }) => (
            <button key={mode} type="button" className="editor-toolbar__button" title={title}
              aria-pressed={previewMode === mode} onClick={() => setPreviewMode(mode)}>{label}</button>
          ))}
        </div> : null}
        <button type="button" className={`editor-toolbar__button${outlineVisible ? ' is-active' : ''}`}
          aria-label="切换文件大纲" title="切换文件大纲" aria-pressed={outlineVisible}
          onClick={() => setOutlineVisible((value) => !value)}>
          <Icon name="graph" size={14} /><span>大纲</span>
        </button>
      </EditorToolbar>
      {doc.error ? <div className="notice notice--error" role="alert">{doc.error}</div> : null}
      {doc.externalChange ? <div className="doc-view__external-change" role="status">
        <span>{doc.externalChange === 'deleted'
          ? '文件已在磁盘上删除，编辑区内容仍保留。'
          : '磁盘上的文件已更新，当前未保存的修改仍保留。'}</span>
        {doc.externalChange === 'modified' ? <button type="button" onClick={() => {
          void (async () => {
            if (isDirty(doc) && !await confirmDialog({
              title: '重新加载文件', body: '将丢弃当前未保存的修改并载入磁盘版本。',
              confirmText: '重新加载', danger: true
            })) return
            try { await reloadDocumentFromDisk(doc.path) }
            catch (reason) { toast.error(`重新加载失败：${reason instanceof Error ? reason.message : String(reason)}`) }
          })()
        }}>重新加载磁盘版本</button> : null}
      </div> : null}
      {doc.truncated ? (
        <div className="doc-view__banner">
          文件较大，仅载入了前 4 MB，当前为只读预览。请用外部工具编辑完整文件。
        </div>
      ) : null}
      <div className="doc-view__workspace">
        <div className="doc-view__panes">
          <div className="doc-view__source" ref={sourceContainer} hidden={Boolean(previewKind && previewMode === 'preview')}>
            <MonacoEditor
              filePath={doc.path}
              groupId={groupId}
              readOnly={doc.truncated}
              value={doc.content}
              onChange={(value) => setDocumentContent(doc.path, value)}
              reveal={editor.reveals[doc.path]}
            />
          </div>
          {previewKind && previewMode !== 'edit' ? <SourcePreview ref={previewRef}
            filePath={doc.path} content={doc.content} kind={previewKind} onScroll={onPreviewScroll} /> : null}
        </div>
        {outlineVisible ? <EditorOutline className="doc-view__outline" filePath={doc.path} groupId={groupId} /> : null}
      </div>
      <footer className="doc-view__status">
        <span>{doc.content.length.toLocaleString()} 字符</span>
        {/* 光标位置：VS Code 放在这里而不是全局状态栏 —— 它属于「这个文件」，
            标签一换就该跟着消失，用文档自身的订阅即可，不必让状态栏去猜 */}
        {cursor && cursor.filePath === doc.path && (!groupId || groupId === focusedGroupId) ? (
          <span data-testid="doc-cursor">
            行 {cursor.line}，列 {cursor.column}
          </span>
        ) : null}
        {isDirty(doc) ? <span className="doc-view__dirty">● 未保存</span> : <span>已保存</span>}
        {!doc.truncated ? <EditorBlameStatus filePath={doc.path} groupId={groupId} /> : null}
      </footer>
    </div>
  )
}
