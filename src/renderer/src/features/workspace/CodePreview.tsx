import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import type { editor } from 'monaco-editor'
import { languageForPath, monaco, setupMonacoEnvironment } from '@renderer/core/editor/monaco-setup'
import { currentEditorThemeName, refreshEditorTheme } from '@renderer/core/editor/editor-theme'
import { getEditorDisplayOptions, onEditorDisplayOptionsChanged, toMonacoEditorOptions } from '@renderer/core/editor/editor-display-options'
import { watchTheme } from '@renderer/core/theme/palette'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import type { Mention, MentionOrigin } from '../conversation/shared/mention-context'
import { sessionCodeReference } from './code-reference'
import { publishExtensionEvent, registerExtensionTarget, useExtensionEditorDecorations, useExtensionMenuItems } from '../extensions'
import { isEngineReady } from '@renderer/core/engine/source'
import { extensionIcon } from '@renderer/app/navigation'
import { Icon } from '@renderer/ui/icons'
import './code-preview.css'

/** A preview owns a temporary read-only model; remote paths never acquire a
 * writable local workspace model. Plugin actions use that same scoped preview. */
export function CodePreview({ content, name, path, sessionId, workspacePath, origin = 'workspace', reveal, active = true, onAddToConversation, onSelectionChange }: {
  content: string
  name: string
  path: string
  sessionId?: string | null
  workspacePath?: string | null
  origin?: MentionOrigin
  reveal?: TextPreviewReveal
  active?: boolean
  onAddToConversation?: (reference?: Mention) => void
  onSelectionChange?: (references: Mention[]) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const targetId = useId()
  const [selectionText, setSelectionText] = useState('')
  const extensionContext = useMemo(() => ({ sessionId, workspacePath, filePath: path, selectionText, engineReady: active && isEngineReady(), targetId: `editor:${targetId}` }), [sessionId, workspacePath, path, selectionText, active, targetId])
  const pluginMenu = useExtensionMenuItems('editor.context', extensionContext)
  const pluginToolbar = useExtensionMenuItems('editor.toolbar', extensionContext)
  const decorations = useExtensionEditorDecorations(extensionContext)
  const extensionLive = useRef({ context: extensionContext, menu: pluginMenu })
  extensionLive.current = { context: extensionContext, menu: pluginMenu }
  const pluginMenuContext = useRef<typeof extensionContext | null>(null)
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
    const capturePluginMenu = (): void => {
      const selected = instance.getSelection()
      pluginMenuContext.current = { ...extensionLive.current.context, selectionText: selected ? model.getValueInRange(selected).slice(0, 8000) : '' }
    }
    let keyboardMenu = false
    // Menu focus may collapse Monaco's selection. Pin the actual model text
    // before keyboard opening; right-click captures after Monaco positions it.
    const menuKey = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
        keyboardMenu = true; capturePluginMenu()
      } else { keyboardMenu = false; pluginMenuContext.current = null }
    }
    const menuPointer = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
      keyboardMenu = false; pluginMenuContext.current = null
    }
    container.addEventListener('keydown', menuKey, true)
    container.addEventListener('pointerdown', menuPointer, true)
    const menuOpening = instance.onContextMenu(() => { if (!keyboardMenu) capturePluginMenu() })
    const enabled = instance.createContextKey('aetherWorkCanReference', Boolean(current.active && current.onAddToConversation))
    referenceEnabled.current = enabled
    const selectedReferences = (): Mention[] => {
      const value = latest.current
      if (!value.active) return []
      return (instance.getSelections() ?? []).filter(selection => !selection.isEmpty())
        .map(selection => sessionCodeReference(model, selection, value.path, value.origin))
    }
    let selectionTimer: ReturnType<typeof setTimeout> | undefined
    const selection = instance.onDidChangeCursorSelection(() => {
      latest.current.onSelectionChange?.(selectedReferences())
      const range = instance.getSelection(), text = range ? model.getValueInRange(range) : ''
      setSelectionText(text.slice(0, 8000))
      clearTimeout(selectionTimer)
      if (latest.current.active && extensionLive.current.context.sessionId) selectionTimer = setTimeout(() => {
        if (latest.current.active) publishExtensionEvent('editor.selectionChanged', { ...extensionLive.current.context, selectionText: text.slice(0, 4000) }, { range, truncated: text.length > 4000 })
      }, 150)
    })
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
      container.removeEventListener('keydown', menuKey, true); container.removeEventListener('pointerdown', menuPointer, true)
      menuOpening.dispose(); pluginMenuContext.current = null
      clearTimeout(selectionTimer)
      selection.dispose(); enabled.reset(); unwatchTheme(); unwatchOptions()
      referenceEnabled.current = null; instanceRef.current = null
      instance.dispose(); model.dispose()
    }
  }, [])

  useEffect(() => {
    const instance = instanceRef.current
    if (!instance || !active) return
    return registerExtensionTarget('editor', extensionContext, (action, args) => {
      const model = instance.getModel(), selection = instance.getSelection()
      if (!model) throw new Error('编辑器已关闭。')
      if (action === 'get' || action === 'editor.get') return { path, content: model.getValue(), selectionText: selection ? model.getValueInRange(selection) : '', range: selection, readOnly: true }
      if (action === 'replaceSelection' || action === 'editor.replaceSelection') throw new Error('当前是只读文件预览，不能替换选区；请使用工作区文件接口修改文件。')
      if (action !== 'reveal' && action !== 'editor.reveal') throw new Error('编辑器不支持此操作。')
      const line = Number(args.line ?? args.startLineNumber), column = Number(args.column ?? args.startColumn ?? 1)
      if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) throw new Error('请提供有效的行号和列号。')
      const position = model.validatePosition({ lineNumber: Math.floor(line), column: Math.floor(column) })
      instance.setPosition(position); instance.revealPositionInCenter(position); instance.focus()
      return { revealed: true, ...position }
    })
  }, [active, extensionContext, path])
  const menuSignature = JSON.stringify(pluginMenu.map(item => [item.id, item.label, item.disabled]))
  useEffect(() => {
    const instance = instanceRef.current
    if (!instance || !active) return
    const registered = extensionLive.current.menu.filter(item => !item.disabled).map((item, index) => instance.addAction({
      id: `aether.plugin.${item.id}`, label: item.label, contextMenuGroupId: '8_plugins', contextMenuOrder: index,
      run: () => {
        const current = extensionLive.current, selected = instance.getSelection(), model = instance.getModel()
        const captured = pluginMenuContext.current
        pluginMenuContext.current = null
        if (!latest.current.active) return
        const action = current.menu.find(value => value.id === item.id && !value.disabled)
        const context = captured && captured.targetId === current.context.targetId && captured.sessionId === current.context.sessionId && captured.filePath === current.context.filePath
          ? captured : { ...current.context, selectionText: model && selected ? model.getValueInRange(selected).slice(0, 8000) : '' }
        action?.onSelectWithContext?.(context)
      }
    }))
    return () => registered.forEach(item => item.dispose())
  }, [active, menuSignature])
  useEffect(() => {
    const model = instanceRef.current?.getModel()
    if (!model) return
    if (model.getValue() !== content) { model.setValue(content); latest.current.onSelectionChange?.([]) }
    const language = languageForPath(name)
    if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
  }, [content, name])
  useEffect(() => {
    const instance = instanceRef.current, model = instance?.getModel()
    if (!instance || !model || !active) return
    const ranges: editor.IModelDeltaDecoration[] = []
    for (const decoration of decorations) {
      if (!decoration.pattern || decoration.pattern.length > 2000) continue
      for (const match of model.findMatches(decoration.pattern, false, false, false, null, false, 100)) {
        ranges.push({ range: match.range, options: { inlineClassName: `work-code-plugin-mark work-code-plugin-mark--${decoration.severity === 'error' ? 'error' : decoration.severity === 'warning' ? 'warning' : 'info'}`,
          hoverMessage: { value: (decoration.tooltip ?? decoration.text).replace(/[\\`*_{}[\]()#+.!<>]/g, '\\$&'), isTrusted: false, supportHtml: false } } })
      }
    }
    const collection = instance.createDecorationsCollection(ranges)
    return () => collection.clear()
  }, [active, content, decorations])

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
  return <div className="work-code-preview" role="region" aria-label={`${name} 代码预览`}>
    {active && pluginToolbar.length ? <div className="work-code-preview__plugin-toolbar" role="toolbar" aria-label="编辑器插件操作">{pluginToolbar.map(item => <button key={item.id} type="button" className="btn btn--icon btn--ghost" aria-label={item.label} title={item.label} disabled={item.disabled} onClick={item.onSelect}><Icon name={extensionIcon(item.icon ?? 'puzzle')} size={15} /></button>)}</div> : null}
    <div ref={containerRef} className="work-code-preview__editor" />
    {active && decorations.length ? <div className="work-code-preview__plugin-status" aria-label="编辑器插件提示">{decorations.map(item => <span key={item.id} title={item.tooltip} data-severity={item.severity}>{item.text}</span>)}</div> : null}
  </div>
}
