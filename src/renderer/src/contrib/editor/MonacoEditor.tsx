import { useEffect, useRef, type JSX } from 'react'
import type * as Monaco from 'monaco-editor'
import {
  acquireModel,
  languageForPath,
  monaco,
  peekModel,
  setupMonacoEnvironment
} from '@renderer/core/editor/monaco-setup'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import { getDocument, setCursor } from '@renderer/core/editor/editor-store'
import { focusEditorGroup, getEditorGroups, rememberGroupViewState, takeGroupViewState } from '@renderer/core/editor/editor-groups'
import { registerActiveEditor } from '@renderer/core/editor/active-editor'
import {
  getEditorDisplayOptions,
  onEditorDisplayOptionsChanged,
  toMonacoEditorOptions
} from '@renderer/core/editor/editor-display-options'
import { watchTheme } from '@renderer/core/theme/palette'
import { registerSourceGitFeatures } from '@renderer/core/editor/source-git-features'
import { addFilesToChat, addSelectionToChat } from '@renderer/contrib/chat/editor-context'
import { registerEditorActionBridges } from './editor-commands'

interface MonacoEditorProps {
  filePath: string
  groupId?: string
  readOnly?: boolean
  value: string
  onChange: (value: string) => void
  /**
   * 跳行请求（全局搜索点击结果）：seq 变化即执行一次。
   * column/length 存在时选中并高亮匹配片段。
   */
  reveal?: { line: number; column?: number; length?: number; seq: number }
}

// 同一模型的两个宿主会先后收到内容事件；第一栏上报触发的React更新也必须让第二栏识别为回声。
const lastReportedModelValues = new WeakMap<Monaco.editor.ITextModel, string>()

/**
 * Monaco 宿主
 *
 * 宿主可随视图卸载；文档模型和视图记忆独立保存，不从磁盘基线覆盖 draft。
 */
