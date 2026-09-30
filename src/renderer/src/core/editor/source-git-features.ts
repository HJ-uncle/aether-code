import type { editor, IDisposable } from 'monaco-editor'
import type { GitBlameLine } from '@shared/git-types'
import { monaco } from './monaco-setup'
import { fileIdentity } from './file-identity'
import { gitBlame, gitHeadFile, gitShowCommitFile } from '../git/git-client'
import { getGitState, onGitChanged } from '../git/git-store'
import { findConflictAtLine, nextConflict, resolveConflictText, scanConflicts, type DocumentMergeConflict } from '../git/git-conflict-parser'
import { hunkLine, minimalReplacement, revertLineChange, type BufferReplacement } from '../git/source-git-utils'
import { getWorkspaceState } from '../workspace/workspace-store'
import { toast } from '../toast'
import { cssColor, watchTheme } from '../theme/palette'
import './source-git-features.css'

export interface SourceGitSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  version: number
  changes: readonly editor.ILineChange[]
  blame: readonly GitBlameLine[]
}
const EMPTY: SourceGitSnapshot = { status: 'unavailable', version: 0, changes: [], blame: [] }
const snapshots = new Map<string, SourceGitSnapshot>()
const listeners = new Map<string, Set<(snapshot: SourceGitSnapshot) => void>>()
const owners = new Map<string, number>()

export function watchSourceGit(filePath: string, listener: (snapshot: SourceGitSnapshot) => void): () => void {
  const key = fileIdentity(filePath)
  let bucket = listeners.get(key)
  if (!bucket) { bucket = new Set(); listeners.set(key, bucket) }
  bucket.add(listener)
  listener(snapshots.get(key) ?? EMPTY)
  return () => { bucket.delete(listener); if (!bucket.size) listeners.delete(key) }
}

function publish(key: string, snapshot: SourceGitSnapshot): void {
  snapshots.set(key, snapshot)
  for (const listener of listeners.get(key) ?? []) listener(snapshot)
}

function button(label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = label
  node.addEventListener('click', (event) => { event.stopPropagation(); action() })
  return node
}

