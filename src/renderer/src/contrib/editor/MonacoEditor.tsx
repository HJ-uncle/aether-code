import { useEffect, useRef, type JSX } from 'react'
import type * as Monaco from 'monaco-editor'
import {
  acquireModel,
  languageForPath,
  monaco,
  setupMonacoEnvironment
} from '@renderer/core/editor/monaco-setup'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import { rememberViewState, setCursor, takeViewState } from '@renderer/core/editor/editor-store'
import { watchTheme } from '@renderer/core/theme/palette'
import { getWorkspaceState } from '@renderer/core/workspace/workspace-store'
import { paths } from '@renderer/core/workspace/fs-client'
import { pushPendingMention } from '@renderer/contrib/chat/pending-mentions'

interface MonacoEditorProps {
  filePath: string
  value: string
  onChange: (value: string) => void
  /**
   * 跳行请求（全局搜索点击结果）：seq 变化即执行一次。
   * column/length 存在时选中并高亮匹配片段。
   */
  reveal?: { line: number; column?: number; length?: number; seq: number }
}

/**
 * Monaco 宿主
 *
 * 编辑器实例只创建一次，切换文件时替换 model —— 不重建实例，
 * 因此标签切换没有闪烁与状态丢失。
 */
export function MonacoEditor({
  filePath,
  value,
  onChange,
  reveal
}: MonacoEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  /** 当前 model 对应的文件路径；换 model 时用它把 viewState 存回正确的文件 */
  const currentPathRef = useRef<string | null>(null)
  /** 用 ref 持有回调，避免因 onChange 变化而重建编辑器 */
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    // 渲染后同步最新回调；编辑器实例只在创建时捕获一次 ref
    onChangeRef.current = onChange
  }, [onChange])

  // 创建编辑器（仅一次）。主题先于实例注册：create 的 theme 参数必须是已定义的名字
  useEffect(() => {
    setupMonacoEnvironment()
    refreshEditorTheme()
    const container = containerRef.current
    if (!container) return

    const editor = monaco.editor.create(container, {
      theme: currentEditorThemeName(),
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
      minimap: { enabled: true, maxColumn: 80 },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      fixedOverflowWidgets: true
    })
    editorRef.current = editor
    /** 当前 model 对应的文件路径：换 model 时靠它把 viewState 存回上一个文件 */
    currentPathRef.current = null

    // 用户输入 → 上报；外部值变化不走这里，避免形成回环
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue())
    })

    // 换 model 前把上一个文件的光标/滚动位置存下来。
    // 必须在 onDidChangeModel 里做：此时 getModel() 已被换成新的，
    // 拿不到旧 model，所以路径与 viewState 都靠 ref 兜住。
    const modelSubscription = editor.onDidChangeModel(() => {
      const previous = currentPathRef.current
      if (previous) rememberViewState(previous, editor.saveViewState())
      currentPathRef.current = null
    })

    // 光标位置 → 状态栏；Monaco 不报列号，需要单独订阅并自行取位置
    const cursorSubscription = editor.onDidChangeCursorPosition((event) => {
      const path = currentPathRef.current
      if (path) setCursor(path, event.position.lineNumber, event.position.column)
    })

    // 「添加到对话」右键动作：把当前选区作为 code 引用入队给聊天输入框。
    // 对齐 wuzu-client pushCodeRef：只传路径与行号不传原文（AI 自己会读文件）。
    // addAction 由 Monaco 接管右键菜单的渲染/定位/键盘，优于自建 ContextMenu。
    const addToChatAction = editor.addAction({
      id: 'aether.addSelectionToChat',
      label: '添加到对话',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: (instance) => {
        const selection = instance.getSelection()
        const path = currentPathRef.current
        if (!selection || !path || selection.isEmpty()) return
        const root = getWorkspaceState().root
        const relative =
          root && path.replace(/\\/g, '/').startsWith(root.replace(/\\/g, '/') + '/')
            ? path.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length + 1)
            : path
        const base = paths.basename(relative)
        pushPendingMention({
          displayText: `${base}:${selection.startLineNumber}-${selection.endLineNumber}`,
          source: 'code',
          path: relative,
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber
        })
      }
    })

    return () => {
      subscription.dispose()
      modelSubscription.dispose()
      cursorSubscription.dispose()
      addToChatAction?.dispose()
      // 卸载前把当前文件的光标/滚动位置存下来。
      // 必须在这里做：DocumentSlot 以 filePath 为 key，切标签是**整体卸载重建**
      // （不是换 model），onDidChangeModel 不会触发，实例一销毁状态就没了 ——
      // 于是切回来时光标被重置到第 1 行。saveViewState 必须在 dispose 之前调用。
      const path = currentPathRef.current
      if (path) rememberViewState(path, editor.saveViewState())
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  // 外观/强调色变化（含 'system' 模式的系统切换）→ 重新注册主题并应用到全部编辑器
  useEffect(() => watchTheme(refreshEditorTheme), [])

  // 切换文件：换 model，并把磁盘内容灌进去（仅在 model 为空或与磁盘不一致时）
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const model = acquireModel(filePath, languageForPath(filePath))
    if (editor.getModel() !== model) {
      // 先存旧文件的视图状态（onDidChangeModel 的监听也做了一次，幂等），
      // 再换 model —— 顺序反了会存成新 model 的状态
      const previous = currentPathRef.current
      if (previous && previous !== filePath) {
        rememberViewState(previous, editor.saveViewState())
      }
      editor.setModel(model)
      currentPathRef.current = filePath
    }

    if (model.getValue() !== value) {
      // 用 pushEditOperations 之外的最简做法；此处仅发生在「打开文件」或
      // 「外部刷新」时，保留撤销栈不是关键，用 setValue 保证内容正确
      model.setValue(value)
    }

    // 恢复该文件上次的光标与滚动位置；没有记录（首次打开）时保持 Monaco 默认
    const saved = takeViewState(filePath)
    if (saved) {
      editor.restoreViewState(saved as Monaco.editor.ICodeEditorViewState)
      // 立刻启动延迟布局：Monaco 恢复 viewState 需在容器有尺寸后才生效，
      // 首次打开（编辑器刚创建、automaticLayout 未跑完）尤其容易丢滚动位置
      editor.layout()
    }

    editor.focus()
    const position = editor.getPosition()
    setCursor(filePath, position?.lineNumber ?? 1, position?.column ?? 1)
    // value 只在 filePath 变化时需要对齐；后续变化由用户输入驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath])

  // 外部内容变化（例如脏数据回滚）时同步
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!model) return
    if (model.getValue() !== value) model.setValue(value)
  }, [value])

  // 跳行：revealLineInCenter 会自行收敛到合法范围，越界安全
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal || reveal.line < 1) return
    // Monaco 刚创建时还没有完成首次布局（automaticLayout 异步驱动），
    // 立即 reveal 会拿到错误的滚动位置停在某一行 —— 延后一拍并强制布局后再定位。
    // 不用 requestAnimationFrame：窗口被遮挡/未合成时 rAF 会停摆，setTimeout 始终可靠
    const timer = setTimeout(() => {
      editor.layout()
      const column = reveal.column && reveal.column >= 1 ? reveal.column : 1
      const length = reveal.length && reveal.length > 0 ? reveal.length : 1
      const range: Monaco.IRange = {
        startLineNumber: reveal.line,
        endLineNumber: reveal.line,
        startColumn: column,
        endColumn: column + length
      }
      editor.setSelection(range)
      if (!decorationsRef.current) {
        decorationsRef.current = editor.createDecorationsCollection([])
      }
      // 匹配片段高亮保持到下一次跳转（与 VS Code 搜索结果点击一致）
      decorationsRef.current.set([
        { range, options: { className: 'aether-reveal-match', zIndex: 1 } }
      ])
      editor.revealRangeInCenter(range)
      editor.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [reveal])

  return <div className="monaco-host" ref={containerRef} />
}