export function MonacoEditor({
  filePath,
  groupId = 'main',
  readOnly = false,
  value,
  onChange,
  reveal
}: MonacoEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const gitCleanupRef = useRef<(() => void) | null>(null)
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

    const displayOptions = getEditorDisplayOptions()
    const editor = monaco.editor.create(container, {
      theme: currentEditorThemeName(),
      automaticLayout: true,
      readOnly,
      ...toMonacoEditorOptions(displayOptions),
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      fixedOverflowWidgets: true
    })
    editorRef.current = editor
    const unregisterActiveEditor = registerActiveEditor(editor, groupId)
    const groupFocusSubscription = editor.onDidFocusEditorText(() => {
      focusEditorGroup(groupId)
      const path = currentPathRef.current
      const position = editor.getPosition()
      if (path && position) setCursor(path, position.lineNumber, position.column)
    })
    const unregisterActionBridges = registerEditorActionBridges(editor)
    const unsubscribeDisplayOptions = onEditorDisplayOptionsChanged((options) => {
      editor.updateOptions(toMonacoEditorOptions(options))
      editor.getModel()?.updateOptions({ tabSize: options.tabSize })
    })
    /** 当前 model 对应的文件路径：换 model 时靠它把 viewState 存回上一个文件 */
    currentPathRef.current = null

    // Monaco 撤销/自动闭合会先通知光标再通知内容；React 此时仍可能提交上次输入的 props。
    // 上报前先标记本地版本，不能把自己报告过的旧值当成外部编辑再推入撤销栈。
    const subscription = editor.onDidChangeModelContent(() => {
      const path = currentPathRef.current
      const model = editor.getModel()
      if (!path || !model) return
      const content = editor.getValue()
      lastReportedModelValues.set(model, content)
      onChangeRef.current(content)
    })

    // 换 model 前把上一个文件的光标/滚动位置存下来。
    // 必须在 onDidChangeModel 里做：此时 getModel() 已被换成新的，
    // 拿不到旧 model，所以路径与 viewState 都靠 ref 兜住。
    const modelSubscription = editor.onDidChangeModel(() => {
      const previous = currentPathRef.current
      if (previous) rememberGroupViewState(groupId, previous, editor.saveViewState())
      currentPathRef.current = null
    })

    // 光标位置 → 状态栏；Monaco 不报列号，需要单独订阅并自行取位置
    const cursorSubscription = editor.onDidChangeCursorPosition((event) => {
      const path = currentPathRef.current
      if (path && getEditorGroups().focusedGroupId === groupId) setCursor(path, event.position.lineNumber, event.position.column)
    })

    // 添加时捕获缓冲区，避免未保存选区到了对话里变成旧磁盘内容。
    const addToChatAction = editor.addAction({
      id: 'aether.addSelectionToChat',
      label: '添加到对话',
      precondition: 'editorHasSelection',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: (instance) => { addSelectionToChat(instance) }
    })
    const addFileToChatAction = editor.addAction({
      id: 'aether.addFileToChat', label: '将当前文件添加到对话',
      contextMenuGroupId: 'navigation', contextMenuOrder: 1.1,
      run: () => {
        const path = currentPathRef.current
        if (path) addFilesToChat([{ path, kind: 'file' }])
      }
    })

    return () => {
      gitCleanupRef.current?.()
      gitCleanupRef.current = null
      unregisterActiveEditor()
      groupFocusSubscription.dispose()
      unregisterActionBridges()
      unsubscribeDisplayOptions()
      subscription.dispose()
      modelSubscription.dispose()
      cursorSubscription.dispose()
      addToChatAction?.dispose()
      addFileToChatAction.dispose()
      // 卸载前把当前文件的光标/滚动位置存下来。
      // 必须在这里做：DocumentSlot 以 filePath 为 key，切标签是**整体卸载重建**
      // （不是换 model），onDidChangeModel 不会触发，实例一销毁状态就没了 ——
      // 于是切回来时光标被重置到第 1 行。saveViewState 必须在 dispose 之前调用。
      const path = currentPathRef.current
      if (path) rememberGroupViewState(groupId, path, editor.saveViewState())
      editor.dispose()
      editorRef.current = null
    }
  }, [groupId])

  // 外观/强调色变化（含 'system' 模式的系统切换）→ 重新注册主题并应用到全部编辑器
  useEffect(() => watchTheme(refreshEditorTheme), [])

  // 切换文件只读取当前文档快照；另一栏可能已编辑，渲染时捕获的 value 不一定仍然有效。
  useEffect(() => {
    const editor = editorRef.current
    const document = getDocument(filePath)
    if (!editor || !document || document.loading) return

    const firstLoad = !peekModel(filePath)
    const model = acquireModel(filePath, languageForPath(filePath))
    model.updateOptions({ tabSize: getEditorDisplayOptions().tabSize })
    if (editor.getModel() !== model) {
      // 先存旧文件的视图状态（onDidChangeModel 的监听也做了一次，幂等），
      // 再换 model —— 顺序反了会存成新 model 的状态
      const previous = currentPathRef.current
      if (previous && previous !== filePath) {
        rememberGroupViewState(groupId, previous, editor.saveViewState())
      }
      editor.setModel(model)
      currentPathRef.current = filePath
    }

    if (model.getValue() !== document.content) {
      if (firstLoad) model.setValue(document.content)
      else syncModelValue(model, document.content)
    }

    // 恢复该文件上次的光标与滚动位置；没有记录（首次打开）时保持 Monaco 默认
    const saved = takeGroupViewState(groupId, filePath)
    if (saved) {
      editor.restoreViewState(saved as Monaco.editor.ICodeEditorViewState)
      // 立刻启动延迟布局：Monaco 恢复 viewState 需在容器有尺寸后才生效，
      // 首次打开（编辑器刚创建、automaticLayout 未跑完）尤其容易丢滚动位置
      editor.layout()
    }

    if (getEditorGroups().focusedGroupId === groupId) {
      editor.focus()
      const position = editor.getPosition()
      setCursor(filePath, position?.lineNumber ?? 1, position?.column ?? 1)
    }
  }, [filePath, groupId])

  useEffect(() => { editorRef.current?.updateOptions({ readOnly }) }, [readOnly])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || readOnly) return
    const dispose = registerSourceGitFeatures(editor, filePath)
    gitCleanupRef.current = dispose
    return () => {
      dispose()
      if (gitCleanupRef.current === dispose) gitCleanupRef.current = null
    }
  }, [filePath, groupId, readOnly])

  // 只有仍与store一致且非自身回声的外部值可以同步；两栏共享模型时也不能让落后的一栏回灌旧稿。
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!model || currentPathRef.current !== filePath || getDocument(filePath)?.content !== value) return
    if (lastReportedModelValues.get(model) === value) return
    if (model.getValue() !== value) syncModelValue(model, value)
  }, [value, filePath])

  // 跳行：revealLineInCenter 会自行收敛到合法范围，越界安全
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal || reveal.line < 1 || getEditorGroups().focusedGroupId !== groupId) return
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
  }, [reveal, groupId])

  return <div className="monaco-host" ref={containerRef} />
}

/** 同步外部版本也是可撤销的编辑；两组共享模型，第二个宿主值相同时自然跳过。 */
function syncModelValue(model: Monaco.editor.ITextModel, value: string): void {
  if (model.getValue() === value) return
  model.pushStackElement()
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null)
  model.pushStackElement()
}
