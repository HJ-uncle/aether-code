/**
 * 带行内引用 chip 的输入框（对齐 wuzu-client CoworkPromptInput 的 mention 体系）
 *
 * textarea 无法承载「原子 chip」，这里用 contenteditable 实现：
 *   - chip 是 contenteditable=false 的行内元素，光标进不去、退格整枚删除，
 *     会话引用复制为可再次识别的深链接，外部富文本不会自动获得 chip 身份
 *   - 文件、源码位置、终端、协作 Agent、网页与会话共享同一套引用协议
 *   - 组件是非受控 DOM + 受控文本镜像：内部维护真实 DOM，每次输入后序列化成
 *    「带 @路径 占位符的纯文本 + mention 列表」抛给父组件
 *   - 外部把 value 改成一个与当前序列化结果不同的字符串时（回填草稿等场景），
 *     用该纯文本重建 DOM（mention 退化为普通文字，与 wuzu 粘到外部的降级一致）
 *
 * 发送协议：mention 在文本里序列化为 @路径（源码位置带 :行号区间），
 * 与 wuzu 发给引擎的占位格式一致。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type JSX
} from 'react'
import {
  MENTION_META,
  mentionToken,
  mentionTitle,
  sameMention,
  type Mention,
  type MentionSource
} from './mention-context'
import { toast } from '@renderer/core/toast'
import { CHAT_OUTLINE_PATH } from '@renderer/workbench/icons'
import { acceptsComposerChange, composerInputIssue } from './input-limits'
export { formatPathDisplay, type Mention, type MentionSource } from './mention-context'

/** An upload may finish after the user has moved the caret or replaced the draft. */
export interface MentionInsertion {
  insertMention: (mention: Mention) => boolean
  cancel: () => void
}

/** 父组件通过 ref 调用的命令式接口（插 chip / 清空 / 聚焦） */
export interface MentionInputHandle {
  insertMention: (mention: Mention) => void
  /** @ 补全选中：把光标前的「@关键词」文本替换为 chip */
  completeMention: (mention: Mention) => void
  /** / 资源补全：把光标前的 /关键词消费掉；资源以 composer chip 展示并走独立绑定字段 */
  completeSlash: (token: string) => void
  /** 删除遗留的手工资源 token（兼容旧草稿），同时保留其它 @ 引用 chip */
  removeTextToken: (token: string) => void
  /** 整体替换输入框文本（原 mention chip 全部丢弃，用于 AI 润色回填） */
  setText: (text: string) => void
  setDraft: (text: string, mentions: Mention[]) => void
  clear: () => void
  focus: () => void
}

/**
 * 在 chip 后补一个空格文本节点。
 *
 * 作用有二：给光标一个落脚点（否则光标会钻进 chip 内部的边界态），以及让 chip 与
 * 后续文字不粘连。发送时 buildMentionMessage 会再做一次空白归一化兜底——用户删掉
 * 这个空格后 DOM 会紧贴，正文里 `@a/b.ts在帮我改` 这种边界谁也认不出来。
 */
function spacerAfter(chip: HTMLElement): Text {
  const spacer = document.createTextNode(' ')
  chip.after(spacer)
  return spacer
}

/**
 * 造一枚引用 chip。
 *
 * `contenteditable=false` 让它成为原子节点：光标进不去、退格整枚删除。key 由调用方登记进 mentionsRef，
 * chip 只是它在 DOM 里的投影。
 */
function makeChip(mention: Mention, key: string, interactive = false): HTMLElement {
  const chip = document.createElement('span')
  chip.className = `mention-chip mention-chip--${mention.source}`
  chip.contentEditable = 'false'
  chip.dataset.mentionKey = key
  chip.title = mentionTitle(mention)
  const label = document.createElement('span')
  label.className = 'mention-chip__label'
  label.textContent = mention.displayText
  chip.appendChild(label)
  if (mention.source === 'conversation') {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.classList.add('mention-chip__icon')
    icon.setAttribute('width', '14')
    icon.setAttribute('height', '14')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    icon.setAttribute('focusable', 'false')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', CHAT_OUTLINE_PATH)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.75')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    icon.appendChild(path)
    chip.prepend(icon)
  }
  if (interactive) {
    chip.setAttribute('role', 'button')
    chip.setAttribute('aria-label', `查看引用：${mention.displayText}`)
    chip.tabIndex = 0
  }
  return chip
}

