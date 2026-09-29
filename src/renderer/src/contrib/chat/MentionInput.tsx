/**
 * 带行内引用 chip 的输入框（对齐 wuzu-client CoworkPromptInput 的 mention 体系）
 *
 * textarea 无法承载「原子 chip」，这里用 contenteditable 实现：
 *   - chip 是 contenteditable=false 的行内元素，光标进不去、退格整枚删除，
 *     复制粘贴时随 data-* 属性一起序列化/还原（原子行为免费获得）
 *   - 支持 5 种引用：文件 / 目录 / 源码位置（带行号区间）/ 终端输出 / 协作 Agent
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
  type JSX
} from 'react'

export type MentionSource = 'file' | 'dir' | 'code' | 'terminal' | 'agent'

/** 每种 chip 的颜色与 hover 提示（对齐 wuzu MENTION_META；图标由 CSS ::before 渲染） */

export interface Mention {
  /** chip 上显示的文字 */
  displayText: string
  source: MentionSource
  /** 相对工作区路径（终端引用指向落地的临时文件） */
  path?: string
  /** 源码引用的起始/结束行号 */
  startLine?: number
  endLine?: number
}

/** 父组件通过 ref 调用的命令式接口（插 chip / 清空 / 聚焦） */
export interface MentionInputHandle {
  insertMention: (mention: Mention) => void
  /** @ 补全选中：把光标前的「@关键词」文本替换为 chip */
  completeMention: (mention: Mention) => void
  /** 整体替换输入框文本（原 mention chip 全部丢弃，用于 AI 润色回填） */
  setText: (text: string) => void
  clear: () => void
  focus: () => void
}

/** 每种 chip 的图标与颜色（对齐 wuzu MENTION_META） */
const MENTION_META: Record<MentionSource, { color: string; hint: string }> = {
  file: { color: '#3b82f6', hint: '文件' },
  dir: { color: '#d97706', hint: '目录' },
  code: { color: '#8b5cf6', hint: '源码位置' },
  terminal: { color: '#0ea5e9', hint: '终端输出' },
  agent: { color: '#10b981', hint: '协作 Agent' }
}

/** mention 在发送文本里的占位形式：@路径（源码位置带行号区间） */
export function mentionToken(mention: Mention): string {
  if (!mention.path) return mention.displayText
  if (mention.source === 'code' && mention.startLine) {
    const range =
      mention.endLine && mention.endLine !== mention.startLine
        ? `${mention.startLine}-${mention.endLine}`
        : `${mention.startLine}`
    return `@${mention.path}:${range}`
  }
  return `@${mention.path}`
}

/** 去掉路径前面的 @ 与工作区根前缀后展示的名字（取末两段，够辨识又不至于太长） */
export function formatPathDisplay(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) return normalized
  return parts.slice(-2).join('/')
}

