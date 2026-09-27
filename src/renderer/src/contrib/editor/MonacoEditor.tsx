import { useEffect, useRef, type JSX } from 'react'
import type * as Monaco from 'monaco-editor'
import {
  acquireModel,
  languageForPath,
  monaco,
  setupMonacoEnvironment
} from '@renderer/core/editor/monaco-setup'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import { watchTheme } from '@renderer/core/theme/palette'

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

    // 用户输入 → 上报；外部值变化不走这里，避免形成回环
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue())
    })

    return () => {
      subscription.dispose()
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
    if (editor.getModel() !== model) editor.setModel(model)

    if (model.getValue() !== value) {
      // 用 pushEditOperations 之外的最简做法；此处仅发生在「打开文件」或
      // 「外部刷新」时，保留撤销栈不是关键，用 setValue 保证内容正确
      model.setValue(value)
    }
    editor.focus()
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