/** Owns only decorations and temporary diff models; every edit goes through the source buffer's undo stack. */
export function registerSourceGitFeatures(instance: editor.IStandaloneCodeEditor, filePath: string): () => void {
  const model = instance.getModel()
  if (!model) return () => undefined
  const key = fileIdentity(filePath)
  owners.set(key, (owners.get(key) ?? 0) + 1)
  let disposed = false
  let baseline = ''
  let baselineReady = false
  let blame: readonly GitBlameLine[] = []
  let changes: editor.ILineChange[] = []
  let computedVersion = 0
  let snapshotVersion = 0
  let diffOriginalVersion = 0
  let diffModifiedVersion = 0
  let request = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let hidden: HTMLDivElement | undefined
  let diff: editor.IStandaloneDiffEditor | undefined
  let original: editor.ITextModel | undefined
  let modified: editor.ITextModel | undefined
  let diffListener: IDisposable | undefined
  let previewCleanup: (() => void) | undefined
  let selected = -1
  let conflictZones: Array<() => void> = []
  let zoneSequence = 0
  const disposables: IDisposable[] = []
  const decorations = instance.createDecorationsCollection()
  const conflictDecorations = instance.createDecorationsCollection()

  const valid = (): boolean => !disposed && !model.isDisposed() && instance.getModel() === model
  const current = (): boolean => valid() && computedVersion === model.getVersionId() && baselineReady
  // Monaco's view-zone parent is aria-hidden. Reserve layout space there, but expose
  // interactive controls through the public overlay API so keyboard/screen readers can reach them.
  const accessibleZone = (node: HTMLElement, afterLineNumber: number, height: number): (() => void) => {
    const widget: editor.IOverlayWidget = { getId: () => `aether.sourceGit.${instance.getId()}.${++zoneSequence}`, getDomNode: () => node, getPosition: () => null }
    const widgetId = widget.getId()
    widget.getId = () => widgetId
    node.style.height = `${height}px`
    let top = -10000
    const layout = (): void => {
      const info = instance.getLayoutInfo()
      node.style.left = `${info.contentLeft}px`
      node.style.width = `${info.contentWidth}px`
      node.style.top = `${top}px`
      node.style.display = top + height <= 0 || top >= info.height ? 'none' : ''
    }
    instance.addOverlayWidget(widget)
    const subscription = instance.onDidLayoutChange(layout)
    let zone = ''
    instance.changeViewZones((accessor) => {
      zone = accessor.addZone({ afterLineNumber, heightInPx: height, domNode: document.createElement('div'), onDomNodeTop: (value) => { top = value; layout() } })
    })
    layout()
    return () => {
      subscription.dispose()
      instance.removeOverlayWidget(widget)
      instance.changeViewZones((accessor) => accessor.removeZone(zone))
    }
  }
  const closePreview = (): void => {
    previewCleanup?.()
    previewCleanup = undefined
    selected = -1
  }
  const apply = (edit: BufferReplacement): void => {
    if (instance.getOption(monaco.editor.EditorOption.readOnly)) { toast.info('此文件当前为只读，无法修改。'); return }
    const start = model.getPositionAt(edit.startOffset)
    const end = model.getPositionAt(edit.endOffset)
    instance.pushUndoStop()
    instance.executeEdits('aether.sourceGit', [{ range: monaco.Range.fromPositions(start, end), text: edit.text }])
    instance.pushUndoStop()
    instance.focus()
  }

  const openPreview = (index: number): void => {
    if (!current()) { toast.info('正在计算最新更改，请稍后重试。'); return }
    const change = changes[index]
    if (!change) return
    closePreview()
    selected = index
    const version = computedVersion
    const originalSnapshot = baseline
    const node = document.createElement('section')
    node.className = 'source-git-preview'
    node.setAttribute('aria-label', '当前更改块')
    const header = document.createElement('div')
    header.className = 'source-git-preview-header'
    const title = document.createElement('strong')
    title.textContent = `相对 HEAD 的更改 ${index + 1}/${changes.length}`
    header.append(title,
      button('上一处', () => openPreview((index + changes.length - 1) % changes.length)),
      button('下一处', () => openPreview((index + 1) % changes.length)),
      button('撤销此处更改', () => {
        if (!current() || model.getVersionId() !== version || baseline !== originalSnapshot) {
          closePreview(); toast.warning('内容或 HEAD 已变化，请重新打开最新更改块。'); return
        }
        apply(revertLineChange(originalSnapshot, model.getValue(), change))
      }),
      button('打开文件差异', () => {
        const root = getWorkspaceState().root
        if (!root) return
        const rel = filePath.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').replace(/\/$/, '').length + 1)
        void import('../../contrib/git/GitDiffView').then(({ openGitDiff }) => openGitDiff(root, rel)).catch((error: unknown) => toast.error(String(error)))
      }),
      button('关闭更改块', () => { closePreview(); instance.focus() }))
    const body = document.createElement('div')
    body.className = 'source-git-preview-body'
    const sides = [
      { label: 'HEAD', text: baseline, start: change.originalStartLineNumber, end: change.originalEndLineNumber, kind: 'removed' },
      { label: '当前缓冲区', text: model.getValue(), start: change.modifiedStartLineNumber, end: change.modifiedEndLineNumber, kind: 'added' }
    ]
    for (const side of sides) {
      const section = document.createElement('div')
      section.className = `source-git-preview-side ${side.kind}`
      const label = document.createElement('div')
      label.textContent = side.label
      const pre = document.createElement('pre')
      pre.textContent = side.end === 0 ? '（空）' : side.text.split(/\r\n|\n|\r/).slice(side.start - 1, side.end).map((line, i) => `${side.start + i}  ${line}`).join('\n')
      section.append(label, pre)
      body.append(section)
    }
    node.append(header, body)
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closePreview(); instance.focus() }
      if (event.key === 'F7') { event.preventDefault(); openPreview((index + (event.shiftKey ? changes.length - 1 : 1)) % changes.length) }
    })
    previewCleanup = accessibleZone(node, Math.min(model.getLineCount(), Math.max(1, change.modifiedEndLineNumber || change.modifiedStartLineNumber)), 230)
    const line = Math.min(model.getLineCount(), hunkLine(change))
    instance.setPosition({ lineNumber: line, column: 1 })
    instance.revealLineNearTop(line)
  }

  const navigate = (forward: boolean): void => {
    if (!changes.length) { toast.info(baselineReady ? '此文件没有相对 HEAD 的更改。' : '此文件暂时没有可用的 Git 基准。'); return }
    if (selected >= 0) { openPreview((selected + (forward ? 1 : changes.length - 1)) % changes.length); return }
    const line = instance.getPosition()?.lineNumber ?? 1
    let index = forward ? changes.findIndex((change) => hunkLine(change) >= line) : changes.findLastIndex((change) => hunkLine(change) <= line)
    if (index < 0) index = forward ? 0 : changes.length - 1
    openPreview(index)
  }

  const renderChanges = (): void => {
    decorations.set(changes.map((change) => {
      const kind = change.originalEndLineNumber === 0 ? 'added' : change.modifiedEndLineNumber === 0 ? 'deleted' : 'modified'
      const start = Math.min(model.getLineCount(), hunkLine(change))
      const end = Math.min(model.getLineCount(), Math.max(start, change.modifiedEndLineNumber))
      const color = cssColor(kind === 'added' ? '--git-added' : kind === 'deleted' ? '--git-deleted' : '--git-modified')
      return {
        range: new monaco.Range(start, 1, end, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `source-git-gutter source-git-gutter-${kind}`,
          linesDecorationsTooltip: '查看相对 HEAD 的更改（F7）',
          // 同一处改动同时进入右侧 overview ruler 与 minimap，滚动到长文件时
          // 不需要先找到左侧 gutter 才能知道改动分布。
          overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Left },
          // 这些区块的范围只覆盖第 1 列；用 Inline 会得到 0 宽度的标记。
          // Gutter 会像 VS Code 一样在小地图左缘画固定宽度的改动色带，
          // 与左侧 gutter 和 overview ruler 保持同一条垂直分布。
          minimap: { color, position: monaco.editor.MinimapPosition.Gutter },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      }
    }))
    publish(key, { status: 'ready', version: computedVersion, changes, blame })
  }

  const recompute = (): void => {
    if (!valid() || !baselineReady || !diff || !original || !modified) return
    snapshotVersion = model.getVersionId()
    const value = model.getValue()
    if (value === baseline) {
      computedVersion = snapshotVersion; changes = []; renderChanges()
    }
    if (modified.getValue() !== value) modified.setValue(value)
    else if (diffOriginalVersion === original.getVersionId() && diffModifiedVersion === modified.getVersionId()) {
      const next = diff.getLineChanges()
      if (next) { changes = next; computedVersion = snapshotVersion; renderChanges() }
    }
  }

  const ensureDiff = (): void => {
    if (diff) return
    hidden = document.createElement('div')
    hidden.className = 'source-git-computation'
    hidden.setAttribute('aria-hidden', 'true')
    // Computation does not require attaching the editor. Keeping it detached avoids
    // hidden controls in the page and avoids unnecessary document layout work.
    original = monaco.editor.createModel(baseline, 'plaintext')
    modified = monaco.editor.createModel(model.getValue(), 'plaintext')
    snapshotVersion = model.getVersionId()
    diff = monaco.editor.createDiffEditor(hidden, { readOnly: true, originalEditable: false, renderSideBySide: false, automaticLayout: false, dimension: { width: 600, height: 150 }, minimap: { enabled: false }, ignoreTrimWhitespace: false, diffAlgorithm: 'advanced', maxComputationTime: 0, renderOverviewRuler: false, enableSplitViewResizing: false, renderIndicators: false, accessibilitySupport: 'off' })
    diffListener = diff.onDidUpdateDiff(() => {
      if (!valid() || snapshotVersion !== model.getVersionId() || original?.getValue() !== baseline || modified?.getValue() !== model.getValue()) return
      const next = diff?.getLineChanges()
      if (!next) return
      changes = next
      diffOriginalVersion = original.getVersionId()
      diffModifiedVersion = modified.getVersionId()
      computedVersion = snapshotVersion
      renderChanges()
    })
    diff.setModel({ original, modified })
  }

  const reloadBaseline = async (): Promise<void> => {
    const root = getWorkspaceState().root
    if (!root || !fileIdentity(filePath).startsWith(`${fileIdentity(root).replace(/\/$/, '')}/`)) return
    const rel = filePath.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').replace(/\/$/, '').length + 1)
    const id = ++request
    try {
      const authors = await gitBlame(root, rel)
      const result = authors.head && authors.lines?.length ? await gitShowCommitFile(root, authors.head, rel) : await gitHeadFile(root, rel)
      if (!valid() || id !== request) return
      if (!result.success) {
        baselineReady = false; changes = []; decorations.clear(); closePreview()
        publish(key, EMPTY)
        return
      }
      const next = result.content ?? ''
      blame = authors.success ? authors.lines ?? [] : []
      if (baselineReady && baseline === next) { publish(key, { status: current() ? 'ready' : 'loading', version: computedVersion, changes, blame }); return }
      closePreview()
      baseline = next
      baselineReady = true
      computedVersion = 0
      publish(key, { status: 'loading', version: 0, changes: [], blame: [] })
      ensureDiff()
      original?.setValue(baseline)
      recompute()
    } catch {
      if (valid() && id === request) { baselineReady = false; changes = []; decorations.clear(); closePreview(); publish(key, EMPTY) }
    }
  }

  const resolveConflict = (conflict: DocumentMergeConflict, side: 'current' | 'incoming' | 'both', version: number): void => {
    if (!valid() || model.getVersionId() !== version) { toast.warning('冲突内容已变化，请使用最新的冲突操作。'); return }
    const before = model.getValue()
    apply(minimalReplacement(before, resolveConflictText(before, conflict, side)))
  }

  const renderConflicts = (): void => {
    if (!valid()) return
    const version = model.getVersionId()
    const conflicts = scanConflicts(model.getValue())
    for (const dispose of conflictZones) dispose()
    conflictZones = conflicts.map((conflict) => {
        const node = document.createElement('div')
        node.className = 'source-conflict-actions'
        node.setAttribute('aria-label', `第 ${conflict.rangeStart} 行合并冲突`)
        node.append(button('采用当前更改', () => resolveConflict(conflict, 'current', version)), button('采用传入更改', () => resolveConflict(conflict, 'incoming', version)), button('保留双方更改', () => resolveConflict(conflict, 'both', version)))
        return accessibleZone(node, conflict.rangeStart - 1, 30)
      })
    conflictDecorations.set(conflicts.flatMap((conflict) => [
      { range: new monaco.Range(conflict.current.decoStartLine, 1, conflict.current.decoEndLine, 1), options: { isWholeLine: true, className: 'source-conflict-current' } },
      { range: new monaco.Range(conflict.incoming.decoStartLine, 1, conflict.incoming.decoEndLine, 1), options: { isWholeLine: true, className: 'source-conflict-incoming' } }
    ]))
  }

  disposables.push(instance.addAction({ id: 'aether.git.nextSourceChange', label: '转到下一处 Git 更改', keybindings: [monaco.KeyCode.F7], contextMenuGroupId: 'navigation', run: () => navigate(true) }))
  disposables.push(instance.addAction({ id: 'aether.git.previousSourceChange', label: '转到上一处 Git 更改', keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F7], contextMenuGroupId: 'navigation', run: () => navigate(false) }))
  for (const [side, label] of [['current', '采用当前更改'], ['incoming', '采用传入更改'], ['both', '保留双方更改']] as const) {
    disposables.push(instance.addAction({ id: `aether.git.resolveConflict.${side}`, label: `合并冲突：${label}`, run: () => {
      const conflict = findConflictAtLine(scanConflicts(model.getValue()), instance.getPosition()?.lineNumber ?? 1)
      if (conflict) resolveConflict(conflict, side, model.getVersionId())
      else toast.info('光标所在位置没有合并冲突。')
    } }))
  }
  for (const forward of [true, false]) disposables.push(instance.addAction({ id: `aether.git.${forward ? 'next' : 'previous'}Conflict`, label: forward ? '转到下一处合并冲突' : '转到上一处合并冲突', run: () => {
    const conflict = nextConflict(scanConflicts(model.getValue()), instance.getPosition()?.lineNumber ?? 1, forward)
    if (conflict) { instance.setPosition({ lineNumber: conflict.rangeStart, column: 1 }); instance.revealLineInCenter(conflict.rangeStart) }
  } }))
  disposables.push(instance.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !event.target.position) return
    const line = event.target.position.lineNumber
    const index = changes.findIndex((change) => line >= hunkLine(change) && line <= Math.max(hunkLine(change), change.modifiedEndLineNumber))
    if (index >= 0) openPreview(index)
  }))
  disposables.push(instance.onKeyDown((event) => { if (event.keyCode === monaco.KeyCode.Escape && previewCleanup) { event.preventDefault(); closePreview() } }))
  disposables.push(model.onDidChangeContent(() => {
    closePreview()
    computedVersion = 0
    decorations.clear()
    publish(key, { status: baselineReady ? 'loading' : 'unavailable', version: 0, changes: [], blame })
    renderConflicts()
    clearTimeout(timer)
    timer = setTimeout(recompute, 100)
  }))
  let lastFiles = getGitState().files
  let wasLoading = getGitState().loading
  const unsubscribeGit = onGitChanged(() => {
    const state = getGitState()
    const refresh = state.files !== lastFiles || (wasLoading && !state.loading)
    lastFiles = state.files; wasLoading = state.loading
    if (refresh) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void reloadBaseline(), 150) }
  })
  // Decoration colors are resolved to concrete hex values for Monaco. Repaint them
  // when the user switches dark/light appearance or accent-related Git tokens.
  const unsubscribeTheme = watchTheme(renderChanges)
  renderConflicts()
  void reloadBaseline()
  return () => {
    if (disposed) return
    disposed = true
    request++
    clearTimeout(timer); clearTimeout(refreshTimer)
    unsubscribeGit()
    unsubscribeTheme()
    closePreview()
    for (const dispose of conflictZones) dispose()
    for (const disposable of disposables) disposable.dispose()
    decorations.clear(); conflictDecorations.clear()
    diffListener?.dispose(); diff?.dispose(); original?.dispose(); modified?.dispose(); hidden?.remove()
    const remaining = (owners.get(key) ?? 1) - 1
    if (remaining) owners.set(key, remaining)
    else { owners.delete(key); snapshots.delete(key); for (const listener of listeners.get(key) ?? []) listener(EMPTY) }
  }
}
