import { useEffect, useRef, type JSX } from 'react'
import type { editor } from 'monaco-editor'
import { languageForPath, monaco, setupMonacoEnvironment } from '@renderer/core/editor/monaco-setup'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import { getEditorDisplayOptions, onEditorDisplayOptionsChanged, toMonacoEditorOptions } from '@renderer/core/editor/editor-display-options'
import { watchTheme } from '@renderer/core/theme/palette'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import type { Mention, MentionOrigin } from '../chat/mention-context'
import { workCodeReference } from './work-code-reference'
import './work-code-preview.css'

/** Work owns a temporary read-only model. It must never register with Code's
 * active editor/store or acquire the local workspace model for a remote path. */
export function WorkCodePreview({ content, name, path, origin = 'workspace', reveal, active = true, onAddToConversation, onSelectionChange }: {
  content: string
  name: string
  path: string
  origin?: MentionOrigin
  reveal?: TextPreviewReveal
  active?: boolean
  onAddToConversation?: (reference?: Mention) => void
  onSelectionChange?: (references: Mention[]) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const referenceEnabled = useRef<monaco.editor.IContextKey<boolean> | null>(null)
  const latest = useRef({ content, name, path, origin, active, onAddToConversation, onSelectionChange })
  latest.current = { content, name, path, origin, active, onAddToConversation, onSelectionChange }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setupMonacoEnvironment()
    refreshEditorTheme()
    const current = latest.current
    const model = monaco.editor.createModel(current.content, languageForPath(current.name),
      monaco.Uri.from({ scheme: 'aether-work-preview', authority: crypto.randomUUID(), path: `/${current.name}` }))
    model.updateOptions({ tabSize: getEditorDisplayOptions().tabSize })
    const instance = monaco.editor.create(container, {
      ...toMonacoEditorOptions(), model, theme: currentEditorThemeName(),
      readOnly: true, domReadOnly: true, automaticLayout: true, contextmenu: true,
      ariaLabel: `${current.name} 代码预览`, minimap: { enabled: false },
      scrollBeyondLastLine: false, fixedOverflowWidgets: true,
      renderWhitespace: 'selection', padding: { top: 8, bottom: 8 }
    })
    instanceRef.current = instance
    const enabled = instance.createContextKey('aetherWorkCanReference', Boolean(current.active && current.onAddToConversation))
    referenceEnabled.current = enabled
    const selectedReferences = (): Mention[] => {
      const value = latest.current
      if (!value.active) return []
      return (instance.getSelections() ?? []).filter(selection => !selection.isEmpty())
        .map(selection => workCodeReference(model, selection, value.path, value.origin))
    }
    const selection = instance.onDidChangeCursorSelection(() => latest.current.onSelectionChange?.(selectedReferences()))
    const actions = [
      instance.addAction({
        id: 'aether.work.addSelectionToChat', label: '添加选区到对话',
        precondition: 'aetherWorkCanReference && editorHasSelection',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
        contextMenuGroupId: 'navigation', contextMenuOrder: 1,
        run: () => {
          if (!latest.current.active) return
          for (const reference of selectedReferences()) latest.current.onAddToConversation?.(reference)
        }
      }),
      instance.addAction({
        id: 'aether.work.addFileToChat', label: '添加到对话',
        precondition: 'aetherWorkCanReference', contextMenuGroupId: 'navigation', contextMenuOrder: 1.1,
        run: () => { if (latest.current.active) latest.current.onAddToConversation?.() }
      }),
      instance.addAction({
        id: 'aether.work.find', label: '查找', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 4,
        run: target => target.getAction('actions.find')?.run()
      }),
      instance.addAction({
        id: 'aether.work.selectAll', label: '全选', contextMenuGroupId: '9_cutcopypaste', contextMenuOrder: 5,
        run: target => { target.focus(); target.setSelection(model.getFullModelRange()) }
      })
    ]
    const unwatchTheme = watchTheme(refreshEditorTheme)
    const unwatchOptions = onEditorDisplayOptionsChanged(options => {
      instance.updateOptions({ ...toMonacoEditorOptions(options), minimap: { enabled: false } })
      model.updateOptions({ tabSize: options.tabSize })
    })
    return () => {
      actions.forEach(action => action.dispose())
      selection.dispose(); enabled.reset(); unwatchTheme(); unwatchOptions()
      referenceEnabled.current = null; instanceRef.current = null
      instance.dispose(); model.dispose()
    }
  }, [])

  useEffect(() => {
    const model = instanceRef.current?.getModel()
    if (!model) return
    if (model.getValue() !== content) { model.setValue(content); latest.current.onSelectionChange?.([]) }
    const language = languageForPath(name)
    if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
  }, [content, name])
  useEffect(() => {
    referenceEnabled.current?.set(Boolean(active && onAddToConversation))
    if (active) instanceRef.current?.layout()
  }, [active, onAddToConversation])
  useEffect(() => {
    const instance = instanceRef.current, model = instance?.getModel()
    if (!active || !instance || !model || !reveal || !Number.isFinite(reveal.line)) return
    const start = model.validatePosition({ lineNumber: Math.max(1, Math.floor(reveal.line)), column: Math.max(1, Math.floor(reveal.column ?? 1)) })
    const end = model.getPositionAt(model.getOffsetAt(start) + Math.max(0, Math.floor(reveal.length ?? 0)))
    const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
    instance.setSelection(range)
    instance.revealRangeInCenter(range, monaco.editor.ScrollType.Immediate)
  }, [active, content, reveal?.revision])
  return <div ref={containerRef} className="work-code-preview" role="region" aria-label={`${name} 代码预览`} />
}
