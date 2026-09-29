/**
 * Git 行内 diff 预览部件（移植自 wuzu-client GitInlineDiffWidget.vue）
 *
 * 渲染某个 hunk 的内联 diff（Monaco createDiffEditor，inline 模式），带头部操作
 * （打开差异/撤销/上一处/下一处/关闭）与底部拖拽调高。
 *
 * 【宿主说明 / 未挂载】
 * wuzu 侧由编辑器的 viewZone 提供宿主容器（target 为 viewZone 内 DOM 节点）。
 * aether 编辑器（contrib/editor/MonacoEditor.tsx）目前只持有私有 editorRef/
 * decorationsRef（搜索高亮用），全工程没有 viewZone / glyphMargin /
 * addContentWidget 调用，也没有对外暴露任何编辑器扩展挂载点。
 * 因此本组件逻辑完整移植并导出，但暂不挂载；待 MonacoEditor 暴露扩展点
 * （如 viewZone/gutter 注册接口）后接入。数据可用 core/git/git-store 的
 * hunksOf(path) / loadHunksFor(path)。
 */
import { useEffect, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { languageForPath, monaco } from '@renderer/core/editor/monaco-setup'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import type { GitHunk } from '@shared/git-types'
import { Icon } from '@renderer/workbench/icons'

export interface GitInlineDiffWidgetProps {
  visible: boolean
  /** 宿主容器（编辑器 viewZone 内的 DOM 节点）；暂无来源，见文件头说明 */
  target: HTMLElement | null
  path: string
  hunk: GitHunk | null
  /** 当前第几个更改（0 起） */
  index: number
  total: number
  contextBefore: { line: number; text: string }[]
  contextAfter: { line: number; text: string }[]
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  onRevert: () => void
  onOpenDiff: () => void
  /** 拖拽调高时回传新高度 */
  onResize: (height: number) => void
}

export function GitInlineDiffWidget(props: GitInlineDiffWidgetProps): JSX.Element | null {
  const {
    visible,
    target,
    path,
    hunk,
    index,
    total,
    contextBefore,
    contextAfter,
    onPrev,
    onNext,
    onClose,
    onRevert,
    onOpenDiff,
    onResize
  } = props

  const diffRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<ReturnType<typeof monaco.editor.createDiffEditor> | null>(null)
  const modelsRef = useRef<monaco.editor.ITextModel[]>([])
  const diffListenerRef = useRef<{ dispose: () => void } | null>(null)
  const revealPendingRef = useRef(false)
  const changedLineRef = useRef(1)
  const resizeCleanupRef = useRef<(() => void) | undefined>(undefined)

  const disposeEditor = (): void => {
    diffListenerRef.current?.dispose()
    diffListenerRef.current = null
    editorRef.current?.dispose()
    editorRef.current = null
    for (const model of modelsRef.current) model.dispose()
    modelsRef.current = []
  }

  // 主题跟随：aether 编辑器主题统一由 refreshEditorTheme 应用到所有实例
  useEffect(() => {
    // 组件本身不监听主题切换；接入挂载点后由全局 watchTheme 统一 refresh。
  }, [])

  // 渲染/更新 diff
  useEffect(() => {
    if (!visible) return
    const container = diffRef.current
    if (!container || !hunk) {
      disposeEditor()
      return
    }

    refreshEditorTheme()

    if (!editorRef.current) {
      const editor = monaco.editor.createDiffEditor(container, {
        theme: currentEditorThemeName(),
        automaticLayout: true,
        renderSideBySide: false,
        readOnly: true,
        originalEditable: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        folding: false,
        renderOverviewRuler: false,
        overviewRulerLanes: 0,
        stickyScroll: { enabled: false },
        renderIndicators: true,
        renderLineHighlight: 'none',
        contextmenu: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        hideUnchangedRegions: { enabled: false }
      })
      editorRef.current = editor
      diffListenerRef.current = editor.onDidUpdateDiff(() => {
        if (!revealPendingRef.current || !editorRef.current) return
        revealPendingRef.current = false
        const change = editorRef.current.getLineChanges()?.[0]
        editorRef.current.revealLineNearTop(
          Math.max(1, change?.modifiedStartLineNumber ?? changedLineRef.current)
        )
      })
    }
    const editor = editorRef.current

    const previous = modelsRef.current
    const before = contextBefore.map((line) => line.text)
    const after = contextAfter.map((line) => line.text)
    const language = languageForPath(path)
    modelsRef.current = [
      monaco.editor.createModel(
        [
          ...before,
          ...hunk.lines.filter((l) => l.type !== 'add').map((l) => l.content),
          ...after
        ].join('\n'),
        language
      ),
      monaco.editor.createModel(
        [
          ...before,
          ...hunk.lines.filter((l) => l.type !== 'delete').map((l) => l.content),
          ...after
        ].join('\n'),
        language
      )
    ]
    changedLineRef.current = before.length + 1
    revealPendingRef.current = true
    editor.setModel({ original: modelsRef.current[0], modified: modelsRef.current[1] })
    for (const model of previous) model.dispose()
    editor.getOriginalEditor().updateOptions({
      lineNumbers: (line: number) => String(Math.max(1, hunk.oldStart - before.length) + line - 1)
    })
    editor.getModifiedEditor().updateOptions({
      lineNumbers: (line: number) => String(Math.max(1, hunk.newStart - before.length) + line - 1)
    })
  }, [visible, target, hunk, path, contextBefore, contextAfter])

  // 卸载清理
  useEffect(
    () => () => {
      resizeCleanupRef.current?.()
      disposeEditor()
    },
    []
  )

  const startResize = (event: React.PointerEvent): void => {
    event.preventDefault()
    resizeCleanupRef.current?.()
    const initial = target?.clientHeight ?? 200
    const startY = event.clientY
    const move = (e: PointerEvent): void => onResize(initial + e.clientY - startY)
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      resizeCleanupRef.current = undefined
    }
    resizeCleanupRef.current = end
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  if (!target || !visible || !hunk) return null

  return createPortal(
    <div
      className="git-inlinediff"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
        if (event.key === 'F7') {
          event.stopPropagation()
          event.preventDefault()
          if (event.shiftKey) onPrev()
          else onNext()
        }
      }}
    >
      <div className="git-inlinediff__header">
        <span className="git-inlinediff__title" title={path}>
          {path.split(/[\\/]/).pop()}
        </span>
        <span className="git-inlinediff__detail">
          Git 本地更改 — 第 {index + 1} 个更改（共 {total} 个）
        </span>
        <button type="button" title="打开文件差异" onClick={onOpenDiff}>
          <Icon name="file" size={16} />
        </button>
        <button type="button" title="撤销这处更改（Ctrl+Z 可恢复）" onClick={onRevert}>
          <Icon name="restart" size={16} />
        </button>
        <button type="button" title="下一处更改（F7）" onClick={onNext}>
          <Icon name="chevron" size={16} />
        </button>
        <button type="button" title="上一处更改（Shift+F7）" onClick={onPrev}>
          <Icon name="chevron-up" size={16} />
        </button>
        <button type="button" title="关闭（Esc）" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div ref={diffRef} className="git-inlinediff__editor" />
      <div className="git-inlinediff__resize" title="拖动调整高度" onPointerDown={startResize} />
    </div>,
    target
  )
}
