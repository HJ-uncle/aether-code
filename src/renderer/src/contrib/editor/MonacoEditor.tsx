import { useEffect, useRef, type JSX } from 'react'
import type * as Monaco from 'monaco-editor'
import {
  acquireModel,
  languageForPath,
  initializeModelContent,
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
  /** 首次读取期间保留宿主，但不得把新文档绑定到上一个文件的 model。 */
  loading?: boolean
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
let monacoCreateCount = 0
let monacoDisposeCount = 0
/** Monaco 的 change offset 都基于事件前的文本，必须从后往前应用。 */
export function applyModelContentChanges(previous: string, changes: readonly Monaco.editor.IModelContentChange[]): string {
  return [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset).reduce(
    (value, change) => value.slice(0, change.rangeOffset) + change.text + value.slice(change.rangeOffset + change.rangeLength),
    previous
  )
}

/**
 * Monaco 宿主
 *
 * 宿主可随视图卸载；文档模型和视图记忆独立保存，不从磁盘基线覆盖 draft。
 */
export function MonacoEditor({
  filePath,
  groupId = 'main',
  readOnly = false,
  loading = false,
  value,
  onChange,
  reveal
}: MonacoEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const gitCleanupRef = useRef<(() => void) | null>(null)
  const modelValuesRef = useRef(new WeakMap<Monaco.editor.ITextModel, string>())
  const readOnlyRef = useRef(readOnly)
  useEffect(() => { readOnlyRef.current = readOnly }, [readOnly])
  /** loading 期间 React 尚未换 model，事件必须继续归属当前旧文件。 */
  const acceptingInputRef = useRef(true)
  useEffect(() => { acceptingInputRef.current = !loading }, [loading])
  /** 当前 model 对应的文件路径；换 model 时用它把 viewState 存回正确的文件 */
  const currentPathRef = useRef<string | null>(null)
  /** setModel 同步触发 onDidChangeModel；事件用待切换路径认领新模型。 */
  const nextPathRef = useRef<string | null>(null)
  const pendingViewStateRef = useRef<{ path: string; state: unknown } | null>(null)
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

    container.dataset.monacoCreateCount = String(++monacoCreateCount)
    container.dataset.monacoDisposeCount = String(monacoDisposeCount)
    const displayOptions = getEditorDisplayOptions()
    const firstLoad = !peekModel(filePath)
    const initialValue = getDocument(filePath)?.content ?? ''
    const initialModel = acquireModel(filePath, languageForPath(filePath), initialValue)
    if (initialModel.getValue() !== initialValue) {
      if (firstLoad) initializeModelContent(initialModel, initialValue)
      else syncModelValue(initialModel, initialValue)
    }
    initialModel.updateOptions({ tabSize: displayOptions.tabSize })
    modelValuesRef.current.set(initialModel, initialModel.getValue())
    const editor = monaco.editor.create(container, {
      model: initialModel,
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
    currentPathRef.current = filePath

    // Monaco 撤销/自动闭合会先通知光标再通知内容；React 此时仍可能提交上次输入的 props。
    // 上报前先标记本地版本，不能把自己报告过的旧值当成外部编辑再推入撤销栈。
    const subscription = editor.onDidChangeModelContent((event) => {
      const path = currentPathRef.current
      const model = editor.getModel()
      if (!path || !model || !acceptingInputRef.current) return
      const previous = modelValuesRef.current.get(model)
      const content = previous === undefined ? model.getValue() : applyModelContentChanges(previous, event.changes)
      modelValuesRef.current.set(model, content)
      lastReportedModelValues.set(model, content)
      onChangeRef.current(content)
    })

    // 换 model 前把上一个文件的光标/滚动位置存下来。
    // 必须在 onDidChangeModel 里做：此时 getModel() 已被换成新的，
    // 拿不到旧 model，所以路径与 viewState 都靠 ref 兜住。
    const modelSubscription = editor.onDidChangeModel(() => {
      const previous = currentPathRef.current
      const pending = pendingViewStateRef.current
      if (previous) rememberGroupViewState(groupId, previous,
        pending?.path === previous ? pending.state : editor.saveViewState())
      currentPathRef.current = nextPathRef.current
      pendingViewStateRef.current = null
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
      // 二进制或固定视图会卸载宿主；普通文本切换只走 setModel，不经过这里。
      const path = currentPathRef.current
      if (path) rememberGroupViewState(groupId, path, editor.saveViewState())
      ++monacoDisposeCount
      container.dataset.monacoDisposeCount = String(monacoDisposeCount)
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
    if (!editor || !document || loading) return

    const firstLoad = !peekModel(filePath)
    const model = acquireModel(filePath, languageForPath(filePath), document.content)
    model.updateOptions({ tabSize: getEditorDisplayOptions().tabSize })
    if (model.getValue() !== document.content) {
      if (firstLoad) initializeModelContent(model, document.content)
      else syncModelValue(model, document.content)
    }
    modelValuesRef.current.set(model, model.getValue())
    if (editor.getModel() !== model) {
      decorationsRef.current?.clear()
      const previous = currentPathRef.current
      pendingViewStateRef.current = previous ? { path: previous, state: editor.saveViewState() } : null
      nextPathRef.current = filePath
      editor.setModel(model)
      nextPathRef.current = null
      currentPathRef.current = filePath
    }

    if (model.getValue() !== document.content) syncModelValue(model, document.content)
    editor.updateOptions({ readOnly: readOnlyRef.current })

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
  }, [filePath, groupId, loading])

  useEffect(() => { editorRef.current?.updateOptions({ readOnly }) }, [readOnly, filePath])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || readOnly || loading) return
    const dispose = registerSourceGitFeatures(editor, filePath)
    gitCleanupRef.current = dispose
    return () => {
      dispose()
      if (gitCleanupRef.current === dispose) gitCleanupRef.current = null
    }
  }, [filePath, groupId, readOnly, loading])

  // 只有仍与store一致且非自身回声的外部值可以同步；两栏共享模型时也不能让落后的一栏回灌旧稿。
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!model || currentPathRef.current !== filePath || getDocument(filePath)?.content !== value) return
    if (lastReportedModelValues.get(model) === value) return
    if (model.getValue() !== value) syncModelValue(model, value)
    else modelValuesRef.current.set(model, model.getValue())
  }, [value, filePath])

  // 跳行：revealLineInCenter 会自行收敛到合法范围，越界安全
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal || reveal.line < 1 || getEditorGroups().focusedGroupId !== groupId) return
    // Monaco 刚创建时还没有完成首次布局（automaticLayout 异步驱动），
    // 立即 reveal 会拿到错误的滚动位置停在某一行 —— 延后一拍并强制布局后再定位。
    // 不用 requestAnimationFrame：窗口被遮挡/未合成时 rAF 会停摆，setTimeout 始终可靠
    const timer = setTimeout(() => {
      if (currentPathRef.current !== filePath || editor.getModel()?.isDisposed()) return
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
  model.setEOL(value.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
  model.pushStackElement()
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null)
  model.pushStackElement()
}