interface InputDraft { text: string; mentions: Mention[] }

function serializeNodes(nodes: NodeListOf<ChildNode>, registered: ReadonlyMap<string, Mention>, trimEnd = true): InputDraft {
  let text = ''
  const mentions: Mention[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent ?? ''; return }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === 'BR') { text += '\n'; return }
    if (node.tagName === 'DIV' || node.tagName === 'P') {
      if (text && !text.endsWith('\n')) text += '\n'
      node.childNodes.forEach(walk)
      return
    }
    const mention = node.dataset.mentionKey ? registered.get(node.dataset.mentionKey) : undefined
    if (mention) {
      mentions.push({ ...mention, textOffset: text.length })
      text += mentionToken(mention)
      return
    }
    node.childNodes.forEach(walk)
  }
  nodes.forEach(walk)
  return { text: trimEnd ? text.replace(/\n+$/, '') : text, mentions }
}

/**
 * 光标处的「左侧文本」与「右侧是否还有内容」。
 *
 * 用它们决定插入 chip 前要不要补空格：紧贴文字才补（对齐 wuzu「后一个字符不是空白
 * 就补一个空格」）。元素边界（<br>、块级节点）视作换行，与正文里的 \n 同义。
 */
function caretBoundaries(range: Range, box: HTMLElement): { left: string; hasRight: boolean } {
  const start = range.startContainer
  let left = ''
  let hasRight = false
  if (start.nodeType === Node.TEXT_NODE) {
    const content = start.textContent ?? ''
    left = content.slice(0, range.startOffset)
    hasRight = range.startOffset < content.length
  } else {
    for (let index = 0; index < range.startOffset && index < start.childNodes.length; index++) {
      const child = start.childNodes[index]
      left += child.nodeType === Node.TEXT_NODE ? child.textContent ?? '' : '\n'
    }
    hasRight = range.startOffset < start.childNodes.length
  }
  if (!hasRight) {
    // 光标所在容器之后还有兄弟节点（chip / 文字）也算「后面有内容」
    outer: for (let node: Node | null = start; node && node !== box; node = node.parentNode) {
      for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
        if (sibling.nodeType === Node.TEXT_NODE && (sibling.textContent ?? '').length === 0) continue
        hasRight = true
        break outer
      }
    }
  }
  return { left, hasRight }
}