interface MentionInputProps {
  value: string
  disabled?: boolean
  placeholder?: string
  onChange: (text: string, mentions: Mention[]) => void
  onSubmit: () => void
  /** 粘贴到剪贴板里的文件（截图/复制的文件），交给附件体系处理 */
  onPasteFiles: (files: File[]) => void
  /** 粘贴的文本超过阈值时交给附件体系落成「粘贴的文本-xxx.txt」；返回 true 表示已接管 */
  onPasteText?: (text: string) => boolean
  /**
   * @ 补全触发：光标前出现「@关键词」时回调关键词（可为空串），
   * 光标移开或关键词失效时回调 null。父组件据此弹出/关闭文件选择面板。
   */
  onMentionQuery?: (keyword: string | null) => void
}

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  function MentionInput(
    { value, disabled, placeholder, onChange, onSubmit, onPasteFiles, onPasteText, onMentionQuery },
    ref
  ): JSX.Element {
    const boxRef = useRef<HTMLDivElement>(null)
    // mention 列表与 DOM 里 chip 的顺序一致；chip 元素上用 data-mention-key 关联
    const mentionsRef = useRef<Map<string, Mention>>(new Map())
    const keySeqRef = useRef(0)
    /** 上一次序列化出的文本：用于区分「用户编辑」与「外部回填」 */
    const lastSerializedRef = useRef('')
    const composingRef = useRef(false)

    const serialize = useCallback((): { text: string; mentions: Mention[] } => {
      const box = boxRef.current
      if (!box) return { text: '', mentions: [] }
      let text = ''
      const mentions: Mention[] = []
      const walk = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent ?? ''
          return
        }
        if (!(node instanceof HTMLElement)) return
        if (node.tagName === 'BR') {
          text += '\n'
          return
        }
        if (node.tagName === 'DIV' || node.tagName === 'P') {
          // contenteditable 换行会产生块级元素
          if (text && !text.endsWith('\n')) text += '\n'
          node.childNodes.forEach(walk)
          return
        }
        const key = node.dataset?.mentionKey
        if (key) {
          const mention = mentionsRef.current.get(key)
          if (mention) {
            text += mentionToken(mention)
            mentions.push(mention)
            return
          }
        }
        node.childNodes.forEach(walk)
      }
      box.childNodes.forEach(walk)
      // 末尾换行是视觉残留，不算内容
      return { text: text.replace(/\n+$/, ''), mentions }
    }, [])

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
    const emitChange = useCallback(() => {
      if (composingRef.current) return
      dropEmptyResidue()
      const { text, mentions } = serialize()
      lastSerializedRef.current = text
      onChange(text, mentions)
    }, [onChange, serialize, dropEmptyResidue])

    const insertMention = useCallback(
      (mention: Mention) => {
        const box = boxRef.current
        if (!box) return
        const key = `m${++keySeqRef.current}`
        mentionsRef.current.set(key, mention)
        const chip = document.createElement('span')
        chip.className = `mention-chip mention-chip--${mention.source}`
        chip.contentEditable = 'false'
        chip.dataset.mentionKey = key
        chip.title = mention.path ? `${MENTION_META[mention.source].hint}：${mention.path}` : MENTION_META[mention.source].hint
        chip.textContent = mention.displayText

        const selection = window.getSelection()
        let range: Range | null = null
        if (selection && selection.rangeCount > 0) {
          const candidate = selection.getRangeAt(0)
          if (box.contains(candidate.commonAncestorContainer)) range = candidate
        }
        if (!range) {
          range = document.createRange()
          range.selectNodeContents(box)
          range.collapse(false)
        }
        range.deleteContents()
        range.insertNode(chip)
        // chip 后补一个空格文本节点，给光标一个落脚点，也让 chip 不与后续文字粘连
        const spacer = document.createTextNode(' ')
        chip.after(spacer)
        range.setStartAfter(spacer)
        range.collapse(true)
        selection?.removeAllRanges()
        selection?.addRange(range)
        box.focus()
        emitChange()
      },
      [emitChange]
    )

    const rebuildFromText = useCallback((text: string) => {
      const box = boxRef.current
      if (!box) return
      mentionsRef.current.clear()
      box.innerHTML = ''
      if (text) {
        // 按换行拆成 文本+br，避免用 innerHTML 引入转义问题
        const lines = text.split('\n')
        lines.forEach((line, index) => {
          if (index > 0) box.appendChild(document.createElement('br'))
          if (line) box.appendChild(document.createTextNode(line))
        })
      }
      lastSerializedRef.current = text
    }, [])

    /**
     * 检测光标前的「@关键词」触发段。
     * 规则：光标位于文本节点内，向左扫描到 '@' 为止；'@' 前一个字符必须是
     * 行首 / 空白 / 换行（避免把邮箱、代码里的装饰器误判成触发）；
     * 关键词不允许含空白。命中返回关键词文本（可为空串），否则 null。
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
      if (/[\s　@]/.test(keyword)) return null
      return keyword
    }, [])

    /** 光标变化（输入/点击/方向键）后同步 @ 触发状态给父组件 */
    const syncMentionQuery = useCallback(() => {
      if (!onMentionQuery) return
      onMentionQuery(composingRef.current ? null : detectMentionQuery())
    }, [onMentionQuery, detectMentionQuery])

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

    useImperativeHandle(
      ref,
      () => ({
        insertMention,
        completeMention,
        setText: (text: string) => {
          rebuildFromText(text)
          emitChange()
        },
        clear: () => {
          rebuildFromText('')
          emitChange()
        },
        focus: () => boxRef.current?.focus()
      }),
      [insertMention, completeMention, rebuildFromText, emitChange]
    )

    // 光标移动（点击/方向键）不产生 input 事件，用 selectionchange 补齐 @ 触发检测
    useEffect(() => {
      if (!onMentionQuery) return
      const handler = () => {
        const box = boxRef.current
        const selection = window.getSelection()
        if (!box || !selection || selection.rangeCount === 0) return
        if (!box.contains(selection.getRangeAt(0).startContainer)) return
        syncMentionQuery()
      }
      document.addEventListener('selectionchange', handler)
      return () => document.removeEventListener('selectionchange', handler)
    }, [onMentionQuery, syncMentionQuery])

    // 外部回填（撤回消息重新编辑等）：value 与内部序列化结果不一致时重建 DOM
    useEffect(() => {
      if (value === lastSerializedRef.current) return
      rebuildFromText(value)
    }, [value, rebuildFromText])

    return (
      <div
        ref={boxRef}
        className="chat__input mention-input"
        role="textbox"
        aria-multiline="true"
        contentEditable={disabled ? 'false' : 'true'}
        data-placeholder={placeholder ?? ''}
        onInput={() => {
          emitChange()
          syncMentionQuery()
        }}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          emitChange()
        }}
        onPaste={(event) => {
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
          if (onPasteText?.(text)) return
          document.execCommand('insertText', false, text)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onSubmit()
          }
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
