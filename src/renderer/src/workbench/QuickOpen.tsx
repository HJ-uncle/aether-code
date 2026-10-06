import { useEffect, useMemo, useRef, useState, type JSX, type MutableRefObject } from 'react'
import { documentKey, getEditorState, openFile } from '@renderer/core/editor/editor-store'
import { getRecentFiles } from '@renderer/core/editor/recent-files'
import { executeCommand, isCommandEnabled, registerCommand } from '@renderer/core/platform/commands'
import { recordCommandRun } from '@renderer/core/platform/commands-history'
import { registerKeybinding } from '@renderer/core/platform/keybindings'
import { getLayout, setLayout } from '@renderer/core/platform/layout-state'
import { listAllFiles, paths } from '@renderer/core/workspace/fs-client'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { buildCommandItems, type CommandItem } from './command-filter'
import { FuzzyText } from './FuzzyText'
import { fuzzyMatch } from '@renderer/core/platform/fuzzy'

const TOGGLE_COMMAND = 'aether.quickOpen.toggle'
const MAX_ITEMS = 50

/**
 * 快速打开文件（对标 VS Code 的 Ctrl+P / Anything Quick Access）
 *
 * 模式前缀照搬 VS Code：
 *   无前缀 → 文件：无输入列最近打开的文件，有输入模糊匹配文件名/路径
 *   `>`    → 命令模式（同命令面板）
 *   `:`    → 行号跳转，支持 `文件:行:列`；纯 `:12` 跳当前激活编辑器
 *   `?`    → 帮助：列出各前缀的用法
 * `@`/`#` 符号跳转依赖语言服务（symbol provider），暂未接入故不提供。
 * UI 与命令面板共用 .palette 样式，但它是独立组件：两者常驻 Workbench 互不依赖。
 */

type Mode = 'files' | 'commands' | 'help'

interface ParsedQuery {
  mode: Mode
  /** 去掉前缀与行号后的查询串 */
  text: string
  line?: number
  column?: number
}

/** 尾部 `:行(:列)` 解析；`a.ts:1:2` / `a.ts:1` / `:1` 均可，冒号后非数字不误伤 */
function parseQuery(raw: string): ParsedQuery {
  if (raw.startsWith('?')) return { mode: 'help', text: '' }
  if (raw.startsWith('>')) return { mode: 'commands', text: raw.slice(1) }

  const matched = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(raw)
  if (matched) {
    return {
      mode: 'files',
      text: matched[1],
      line: Number(matched[2]),
      column: matched[3] ? Number(matched[3]) : undefined
    }
  }
  return { mode: 'files', text: raw }
}

interface FileItem {
  rel: string
  name: string
  /** 目录前缀长度（name 在 rel 中的起点） */
  nameStart: number
  positions: number[]
  score: number
}

/** 关闭动画时长：与 app.css 的 .palette-overlay 过渡一致 */
const LAZY_START_MS = 160

/**
 * 另一个 palette 是否开着（命令面板）。
 *
 * 两个面板共用 .palette-overlay / .palette，但由各自组件管理开合，
 * 谁也不知道对方的 state。键位分发是「先注册者先响应」，Ctrl+Shift+P
 * 命中的是命令面板而不是这里的 TOGGLE_COMMAND，所以退出必须靠查 DOM，
 * 否则本组件的捕获监听会把 Esc 吞掉，命令面板再也关不上。
 */
function isOtherPaletteOpen(): boolean {
  return document.querySelector('.palette[aria-label="命令面板"]') !== null
}

export function QuickOpen(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [generation, setGeneration] = useState(0)
  const generationRef = useRef(0)
  // 主动让位（切去了命令面板）：这次关闭不当作"用户关掉了面板"
  const closedRef = useRef(false)

  useEffect(() => {
    const disposeCommand = registerCommand({
      id: TOGGLE_COMMAND,
      title: '转到文件…',
      category: '文件',
      run: () => {
        closedRef.current = false
        // A second Ctrl+P can arrive before the previous overlay finishes fading out.
        // Remount it so its query, leaving state and close timer belong to one opening.
        setGeneration(++generationRef.current)
        setOpen(true)
      }
    })
    const disposeKeybinding = registerKeybinding({ key: 'ctrl+p', command: TOGGLE_COMMAND })
    return () => {
      disposeCommand()
      disposeKeybinding()
    }
  }, [])

  if (!open) return null
  return (
    <QuickOverlay
      key={generation}
      closedRef={closedRef}
      onClose={(lazy) => {
        if (generationRef.current !== generation) return
        closedRef.current = lazy ?? false
        setOpen(false)
      }}
    />
  )
}

