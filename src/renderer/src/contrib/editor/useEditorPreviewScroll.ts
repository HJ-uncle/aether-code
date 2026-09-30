import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { monaco } from '@renderer/core/editor/monaco-setup'
import type { SourcePreviewHandle } from './SourcePreview'

/** The DOM owner distinguishes two editor groups showing the same shared model. */
export function useEditorPreviewScroll(
  sourceContainer: RefObject<HTMLDivElement | null>,
  preview: RefObject<SourcePreviewHandle | null>,
  enabled: boolean,
  filePath: string
): (ratio: number) => void {
  const instance = useRef<monaco.editor.ICodeEditor | null>(null)
  const expectedScrollTop = useRef<number | null>(null)
  useEffect(() => {
    if (!enabled) return
    let scroll: monaco.IDisposable | undefined
    let layout: monaco.IDisposable | undefined
    const sync = (): void => {
      const editor = instance.current
      if (!editor) return
      const echo = expectedScrollTop.current !== null && Math.abs(editor.getScrollTop() - expectedScrollTop.current) <= 2
      expectedScrollTop.current = null
      if (echo) return
      const maximum = Math.max(0, editor.getScrollHeight() - editor.getLayoutInfo().height)
      preview.current?.scrollToRatio(maximum ? editor.getScrollTop() / maximum : 0)
    }
    const bind = (): void => {
      const found = monaco.editor.getEditors().find((editor) => {
        const node = editor.getDomNode()
        return node && sourceContainer.current?.contains(node)
      }) ?? null
      if (found === instance.current) return
      scroll?.dispose()
      layout?.dispose()
      instance.current = found
      scroll = found?.onDidScrollChange(sync)
      layout = found?.onDidLayoutChange(sync)
      sync()
    }
    const creation = monaco.editor.onDidCreateEditor(() => queueMicrotask(bind))
    bind()
    return () => {
      creation.dispose()
      scroll?.dispose()
      layout?.dispose()
      instance.current = null
    }
  }, [sourceContainer, preview, enabled, filePath])
  return useCallback((ratio: number) => {
    const editor = instance.current
    if (!enabled || !editor) return
    const maximum = Math.max(0, editor.getScrollHeight() - editor.getLayoutInfo().height)
    expectedScrollTop.current = Math.max(0, Math.min(1, ratio)) * maximum
    editor.setScrollTop(expectedScrollTop.current, monaco.editor.ScrollType.Immediate)
  }, [enabled])
}