interface MentionInputProps {
  value: string
  disabled?: boolean
  placeholder?: string
  /** Accessible name for the contenteditable input (mirrors textarea labels). */
  ariaLabel?: string
  /** Optional root class for consumers that need to isolate the input styles. */
  className?: string
  /** Base class used by the input. Chat keeps `chat__input` by default. */
  baseClassName?: string
  /** Keep the generic selector opt-in so keep-alive surfaces cannot collide with Code selectors. */
  includeMentionClass?: boolean
  onChange: (text: string, mentions: Mention[]) => void
  onSubmit: () => void
  /** 粘贴到剪贴板里的文件（截图/复制的文件），交给附件体系处理 */
  onPasteFiles: (files: File[]) => void
  /** 粘贴的文本超过阈值时交给附件体系落成「粘贴的文本-xxx.txt」；返回 true 表示已接管 */
  onPasteText?: (text: string, insertion: MentionInsertion) => boolean
  onOpenMention?: (mention: Mention) => void
  onInputLimit?: (message: string) => void
  /**
   * @ 补全触发：光标前出现「@关键词」时回调关键词（可为空串），
   * 光标移开或关键词失效时回调 null。父组件据此弹出/关闭文件选择面板。
   */
  onMentionQuery?: (keyword: string | null) => void
  /** / 资源补全触发；与 @ 文件引用互相独立 */
  onSlashQuery?: (keyword: string | null) => void
}

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  function MentionInput(
    { value, disabled, placeholder, ariaLabel, className, baseClassName, includeMentionClass = true, onChange, onSubmit, onPasteFiles, onPasteText, onOpenMention, onInputLimit, onMentionQuery, onSlashQuery },
    ref
  ): JSX.Element {
    const boxRef = useRef<HTMLDivElement>(null)
    // mention 列表与 DOM 里 chip 的顺序一致；chip 元素上用 data-mention-key 关联
    const mentionsRef = useRef<Map<string, Mention>>(new Map())
    const keySeqRef = useRef(0)
    /** 上一次序列化出的文本：用于区分「用户编辑」与「外部回填」 */
    const lastSerializedRef = useRef('')
    const composingRef = useRef(false)
    const acceptedDraftRef = useRef<InputDraft>({ text: '', mentions: [] })
    const draftGenerationRef = useRef(0)
    const pendingInsertionsRef = useRef(new Set<() => void>())

    const reportInputLimit = useCallback((message: string) => {
      if (onInputLimit) onInputLimit(message)
      else toast.info(message)
    }, [onInputLimit])

    const invalidateInsertions = useCallback(() => {
      draftGenerationRef.current++
      for (const cancel of pendingInsertionsRef.current) cancel()
    }, [])

    const serialize = useCallback((): { text: string; mentions: Mention[] } => {
      const box = boxRef.current
      if (!box) return { text: '', mentions: [] }
      return serializeNodes(box.childNodes, mentionsRef.current)
    }, [])

    const restoreDraft = useCallback((text: string, mentions: Mention[]) => {
      invalidateInsertions()
      const box = boxRef.current
      if (!box) return
      mentionsRef.current.clear()
      box.replaceChildren()
      let cursor = 0
      for (const mention of mentions) {
        const token = mentionToken(mention)
        const offset = mention.textOffset ?? text.indexOf(token, cursor)
        if (offset < cursor || text.slice(offset, offset + token.length) !== token) continue
        box.appendChild(document.createTextNode(text.slice(cursor, offset)))
        const key = `m${++keySeqRef.current}`
        mentionsRef.current.set(key, mention)
        box.appendChild(makeChip(mention, key, Boolean(onOpenMention)))
        cursor = offset + token.length
      }
      if (cursor < text.length) box.appendChild(document.createTextNode(text.slice(cursor)))
      lastSerializedRef.current = text
      acceptedDraftRef.current = { text, mentions: serialize().mentions }
    }, [invalidateInsertions, onOpenMention, serialize])

    const rebuildFromText = useCallback((text: string) => restoreDraft(text, []), [restoreDraft])

    /**
     * 清掉「语义为空」时浏览器留下的残留节点。
     *
     * contenteditable 里删掉最后一个字符（退格 / 全选删除 / 剪切）后，浏览器会
     * 塞一个孤立的 <br> 当光标落脚点，DOM 从此不再是空的；而 placeholder 是
     * CSS 伪元素、只能靠 `:empty` 判定空内容（见 components.css 的
     * `.mention-input:empty::before`），一旦残留就永久不再匹配 —— 现象就是
     * 「输入框清空后提示文字再也不出现」。
     *
     * 这里维持「语义为空 ⇒ DOM 为空」这一约定：判空复用 serialize()，
     * 与发送语义完全一致（末尾换行本就是视觉残留，空白文本也不算内容）。
     * 只清节点、不碰 chip：有 chip 时 serialize 会产出 @路径，不会走到这里。
     */
    const dropEmptyResidue = useCallback(() => {
      const box = boxRef.current
      if (!box || box.childNodes.length === 0) return
      if (pendingInsertionsRef.current.size > 0) return
      const { text, mentions } = serialize()
      // ​（零宽空格）不算内容；纯空白消息本就不允许发送，同样视为空
      if (mentions.length > 0 || text.replace(/​/g, '').trim() !== '') return
      box.textContent = ''
      // 若输入框仍持有焦点，把光标收回框内，用户可以直接接着打字
      if (document.activeElement !== box) return
      const selection = window.getSelection()
      if (!selection) return
      const range = document.createRange()
      range.selectNodeContents(box)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }, [serialize])

    /** 把当前 DOM 序列化并抛给父组件（IME 组合中不抛，避免打断输入法） */
    const emitChange = useCallback((): boolean => {
      if (composingRef.current) return true
      dropEmptyResidue()
      const { text, mentions } = serialize()
      if (!acceptsComposerChange(acceptedDraftRef.current.text, text)) {
        const accepted = acceptedDraftRef.current
        restoreDraft(accepted.text, accepted.mentions)
        const box = boxRef.current
        if (box && document.activeElement === box) {
          const range = document.createRange()
          range.selectNodeContents(box)
          range.collapse(false)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
        reportInputLimit(composerInputIssue(text)!)
        return false
      }
      lastSerializedRef.current = text
      acceptedDraftRef.current = { text, mentions }
      onChange(text, mentions)
      return true
    }, [onChange, serialize, dropEmptyResidue, reportInputLimit, restoreDraft])

    const insertMentionAt = useCallback(
      (mention: Mention, target?: Range, preserveSelection = false): boolean => {
        const box = boxRef.current
        if (!box) return false
        for (const [existingKey, existing] of mentionsRef.current) {
          if (sameMention(existing, mention) && box.querySelector(`[data-mention-key="${existingKey}"]`)) {
            if (!preserveSelection) box.focus()
            return true
          }
        }
        const key = `m${++keySeqRef.current}`
        mentionsRef.current.set(key, mention)
        const chip = makeChip(mention, key, Boolean(onOpenMention))

        const selection = window.getSelection()
        const savedSelection = preserveSelection && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
        let range: Range | null = target ?? null
        if (!range && selection && selection.rangeCount > 0) {
          const candidate = selection.getRangeAt(0)
          if (box.contains(candidate.commonAncestorContainer)) range = candidate
        }
        if (!range) {
          range = document.createRange()
          range.selectNodeContents(box)
          range.collapse(false)
        }
        const caretAtInsertion = savedSelection?.collapsed && range.collapsed &&
          savedSelection.startContainer === range.startContainer && savedSelection.startOffset === range.startOffset
        const boundaries = caretBoundaries(range, box)
        const hasRight = boundaries.hasRight
        let left = boundaries.left
        // 末尾换行是视觉残留，算进正文会把 chip 顶到下一行；插入前先吃掉它
        if (/\n$/.test(left) && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
          range.setStart(range.startContainer, range.startOffset - 1)
          left = left.slice(0, -1)
        }
        range.deleteContents()
        // 前后都是文字时必须留空格，否则正文里成了 `@a/b.ts在帮我改`（见 buildMentionMessage）
        if (hasRight || (left !== '' && !/\s$/.test(left))) {
          range.insertNode(document.createTextNode(' '))
        }
        range.insertNode(chip)
        const spacer = spacerAfter(chip)
        // 先 focus 再设选区：从右键菜单/面板插入时焦点还在即将卸载的按钮上，
        // focus() 会把光标落到框首（chip 之前），此时退格删不掉刚加进来的引用。
        // 顺序反过来，光标才稳定停在 chip 之后。
        if (!preserveSelection) {
          box.focus()
          range.setStartAfter(spacer)
          range.collapse(true)
          selection?.removeAllRanges()
          selection?.addRange(range)
        } else if (savedSelection) {
          if (caretAtInsertion) { savedSelection.setStartAfter(spacer); savedSelection.collapse(true) }
          selection?.removeAllRanges()
          selection?.addRange(savedSelection)
        }
        return emitChange()
      },
      [emitChange, onOpenMention]
    )

    const insertMention = useCallback((mention: Mention) => { insertMentionAt(mention) }, [insertMentionAt])

    const createPasteInsertion = useCallback((): MentionInsertion => {
      const box = boxRef.current
      if (!box) return { insertMention: () => false, cancel: () => {} }
      const selection = window.getSelection()
      let range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : document.createRange()
      if (!box.contains(range.commonAncestorContainer)) {
        range = document.createRange()
        range.selectNodeContents(box)
        range.collapse(false)
      }
      const collapsed = range.collapsed
      const original = serializeNodes(range.cloneContents().childNodes, mentionsRef.current, false)
      const generation = draftGenerationRef.current
      // Comment anchors have no visible text and survive typing elsewhere in the
      // draft. A live Range alone can silently grow to include newly typed text.
      const start = document.createComment('paste-start')
      const end = document.createComment('paste-end')
      const startRange = range.cloneRange()
      startRange.collapse(true)
      const endRange = range.cloneRange()
      endRange.collapse(false)
      endRange.insertNode(end)
      startRange.insertNode(start)
      const between = (): Range => {
        const selected = document.createRange()
        selected.setStartAfter(start)
        selected.setEndBefore(end)
        return selected
      }
      const caret = between()
      if (collapsed) { caret.setStartAfter(end); caret.collapse(true) }
      selection?.removeAllRanges()
      selection?.addRange(caret)
      let active = true
      const cancel = (): void => {
        if (!active) return
        active = false
        start.remove()
        end.remove()
        pendingInsertionsRef.current.delete(cancel)
      }
      pendingInsertionsRef.current.add(cancel)
      return {
        cancel,
        insertMention: (mention) => {
          if (!active) return false
          if (generation !== draftGenerationRef.current || !box.isConnected || !box.contains(start) || !box.contains(end)) {
            cancel()
            return false
          }
          const target = between()
          const current = serializeNodes(target.cloneContents().childNodes, mentionsRef.current, false)
          if (current.text !== original.text || current.mentions.length !== original.mentions.length ||
            current.mentions.some((item, index) => !sameMention(item, original.mentions[index]))) {
            cancel()
            return false
          }
          // The range follows anchor removal; consume before the insertion so a
          // limit rollback or a synchronous parent update cannot reuse it.
          cancel()
          return insertMentionAt(mention, target, true)
        }
      }
    }, [insertMentionAt])

    /**
     * 光标紧邻处是否贴着一枚 chip（contenteditable=false 的原子节点）。
     *
     * 为什么不交给浏览器默认行为：chip 只是一个普通 span + contenteditable=false，
     * 与 user-select 组合后各浏览器的删除表现并不一致 —— Chromium 下首次退格
     * 常常只把 chip 整体选中而不删除（鼠标点过之后才删得掉），现象就是
     * 「刚加进来的引用第一时间删不掉」。这里显式判断，命中就整枚移除，
     * 与「引用是原子单元」的语义一致。
     *
     * direction 为 before（退格，往前找）/ after（Delete，往后找）。
     */
    const chipAdjacentToCaret = useCallback((direction: 'before' | 'after'): HTMLElement | null => {
      const box = boxRef.current
      const selection = window.getSelection()
      if (!box || !selection || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (!range.collapsed || !box.contains(range.startContainer)) return null
      const node = range.startContainer
      const isChip = (target: Node | null | undefined): target is HTMLElement =>
        target instanceof HTMLElement && Boolean(target.dataset.mentionKey)
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ''
        // 光标所在的文本节点内还有字符可删，交给浏览器
        if (direction === 'before' ? range.startOffset > 0 : range.startOffset < text.length) return null
      }
      if (node === box) {
        const sibling =
          direction === 'before' ? box.childNodes[range.startOffset - 1] : box.childNodes[range.startOffset]
        return isChip(sibling) ? sibling : null
      }
      // 从光标所在节点向外走：先看兄弟，再上溯父级
      for (let cursor: Node | null = node; cursor && cursor !== box; cursor = cursor.parentNode) {
        let sibling = direction === 'before' ? cursor.previousSibling : cursor.nextSibling
        while (sibling) {
          if (isChip(sibling)) return sibling
          // 空文本节点是浏览器的光标落脚点，跳过继续找；
          // 非空文本 / <br> / 其它元素都算「还有内容」，交给默认行为
          const isEmptyText = sibling.nodeType === Node.TEXT_NODE && (sibling.textContent ?? '').length === 0
          if (!isEmptyText) return null
          sibling = direction === 'before' ? sibling.previousSibling : sibling.nextSibling
        }
      }
      return null
    }, [])

    /** 移除一枚 chip（连同 mentionsRef 登记），光标落在它原来的位置 */
    const removeChip = useCallback(
      (chip: HTMLElement): void => {
        const box = boxRef.current
        const key = chip.dataset.mentionKey
        if (!key) return
        mentionsRef.current.delete(key)
        // chip 后跟着一个空格文本节点，删掉后光标落到它上面即 chip 原位
        const anchor = chip.nextSibling ?? chip.previousSibling
        chip.remove()
        // 先聚焦再设选区：反过来 focus() 会把光标拽回框首
        box?.focus()
        if (anchor) {
          const range = document.createRange()
          range.setStart(anchor, 0)
          range.collapse(true)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
        // 删掉的若是最后一枚引用，清掉空节点，否则 placeholder 不再出现
        dropEmptyResidue()
        emitChange()
      },
      [dropEmptyResidue, emitChange]
    )

    /**
     * 检测光标前的「@关键词」触发段。
     * 规则：光标位于文本节点内，向左扫描到 '@' 为止；'@' 前一个字符必须是
     * 行首 / 空白 / 换行（避免把邮箱、代码里的装饰器误判成触发）；
     * 文件关键词以空白结束；显式 Agent 别名允许用水平空格搜索名称，
     * 否则父组件的 @agent / @智能体 名称过滤会在输入名称前被关闭。
     */
    const detectMentionQuery = useCallback((): string | null => {
      const box = boxRef.current
      const selection = window.getSelection()
      if (!box || !selection || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (!range.collapsed) return null
      const node = range.startContainer
      if (node.nodeType !== Node.TEXT_NODE || !box.contains(node)) return null
      const before = (node.textContent ?? '').slice(0, range.startOffset)
      const at = before.lastIndexOf('@')
      if (at === -1) return null
      const prevChar = at > 0 ? before[at - 1] : ''
      if (prevChar && !/[\s　]/.test(prevChar)) return null
      const keyword = before.slice(at + 1)
      const namedAgent = /^(?:agent|智能体)[ \u00a0\u3000]/i.test(keyword) &&
        !/[\s@]/.test(keyword.replace(/[ \u00a0\u3000]/g, ''))
      if (/[\s　@]/.test(keyword) && !namedAgent) return null
      return keyword
    }, [])

    const detectSlashQuery = useCallback((): string | null => {
      const box = boxRef.current
      const selection = window.getSelection()
      if (!box || !selection || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE || !box.contains(range.startContainer)) return null
      const before = (range.startContainer.textContent ?? '').slice(0, range.startOffset)
      const slash = before.lastIndexOf('/')
      if (slash < 0) return null
      const prev = slash > 0 ? before[slash - 1] : ''
      if (prev && !/[\s　]/.test(prev)) return null
      const keyword = before.slice(slash + 1)
      // The resource palette supports category + name searches; ordinary slash
      // text still ends at whitespace so prose cannot trap the completion keys.
      const namedResource = /^(?:skill|skills|技能|mcp|kb|knowledge|知识库)[ \u00a0\u3000]/i.test(keyword) &&
        !/[\s/@]/.test(keyword.replace(/[ \u00a0\u3000]/g, ''))
      if (/[\s　/@]/.test(keyword) && !namedResource) return null
      return keyword
    }, [])

    /** 光标变化（输入/点击/方向键）后同步 @ 触发状态给父组件 */
    const syncMentionQuery = useCallback(() => {
      if (!onMentionQuery) return
      onMentionQuery(composingRef.current ? null : detectMentionQuery())
    }, [onMentionQuery, detectMentionQuery])
    const syncSlashQuery = useCallback(() => {
      if (!onSlashQuery) return
      onSlashQuery(composingRef.current ? null : detectSlashQuery())
    }, [onSlashQuery, detectSlashQuery])

    /**
     * 把光标前的「@关键词」替换为 chip（@ 补全面板选中项时调用）。
     * 找不到触发段时退化为在光标处插入。
     */
    const completeMention = useCallback(
      (mention: Mention) => {
        const box = boxRef.current
        const selection = window.getSelection()
        if (box && selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0)
          const node = range.startContainer
          if (range.collapsed && node.nodeType === Node.TEXT_NODE && box.contains(node)) {
            const before = (node.textContent ?? '').slice(0, range.startOffset)
            const at = before.lastIndexOf('@')
            if (at !== -1) {
              const deleteRange = document.createRange()
              deleteRange.setStart(node, at)
              deleteRange.setEnd(node, range.startOffset)
              deleteRange.deleteContents()
              selection.removeAllRanges()
              selection.addRange(deleteRange)
            }
          }
        }
        insertMention(mention)
        onMentionQuery?.(null)
      },
      [insertMention, onMentionQuery]
    )

    const completeSlash = useCallback((_token: string) => {
      const box = boxRef.current
      const selection = window.getSelection()
      if (!box || !selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      const node = range.startContainer
      if (range.collapsed && node.nodeType === Node.TEXT_NODE && box.contains(node)) {
        const before = (node.textContent ?? '').slice(0, range.startOffset)
        const slash = before.lastIndexOf('/')
        if (slash >= 0) {
          const replace = document.createRange()
          replace.setStart(node, slash)
          replace.setEnd(node, range.startOffset)
          replace.deleteContents()
          selection.removeAllRanges()
          selection.addRange(replace)
        }
      }
      // Resource bindings are carried in the chat request's skills/mcpServers/
      // knowledgeBases fields. Do not leave a raw `/mcp:id` command in the
      // user-visible prompt: it duplicated the binding chip and was easy to
      // desynchronise when either one was removed.
      onSlashQuery?.(null)
      emitChange()
    }, [emitChange, onSlashQuery])

    const removeTextToken = useCallback((token: string) => {
      const box = boxRef.current
      if (!box || !token) return
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? ''
        const offset = text.indexOf(token)
        if (offset < 0) continue
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + token.length)
        range.deleteContents()
        box.focus()
        const selection = window.getSelection()
        selection?.removeAllRanges(); selection?.addRange(range)
        emitChange()
        syncSlashQuery()
        return
      }
    }, [emitChange, syncSlashQuery])

    useImperativeHandle(
      ref,
      () => ({
        insertMention,
        completeMention,
        completeSlash,
        removeTextToken,
        setText: (text: string) => {
          rebuildFromText(text)
          emitChange()
        },
        setDraft: restoreDraft,
        clear: () => {
          rebuildFromText('')
          emitChange()
        },
        focus: () => boxRef.current?.focus()
      }),
      [insertMention, completeMention, completeSlash, removeTextToken, rebuildFromText, restoreDraft, emitChange]
    )

    // 光标移动（点击/方向键）不产生 input 事件，用 selectionchange 补齐 @ 触发检测
    useEffect(() => {
      if (!onMentionQuery && !onSlashQuery) return
      const handler = () => {
        const box = boxRef.current
        const selection = window.getSelection()
        if (!box || !selection || selection.rangeCount === 0) return
        if (!box.contains(selection.getRangeAt(0).startContainer)) return
        syncMentionQuery()
        syncSlashQuery()
      }
      document.addEventListener('selectionchange', handler)
      return () => document.removeEventListener('selectionchange', handler)
    }, [onMentionQuery, onSlashQuery, syncMentionQuery, syncSlashQuery])

    // 外部回填（撤回消息重新编辑等）：value 与内部序列化结果不一致时重建 DOM
    useEffect(() => {
      if (value === lastSerializedRef.current) return
      rebuildFromText(value)
    }, [value, rebuildFromText])

    useEffect(() => invalidateInsertions, [invalidateInsertions])

    useEffect(() => {
      boxRef.current?.querySelectorAll<HTMLElement>('[data-mention-key]').forEach((chip) => {
        const mention = mentionsRef.current.get(chip.dataset.mentionKey ?? '')
        if (onOpenMention && mention) {
          chip.setAttribute('role', 'button')
          chip.setAttribute('aria-label', `查看引用：${mention.displayText}`)
          chip.tabIndex = 0
        } else {
          chip.removeAttribute('role')
          chip.removeAttribute('aria-label')
          chip.removeAttribute('tabindex')
        }
      })
    }, [onOpenMention])

    const copyConversationSelection = useCallback((event: ClipboardEvent<HTMLDivElement>, cut = false) => {
      if (cut && disabled) { event.preventDefault(); return }
      const box = boxRef.current
      const selection = window.getSelection()
      if (!box || !selection?.rangeCount || selection.isCollapsed) return
      const range = selection.getRangeAt(0).cloneRange()
      if (!box.contains(range.commonAncestorContainer)) return
      // Native selection may cover the contents of an atomic chip rather than
      // its outer span. Expand only that known chip so its identity survives.
      const ancestor = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
      const enclosingChip = ancestor?.closest<HTMLElement>('[data-mention-key]')
      const enclosingMention = enclosingChip ? mentionsRef.current.get(enclosingChip.dataset.mentionKey ?? '') : undefined
      if (enclosingChip && enclosingMention?.source === 'conversation') range.selectNode(enclosingChip)
      const fragment = range.cloneContents()
      let hasConversation = false
      fragment.querySelectorAll<HTMLElement>('[data-mention-key]').forEach((chip) => {
        const mention = mentionsRef.current.get(chip.dataset.mentionKey ?? '')
        if (mention?.source !== 'conversation' || !mention.path) return
        chip.replaceWith(document.createTextNode(mention.path))
        hasConversation = true
      })
      if (!hasConversation) return
      // The clipboard carries navigation addresses, never frozen history or Agent
      // metadata. Work resolves a pasted address in its own active source scope.
      const text = serializeNodes(fragment.childNodes, new Map(), false).text
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
      if (cut) {
        range.deleteContents()
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        emitChange()
        syncMentionQuery()
        syncSlashQuery()
      }
    }, [disabled, emitChange, syncMentionQuery, syncSlashQuery])

    return (
      <div
        ref={boxRef}
        className={[baseClassName ?? 'chat__input', className, includeMentionClass ? 'mention-input' : undefined].filter(Boolean).join(' ')}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        contentEditable={disabled ? 'false' : 'true'}
        data-placeholder={placeholder ?? ''}
        onInput={() => {
          emitChange()
          syncMentionQuery()
          syncSlashQuery()
        }}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          emitChange()
          syncSlashQuery()
        }}
        onCopy={(event) => copyConversationSelection(event)}
        onCut={(event) => copyConversationSelection(event, true)}
        onPaste={(event) => {
          if (disabled) { event.preventDefault(); return }
          const files = [...event.clipboardData.files]
          if (files.length > 0) {
            event.preventDefault()
            onPasteFiles(files)
            return
          }
          // 纯文本粘贴：禁用浏览器默认的富文本粘贴，防止带入样式/标签
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          if (!text) return
          // 长文本优先落成附件（wuzu-client 同款「粘贴的文本-xxx.txt」），未接管才插入光标处
          if (onPasteText) {
            const insertion = createPasteInsertion()
            try {
              if (onPasteText(text, insertion)) return
            } catch (error) {
              insertion.cancel()
              throw error
            }
            insertion.cancel()
          }
          const current = serialize().text
          let projected = current + text
          const box = boxRef.current
          const selection = window.getSelection()
          if (box && selection?.rangeCount) {
            const range = selection.getRangeAt(0)
            if (box.contains(range.commonAncestorContainer)) {
              const before = document.createRange()
              before.selectNodeContents(box)
              before.setEnd(range.startContainer, range.startOffset)
              const after = document.createRange()
              after.selectNodeContents(box)
              after.setStart(range.endContainer, range.endOffset)
              projected = serializeNodes(before.cloneContents().childNodes, mentionsRef.current, false).text + text +
                serializeNodes(after.cloneContents().childNodes, mentionsRef.current, false).text
            }
          }
          if (!acceptsComposerChange(current, projected)) {
            reportInputLimit(composerInputIssue(projected)!)
            return
          }
          document.execCommand('insertText', false, text)
        }}
        onClick={(event) => {
          if (!(event.target instanceof Element)) return
          const chip = event.target.closest<HTMLElement>('[data-mention-key]')
          const mention = chip ? mentionsRef.current.get(chip.dataset.mentionKey ?? '') : undefined
          if (mention && onOpenMention) {
            event.stopPropagation()
            onOpenMention(mention)
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composingRef.current) return
          const focusedChip = event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>('[data-mention-key]') : null
          const focusedMention = focusedChip ? mentionsRef.current.get(focusedChip.dataset.mentionKey ?? '') : undefined
          if (focusedMention && onOpenMention && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            event.stopPropagation()
            onOpenMention(focusedMention)
            return
          }
          if (disabled) return
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            const issue = composerInputIssue(serialize().text)
            if (issue) { reportInputLimit(issue); return }
            onSubmit()
            return
          }
          // 引用 chip 的整枚删除（见 chipAdjacentToCaret 的说明）。
          // 组合输入中不接管，避免打断输入法候选。
          if (event.key === 'Backspace' || event.key === 'Delete') {
            const chip = focusedChip ?? chipAdjacentToCaret(event.key === 'Backspace' ? 'before' : 'after')
            if (chip) {
              event.preventDefault()
              removeChip(chip)
            }
          }
          syncSlashQuery()
        }}
        suppressContentEditableWarning
      />
    )
  }
)

/** 导出类型守卫，方便其它模块判断 chip 类型 */
export function mentionHint(source: MentionSource): string {
  return MENTION_META[source].hint
}