function QuickOverlay({
  onClose,
  closedRef
}: {
  onClose: (lazy?: boolean) => void
  /** 主动让位标记：置真后本组件的捕获监听立即停止抢键 */
  closedRef: MutableRefObject<boolean>
}): JSX.Element {
  const workspace = useWorkspace()
  const root = workspace.root
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [files, setFiles] = useState<string[] | null>(null)
  const [leaving, setLeaving] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const parsed = parseQuery(query)

  // 打开时拉取文件清单；切换工作区后重新拉取
  useEffect(() => {
    if (!root) return
    let cancelled = false
    listAllFiles(root)
      .then((list) => {
        if (!cancelled) setFiles(list)
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [root])

  // ── 文件模式候选 ──
  const fileItems = useMemo<FileItem[]>(() => {
    if (parsed.mode !== 'files' || !root) return []
    const text = parsed.text.trim().toLowerCase()
    const rootPrefix = `${root.replace(/\\/g, '/')}/`

    // 纯行号跳转（`:12`）不列文件候选：目标就是当前激活编辑器（VS Code 语义）
    if (parsed.line && !text) return []

    // 无输入：最近打开的文件（过滤出当前工作区内的），对齐 VS Code 编辑器历史
    if (!text) {
      const seen = new Set<string>()
      const items: FileItem[] = []
      for (const filePath of getRecentFiles()) {
        const normalized = filePath.replace(/\\/g, '/')
        if (!normalized.toLowerCase().startsWith(rootPrefix.toLowerCase())) continue
        const rel = normalized.slice(rootPrefix.length)
        if (seen.has(rel)) continue
        seen.add(rel)
        items.push(splitRel(rel, []))
        if (items.length >= MAX_ITEMS) break
      }
      return items
    }

    // 有输入：整个相对路径参与模糊匹配（目录分隔符后的命中会拿到词首加分）
    const scored: FileItem[] = []
    for (const rel of files ?? []) {
      const matched = fuzzyMatch(parsed.text.trim(), rel)
      if (matched) scored.push(splitRel(rel, matched.positions, matched.score))
    }
    scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
    return scored.slice(0, MAX_ITEMS)
  }, [parsed.mode, parsed.text, parsed.line, files, root])

  // ── 命令模式候选（与命令面板共用过滤逻辑）──
  const commandGroups = useMemo(() => {
    if (parsed.mode !== 'commands') return []
    return buildCommandItems(parsed.text)
  }, [parsed.mode, parsed.text])

  const commandItems = useMemo(() => commandGroups.flatMap((group) => group.items), [commandGroups])

  // 统一的候选项数量（键盘导航跨模式）
  const count =
    parsed.mode === 'commands'
      ? commandItems.length
      : parsed.mode === 'help'
        ? HELP_ITEMS.length
        : fileItems.length

  /**
   * 关闭面板。
   *
   * lazy=true 时先给遮罩挂上 is-leaving 展示淡出，稍后再真正卸载 ——
   * 直接从 DOM 摘掉会让整个面板瞬间消失，观感上是"一闪"。
   * 同时把 closedRef 置真，让上面那个捕获监听立刻停止拦截按键：
   * 实测卸载后监听仍会收到同一次按键（clearTimeout 也无济于事），
   * 只靠"少渲染一次"无法保证下一个面板的 Esc 不被吞掉。
   */
  const close = (lazy = false): void => {
    // The editor already receives focus while the overlay fades out. Stop the
    // capture listener now so it cannot swallow the editor's first arrow key.
    closedRef.current = true
    if (lazy) {
      setLeaving(true)
      window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(() => onClose(true), LAZY_START_MS)
      return
    }
    window.clearTimeout(closeTimer.current)
    onClose(false)
  }

  const openFileItem = (item: FileItem): void => {
    if (!root) return
    close(true)
    const filePath = paths.join(root, item.rel)
    void openFile(filePath, parsed.line, parsed.column)
    setLayout({ activeEditorView: documentKey(filePath) })
  }

  /** 纯 `:行号`：跳当前激活编辑器的指定行 */
  const activeDocPath = (): string | null => {
    const activeView = getLayout().activeEditorView
    if (!activeView?.startsWith('doc:')) return null
    const filePath = activeView.slice(4)
    return getEditorState().docs.has(filePath) ? filePath : null
  }

  const revealActiveEditor = (): void => {
    const filePath = activeDocPath()
    if (!filePath) return
    close(true)
    void openFile(filePath, parsed.line, parsed.column)
  }

  const runCommand = (item: CommandItem): void => {
    if (!isCommandEnabled(item.entry.id)) return
    // 主动让位（可能是"打开命令面板"）：close(true) 会把 closedRef 置真，
    // 本组件的捕获监听立刻不再抢键
    close(true)
    recordCommandRun(item.entry.id)
    void executeCommand(item.entry.id)
  }

  const accept = (index: number): void => {
    if (parsed.mode === 'commands') {
      const item = commandItems[Math.min(index, commandItems.length - 1)]
      if (item) runCommand(item)
      return
    }
    if (parsed.mode === 'help') return

    if (!parsed.line && fileItems.length === 0) return
    // 有行号但没匹配到文件（如纯 `:12`）→ 作用于当前激活编辑器
    if (fileItems.length === 0) {
      if (parsed.line) revealActiveEditor()
      return
    }
    openFileItem(fileItems[Math.min(index, fileItems.length - 1)])
  }

  // 键盘处理走 window 捕获阶段（对齐 VS Code QuickInput 的全局键分发）：
  // 点击列表项会让按钮卸载、焦点瞬间掉回 body，容器级 onKeyDown 收不到
  // 冒泡事件；全局捕获保证 Esc / 方向键 / 回车在任何焦点状态下都可达。
  // 无依赖数组：每次渲染重挂，闭包里的 active/count/accept 始终是最新值。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 面板关闭或已让位给命令面板后，这个监听仍在（捕获阶段且不判断状态），
      // 会把发给别人的 Esc 一并 stopPropagation 掉。必须在捕获阶段先自查。
      if (closedRef.current || isOtherPaletteOpen()) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close(true)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        setActive((value) => Math.min(value + 1, count - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActive((value) => Math.max(value - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        accept(active)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // 选中项跟随滚动（ref 操作，无状态更新）
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active, query, fileItems, commandItems])

  const placeholder =
    parsed.mode === 'commands'
      ? '输入命令名过滤，回车执行…'
      : parsed.mode === 'help'
        ? '选择一个前缀了解用法…'
        : '输入文件名打开文件，支持 `文件:行:列` 精确跳转…'

  return (
    <div className={`palette-overlay${leaving ? ' is-leaving' : ''}`} onMouseDown={() => close()}>
      <div
        className="palette"
        role="dialog"
        aria-label="快速打开文件"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          autoFocus
          value={query}
          placeholder={placeholder}
          aria-label="搜索文件名"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
        />
        <div className="palette__list" ref={listRef}>
          {parsed.mode === 'help' ? (
            HELP_ITEMS.map((item, index) => (
              <button
                key={item.prefix}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`palette__item${index === active ? ' is-active' : ''}`}
                onClick={() => {
                  setQuery(item.prefix)
                  setActive(0)
                  // 列表重渲染会让焦点掉到 body，还回输入框保证输入连续；
                  // 补回焦前的键盘操作由下面的 window 捕获监听兜底
                  setTimeout(() => inputRef.current?.focus(), 0)
                }}
              >
                <span>
                  <span className="palette__key">{item.prefix}</span> {item.description}
                </span>
              </button>
            ))
          ) : parsed.mode === 'commands' ? (
            commandGroups.map((group) =>
              group.items.map((item) => {
                const index = commandItems.indexOf(item)
                return (
                  <button
                    key={item.entry.id}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`palette__item${index === active ? ' is-active' : ''}${
                      isCommandEnabled(item.entry.id) ? '' : ' is-disabled'
                    }`}
                    disabled={!isCommandEnabled(item.entry.id)}
                    title={item.entry.id}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runCommand(item)}
                  >
                    <span>
                      {item.entry.category ? (
                        <span className="palette__category">{item.entry.category}: </span>
                      ) : null}
                      <FuzzyText text={item.entry.title} positions={item.positions} />
                    </span>
                  </button>
                )
              })
            )
          ) : (
            <>
              {!root ? (
                <div className="palette__empty">尚未打开文件夹。</div>
              ) : files === null ? (
                <div className="palette__empty">正在读取文件列表…</div>
              ) : null}
              {root &&
              parsed.mode === 'files' &&
              parsed.line &&
              !parsed.text.trim() &&
              activeDocPath() ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={fileItems.length === 0 && active === 0}
                  className={`palette__item${fileItems.length === 0 && active === 0 ? ' is-active' : ''}`}
                  onClick={revealActiveEditor}
                >
                  <span>
                    跳到当前文件第 {parsed.line} 行{parsed.column ? ` 第 ${parsed.column} 列` : ''}
                  </span>
                </button>
              ) : null}
              {root && files !== null && fileItems.length === 0 && !parsed.line ? (
                <div className="palette__empty">没有匹配的文件。</div>
              ) : null}
              {root &&
              files !== null &&
              fileItems.length === 0 &&
              parsed.line &&
              !parsed.text.trim() &&
              !activeDocPath() ? (
                <div className="palette__empty">当前没有打开的编辑器，无法跳转行号。</div>
              ) : null}
              {fileItems.map((item, index) => (
                <button
                  key={item.rel}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={`palette__item${index === active ? ' is-active' : ''}`}
                  title={item.rel}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => openFileItem(item)}
                >
                  <span>
                    <FuzzyText
                      text={item.name}
                      positions={item.positions
                        .filter((p) => p >= item.nameStart)
                        .map((p) => p - item.nameStart)}
                    />
                  </span>
                  <span className="palette__category">
                    <FuzzyText
                      text={item.rel.slice(0, item.nameStart)}
                      positions={item.positions.filter((p) => p < item.nameStart)}
                    />
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** rel → 列表项（文件名/目录拆分 + 命中位置保留在各自段内） */
function splitRel(rel: string, positions: number[], score = 0): FileItem {
  const nameStart = rel.lastIndexOf('/') + 1
  return { rel, nameStart, name: rel.slice(nameStart), positions, score }
}

/** `?` 帮助条目（照搬 VS Code 的帮助列表：点选即切换到该模式） */
const HELP_ITEMS: { prefix: string; description: string }[] = [
  { prefix: '', description: '直接输入文件名，或留空查看最近打开的文件' },
  { prefix: '>', description: '执行命令（同命令面板）' },
  { prefix: ':', description: '跳转到行号，支持 文件:行:列' }
]
