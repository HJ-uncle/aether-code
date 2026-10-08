import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { fileIdentity } from '@renderer/core/editor/file-identity'
import { getDocument, isDirty, saveDocument, useEditor } from '@renderer/core/editor/editor-store'
import { openViewToRight, useEditorGroups } from '@renderer/core/editor/editor-groups'
import { isRemoteEngine } from '@renderer/core/engine/source'
import { browserAction, initializeBrowser } from '../browser/browser-store'
import { watchDocumentSymbols, type DocumentSymbolsSnapshot } from '@renderer/core/editor/document-symbols'
import { documentSymbolKey, documentSymbolKindLabel, findDocumentSymbolPath } from '@renderer/core/editor/document-symbol-utils'
import { openWorkspaceResource } from '@renderer/core/editor/monaco-workspace'
import { monaco } from '@renderer/core/editor/monaco-setup'
import { toast } from '@renderer/core/toast'
import { addFilesToChat } from '@renderer/contrib/chat/editor-context'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { EditorSettings } from './EditorSettings'
import { EditorPathPicker } from './EditorPathPicker'
import './editor-toolbar.css'

export function EditorToolbar({ filePath, groupId, children }: {
  filePath: string
  groupId?: string
  /** 预览、大纲等文档功能放在文件动作左边，保持窄窗下的操作顺序。 */
  children?: ReactNode
}): JSX.Element {
  const { root } = useWorkspace()
  const { cursor } = useEditor()
  const { focusedGroupId } = useEditorGroups()
  const [symbols, setSymbols] = useState<DocumentSymbolsSnapshot>({ status: 'loading', symbols: [] })
  const [pathPicker, setPathPicker] = useState<{ directory: string; anchor: DOMRect } | null>(null)
  useEffect(() => watchDocumentSymbols(filePath, setSymbols), [filePath])
  const symbolPath = cursor && (!groupId || groupId === focusedGroupId) && fileIdentity(cursor.filePath) === fileIdentity(filePath) && symbols.status === 'ready'
    ? findDocumentSymbolPath(symbols.symbols, { lineNumber: cursor.line, column: cursor.column })
    : []
  const normalizedPath = filePath.replace(/\\/g, '/')
  const normalizedRoot = root?.replace(/\\/g, '/').replace(/\/$/, '')
  const relativePath = normalizedRoot && fileIdentity(normalizedPath).startsWith(fileIdentity(normalizedRoot) + '/')
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath
  const segments = [...relativePath.matchAll(/[^/]+/g)].map((match, index, list) => {
    const end = normalizedPath.length - relativePath.length + (match.index ?? 0) + match[0].length
    let directory = index === list.length - 1 ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) : normalizedPath.slice(0, end)
    if (/^[a-z]:$/i.test(directory)) directory += '/'
    return { name: match[0], directory }
  })
  return (
    <div className="editor-toolbar">
      <nav className="editor-toolbar__path" aria-label="当前文件路径" title={filePath}>
        <ol>
          {segments.map((segment, index) => (
            <li key={`${index}:${segment.name}`} aria-current={index === segments.length - 1 ? 'page' : undefined}>
              {index > 0 ? <Icon name="chevron-right" size={12} /> : null}
              <button type="button" className="editor-toolbar__symbol" title={`浏览 ${segment.directory}`}
                onClick={(event) => setPathPicker({ directory: segment.directory, anchor: event.currentTarget.getBoundingClientRect() })}>{segment.name}</button>
            </li>
          ))}
          {symbolPath.map((symbol) => (
            <li key={documentSymbolKey(symbol)}>
              <Icon name="chevron-right" size={12} />
              <button type="button" className="editor-toolbar__symbol"
                title={`${symbol.name}（${documentSymbolKindLabel(symbol.kind)}）`}
                onClick={() => void openWorkspaceResource(monaco.Uri.file(filePath), symbol.selectionRange)
                  .catch(() => toast.error('无法定位符号，请稍后重试'))}>
                {symbol.name}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="editor-toolbar__actions">
        {children}
        {/\.html?$/i.test(filePath) && root && !isRemoteEngine() ? <button type="button" className="editor-toolbar__button" aria-label="保存并在浏览器中运行" title="保存并在右侧浏览器中运行 HTML"
          onClick={() => browserAction(async () => {
            const doc = getDocument(filePath)
            if (doc && isDirty(doc)) await saveDocument(filePath)
            await initializeBrowser()
            openViewToRight('browser')
            await window.aether.browser.openFile(filePath, root)
          })}><Icon name="play" size={14} /><span>运行</span></button> : null}
        <button type="button" className="editor-toolbar__button editor-toolbar__button--accent" aria-label="将当前文件添加到对话"
          title="将当前文件添加到对话" onClick={() => addFilesToChat([{ path: filePath, kind: 'file' }])}>
          <Icon name="chat" size={14} />
          <span>添加到对话</span>
        </button>
        <Popover label="编辑器设置" placement="down" align="end" width={320}
          trigger={({ open }) => (
            <button type="button" className={`editor-toolbar__button${open ? ' is-active' : ''}`}
              aria-label="编辑器设置" title="编辑器设置" aria-expanded={open} aria-haspopup="dialog">
              <Icon name="settings" size={15} />
            </button>
          )}>
          <EditorSettings />
        </Popover>
      </div>
      {pathPicker ? <EditorPathPicker key={pathPicker.directory} directory={pathPicker.directory}
        anchor={pathPicker.anchor} workspaceRoot={root} currentFile={filePath} onClose={() => setPathPicker(null)} /> : null}
    </div>
  )
}
