import { CommandJobCard } from './CommandJobCard'
import { exportCommandJob, visibleChildCommandJobs } from '@renderer/core/engine/command-job-state'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '@renderer/core/app-context'
import { useChat, type ChatMessage, type ToolActivity } from '@renderer/core/engine/useChat'
import { engineConnectionKey, engineStorageKey, getEngineSource } from '@renderer/core/engine/source'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { rootStatusLabel } from '@renderer/core/engine/root-run-state'
import { SessionTray } from './SessionTray'
import { FileChangeCard } from './FileChangeCard'
import { SubagentCard } from './SubagentCard'
import { exportSubagentDetails, toolStatusLabel } from '@renderer/core/engine/subagent-state'
import { Markdown } from './Markdown'
import { toolDisplayName, toolParamSummary, toolPathArg } from './tool-names'
import { useCollapseMemory } from './useCollapseMemory'
import { registerPendingSession, requestSessionListRefresh, touchPendingSession } from '../history/pending-sessions'
import { openFileFromChat } from './open-file'
import { useModels } from '@renderer/core/engine/model-store'
import { changeSecurityMode } from '@renderer/core/engine/security-store'
import { useMemoryScope } from '@renderer/core/engine/memory-store'
import { requestOrThrow } from '@renderer/core/engine/client'
import { utilityChat } from '@renderer/core/engine/utility-chat'
import { openAppSettings } from '@renderer/contrib/settings/app-settings-navigation'
import { refreshGit } from '@renderer/core/git/git-store'
import { currentWorkspacePaths, useWorkspace } from '@renderer/core/workspace/workspace-store'
import { Icon } from '@renderer/workbench/icons'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Popover } from '@renderer/workbench/Popover'
import { ContextMenu } from '@renderer/workbench/ContextMenu'
import { ModelPicker } from '../models/ModelPicker'
import { ComposerOptions } from './ComposerOptions'
import { MessageNavRail, type NavTurn } from './MessageNavRail'
import {
  asUsageFrame,
  formatDuration,
  formatTimestamp,
  formatTokens,
  groupIntoTurns,
  sumUsage,
  type UsageDetailRow
} from './usage'
import { useAttachments, shouldAttachPastedText, createPastedTextFile } from './useAttachments'
import { readFile } from '@renderer/core/workspace/fs-client'
import type { ChatAttachment } from '@renderer/core/engine/useChat'
import { Dialog } from '@renderer/workbench/Dialog'
import { getKnowledgeBaseBindingIds, saveKnowledgeBinding } from '@renderer/core/engine/knowledge'
import { ResourcePicker, type ResourceItem } from './ResourcePicker'
import './apple-chat-panels.css'

/** 上下文窗口估算基数：引擎未下发各模型窗口上限，按常见的 200k 估算占比 */
const CONTEXT_WINDOW_FALLBACK = 200_000

/** 消息窗口分页：只渲染尾部约 300 条消息（按轮次对齐切割），滚顶自动加载更早的 */
const MESSAGE_PAGE_SIZE = 300
/** 距顶多少 px 内触发加载更早消息 */
const LOAD_EARLIER_PX = 120

type ComposerResources = { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }
function resourceBindingKey(sessionId: string, source: string): string { return `aether:composer-resources:${source || 'embedded'}:${sessionId}` }
function loadComposerResources(sessionId: string, source: string): ComposerResources {
  try {
    const parsed = JSON.parse(localStorage.getItem(resourceBindingKey(sessionId, source)) || '{}') as Partial<ComposerResources>
    return { skills: Array.isArray(parsed.skills) ? parsed.skills.filter(v => typeof v === 'string') : [], mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers.filter(v => typeof v === 'string') : [], knowledgeBases: Array.isArray(parsed.knowledgeBases) ? parsed.knowledgeBases.filter(v => typeof v === 'string') : [] }
  } catch { return { skills: [], mcpServers: [], knowledgeBases: [] } }
}
function saveComposerResources(sessionId: string, source: string, value: ComposerResources): void {
  try { localStorage.setItem(resourceBindingKey(sessionId, source), JSON.stringify(value)) } catch { /* private browsing */ }
}

/** 按工作区相对路径读 base64 data URL（图片缩略图 / 放大查看共用） */
function useAttachmentImageSrc(root: string | null, file: ChatAttachment): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (root && file.type.startsWith('image/')) {
      void readFile(`${root}/${file.path}`)
        .then((result) => {
          if (alive && result.base64) setSrc(`data:${file.type};base64,${result.base64}`)
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [root, file.path, file.type])
  return src
}

/** 附件预览状态：图片带 data URL，文本附件由弹窗按路径回读内容 */
interface AttachmentPreview {
  file: ChatAttachment
  src: string | null
}

/** 统一附件查看组件：图片放大显示，文本附件显示内容；chip 与消息气泡共用 */
function AttachmentPreviewDialog({
  root,
  preview,
  onClose
}: {
  root: string | null
  preview: AttachmentPreview
  onClose: () => void
}): JSX.Element {
  const { file, src } = preview
  const isImage = file.type.startsWith('image/')
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!isImage && root) {
      void readFile(`${root}/${file.path}`)
        .then((result) => {
          if (alive) setText(result.truncated ? `${result.content}\n\n…（内容过长已截断）` : result.content)
        })
        .catch(() => {
          if (alive) setText('（读取失败）')
        })
    }
    return () => {
      alive = false
    }
  }, [isImage, root, file.path])

  return (
    <Dialog title={file.name} className="modal--image-preview" width={860} onClose={onClose}>
      {isImage ? (
        <div className="image-preview">
          {src ? <img src={src} alt={file.name} /> : <span className="image-preview__loading">加载中…</span>}
        </div>
      ) : (
        <pre className="attachment-text-preview">{text ?? '加载中…'}</pre>
      )}
    </Dialog>
  )
}

/** 附件 chip：图片只显示缩略图（点击放大），文本类可点击查看内容，其它显示图标 + 名称 */
function AttachmentChip({
  root,
  file,
  onRemove,
  onPreview
}: {
  root: string | null
  file: ChatAttachment
  onRemove?: () => void
  onPreview: (file: ChatAttachment, src: string | null) => void
}): JSX.Element {
  const isImage = file.type.startsWith('image/')
  const isText = !isImage && (file.type.startsWith('text/') || /\.(txt|md|markdown|json|jsonc|log|csv|tsv|xml|ya?ml|toml|ini)$/i.test(file.name))
  const src = useAttachmentImageSrc(root, file)

  if (isImage && src) {
    return (
      <span className="attach-chip attach-chip--image" title={file.path}>
        <button
          type="button"
          className="attach-chip__image-btn"
          title={`点击查看 ${file.name}`}
          onClick={() => onPreview(file, src)}
        >
          <img className="attach-chip__thumb" src={src} alt={file.name} />
        </button>
        {onRemove ? (
          <button
            type="button"
            className="attach-chip__remove"
            title="移除附件"
            aria-label={`移除附件 ${file.name}`}
            onClick={onRemove}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </span>
    )
  }

  const body = (
    <>
      <Icon name={isImage ? 'image' : 'file'} size={16} />
      <span className="attach-chip__name">{file.name}</span>
      {file.size > 0 ? <span className="attach-chip__size">{formatBytes(file.size)}</span> : null}
    </>
  )

  return (
    <span className={`attach-chip${isText ? ' attach-chip--clickable' : ''}`} title={file.path}>
      {isText ? (
        <button
          type="button"
          className="attach-chip__open"
          title={`查看 ${file.name}`}
          onClick={() => onPreview(file, null)}
        >
          {body}
        </button>
      ) : (
        <>{body}</>
      )}
      {onRemove ? (
        <button
          type="button"
          className="attach-chip__remove"
          title="移除附件"
          aria-label={`移除附件 ${file.name}`}
          onClick={onRemove}
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </span>
  )
}
import { MentionInput, type Mention, type MentionInputHandle } from './MentionInput'
import { loadChatDraftState, saveChatDraft } from './draft-store'
import {
  MENTION_META,
  buildMentionMessage,
  mentionTitle,
  parseMentionContent,
  preserveMentions,
  userMessageDraft,
  userMessageText,
  type PromptRef
} from './mention-context'
import { FileRefPalette } from './FileRefPalette'
import { consumePendingMentions, subscribePendingMentions } from './pending-mentions'

function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`
}

/**
 * 设置档位 → 引擎 thinkingMode 参数。
 *
 * 'off' 强制下发 false（显式关思考）；'high' 落成 undefined（引擎按模型
 * 能力判断）；'low' / 'max' 下发档位字符串（引擎强制开启并指定 effort）。
 */
function resolveThinkingMode(mode: 'off' | 'low' | 'high' | 'max'): 'low' | 'high' | false | undefined {
  if (mode === 'off') return false
  if (mode === 'high') return undefined
  return mode === 'max' ? 'high' : 'low'
}

/** 字节数 → 人类可读（附件条上展示大小） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 对话视图（P0 核心）
 *
 * 只依赖 useChat 暴露的抽象，不直接接触 IPC / SSE —— 因此后续换成
 * 多会话、多 Agent、附件等能力时，改动集中在 hook 层。
 */
export function ChatView(): JSX.Element {
  const { engine, ready, settings, updateSettings, settingsLoaded } = useApp()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  const canExecute = ready
  const connectionKey = engineConnectionKey(engine.snapshot)
  const storageSource = engineStorageKey(engine.snapshot)
  const sourceEpoch = getEngineSource()
  const { messages, commandJobs, streaming, historyCompacted, loadArchive, todos, send, respond, abort, loadHistory, resumeStream, deleteTurn, retryFrom, revertFrom, queue, removeQueued, clearQueue, flushQueue, updateQueued, moveQueued, queueSendMode, setQueueSendMode, retargetQueuedModel } = useChat()
  const { models, loaded: modelsLoaded } = useModels()
  const workspace = useWorkspace()
  // 会话 ID 首次使用时生成并持久化，保证多轮对话共享上下文。
  // 必须等设置加载完成再决定：设置未就绪时 lastSessionId 是空默认值，
  // 此时直接生成新 ID 会把磁盘上的持久化会话覆盖掉（历史随之丢失）
  const sessionId = useMemo(() => {
    if (!settingsLoaded) return ''
    if (settings.lastSessionId) return settings.lastSessionId
    const generated = newSessionId()
    void updateSettings({ lastSessionId: generated })
    return generated
  }, [settings.lastSessionId, settingsLoaded, updateSettings])
  const {
    scope: memorySettingsScope,
    loaded: memorySettingsLoaded
  } = useMemoryScope(sessionId)
  const codegraphRoot = remoteReadOnly ? settings.remoteWorkspaceRoot.trim() || undefined : workspace.root || undefined
  const [input, setInput] = useState('')
  /** 同步记录编辑器的最新文本，避免润色请求返回时覆盖用户刚刚的修改。 */
  const inputValueRef = useRef('')
  useEffect(() => {
    inputValueRef.current = input
  }, [input])
  /** AI 润色进行中（禁用润色按钮，防止重复点击） */
  const [polishing, setPolishing] = useState(false)
  /** 输入框里的引用 chip（文件/目录/源码/终端），由 MentionInput 序列化时同步 */
  const mentionsRef = useRef<Mention[]>([])
  /** 多选模式：按消息粒度勾选，复制或导出为 Markdown */
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  /** 轻提示（复制 / 导出等即时反馈），短暂展示后自动消失 */
  const [toast, setToast] = useState<string | null>(null)
  /** 用户手动选择的模型；null 表示未选择，跟随设置（设置异步加载后自动生效） */
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const modelId = selectedModelId ?? settings.lastModelId
  const activeSessionIdRef = useRef('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<MentionInputHandle>(null)
  /** @ 触发的内联补全关键词；null 表示未触发（光标不在 @ 段内） */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  /** / 资源菜单触发的关键词；选择后绑定到本轮会话并显示为资源 chip。 */
  const [resourceQuery, setResourceQuery] = useState<string | null>(null)
  const [composerResources, setComposerResources] = useState<ComposerResources>({ skills: [], mcpServers: [], knowledgeBases: [] })
  /** Last input snapshot used to detect a user deleting a /resource token manually. */
  const resourceTextRef = useRef('')
  /** Clearing the editor after send must not clear the session's resource bindings. */
  const suppressResourceReconcileRef = useRef(false)
  /** 「+」菜单里手动打开的工作空间选择面板（与 @ 补全共用 FileRefPalette） */
  const [manualPalette, setManualPalette] = useState(false)
  /** 「+」按钮弹出的附件/引用菜单（视口坐标） */
  const [attachMenu, setAttachMenu] = useState<{ x: number; y: number } | null>(null)
  // 附件：落盘到当前工作区，发送时把相对路径交给引擎（图片→视觉/OCR，文本→smart_read）
  const attach = useAttachments(workspace.root, sessionId)
  // 附件进度提示只在出现后短暂停留，避免常驻噪音
  const [attachHint, setAttachHint] = useState<string | null>(null)
  /** 附件点击预览（图片放大 / 文本查看，统一 AttachmentPreviewDialog） */
  const [previewImage, setPreviewImage] = useState<AttachmentPreview | null>(null)

  /** AI 润色输入框内容：用轻任务模型改写得更清晰；chip 引用会随文本一起被序列化给模型 */
  const handlePolish = async (): Promise<void> => {
    const text = input.trim()
    if (!canExecute || polishing || !text) return
    const requestSessionId = sessionId
    activeSessionIdRef.current = requestSessionId
    setPolishing(true)
    try {
      const res = await utilityChat({
        // 轻任务模型为空时跟随当前主对话模型。
        model: settings.utilityModelId || modelId || undefined,
        systemPrompt:
          '你是「发给 AI 编程助手的指令」的润色器。把用户的草稿改写得更清晰、具体、可执行：' +
          '补全主语和对象、拆开含糊的复合要求、修正错别字；保留原文中的 @路径 引用 token 原样不动；' +
          '保持用户原语言；不要添加用户没说的需求；只输出润色后的文本本身，不要解释、不要引号。',
        userPrompt: text,
        temperature: 0.3,
        maxTokens: 1500
      })
      // Utility calls are independent, one-shot requests. A background engine
      // reconnect may advance its generation while the request is in flight;
      // do not discard a valid result when the user is still in this session.
      if (activeSessionIdRef.current !== requestSessionId) return
      // 请求期间用户可能已经继续编辑；此时丢弃旧结果，绝不能覆盖新草稿。
      if (inputValueRef.current.trim() !== text) return
      const polished = res.text.trim()
      if (polished && polished !== text) {
        const draft = preserveMentions(polished, mentionsRef.current)
        mentionsRef.current = draft.mentions
        resourceTextRef.current = draft.text
        inputValueRef.current = draft.text
        inputRef.current?.setDraft(draft.text, draft.mentions)
        setInput(draft.text)
        scheduleDraftSave(draft.text)
        inputRef.current?.focus()
      } else {
        setToast('润色结果与原文一致')
      }
    } catch (err) {
      if (activeSessionIdRef.current !== requestSessionId) return
      setToast(err instanceof Error ? `润色失败：${err.message}` : '润色失败，请稍后重试')
    } finally {
      if (activeSessionIdRef.current === requestSessionId) setPolishing(false)
    }
  }

  const clearAttachments = attach.clear
  const setAttachmentDragging = attach.setDragging
  useEffect(() => {
    clearAttachments()
    setAttachmentDragging(false)
    mentionsRef.current = []
    setMentionQuery(null)
    setResourceQuery(null)
    setComposerResources({ skills: [], mcpServers: [], knowledgeBases: [] })
    resourceTextRef.current = ''
    setManualPalette(false)
    setAttachMenu(null)
    setPreviewImage(null)
    setPolishing(false)
  }, [connectionKey, sourceEpoch, clearAttachments, setAttachmentDragging])

  // 会话累计用量：按消息里的 usage 帧汇总，作为工具栏「模型 / Token / 使用时间」的数据源
  const usageTotal = useMemo(() => sumUsage(messages), [messages])
  // 上下文占用：最近一轮 usage 的 currentPromptTokens（最后一次模型调用的真实输入，
  // 压缩后下一轮自然回落）。老引擎没有该字段时回退 promptTokens（跨迭代累加值，仅兜底）。
  const contextUsed = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const frame = asUsageFrame(messages[i].usage)
      if (frame?.currentPromptTokens) return frame.currentPromptTokens
      if (frame?.promptTokens) return frame.promptTokens
    }
    return 0
  }, [messages])
  // 用量环分母：usage 帧里引擎解析出的窗口 > 模型列表能力表 > 200k 兜底
  const contextLimit = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const frame = asUsageFrame(messages[i].usage)
      if (frame?.contextWindow) return frame.contextWindow
    }
    return (
      models.find((model) => model.modelId === ([...messages].reverse().find(message => message.modelId)?.modelId ?? modelId))?.capabilities?.contextWindow ??
      CONTEXT_WINDOW_FALLBACK
    )
  }, [messages, models, modelId])
  // 按用户提问切分轮次：每轮末尾展示「一问一答」的累计 token
  const turns = useMemo(() => groupIntoTurns(messages), [messages])

  // ── 消息窗口分页 ────────────────────────────────────────────────────────────
  // 长会话（几百上千条消息）一次全量渲染会让 DOM 规模爆炸、切换会话卡顿。
  // 只渲染尾部约 MESSAGE_PAGE_SIZE 条消息（按轮次边界切，不切断一问一答），
  // 滚到顶部附近时自动向前加载一页。窗口在会话内只增不减（流式追加不收缩，
  // 避免阅读中途内容被挤走）；切换会话时重置。
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  const { visibleTurns, hiddenTurnCount } = useMemo(() => {
    if (turns.length === 0) return { visibleTurns: turns, hiddenTurnCount: 0 }
    let count = 0
    let start = turns.length
    while (start > 0 && count < visibleCount) {
      start -= 1
      count += turns[start].messages.length
    }
    return { visibleTurns: turns.slice(start), hiddenTurnCount: start }
  }, [turns, visibleCount])
  /** 向前加载一页前的滚动快照：加载后用来补偿 scrollTop，防止视口跳动 */
  const prependSnapshotRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const hiddenTurnCountRef = useRef(hiddenTurnCount)
  hiddenTurnCountRef.current = hiddenTurnCount
  const loadEarlier = useCallback(() => {
    if (hiddenTurnCountRef.current === 0) return
    const el = scrollRef.current
    if (el) prependSnapshotRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    setVisibleCount((count) => count + MESSAGE_PAGE_SIZE)
  }, [])
  // 前插加载完成后做 scrollTop 补偿：新内容插在顶部，视口要往下推同样的高度差
  useLayoutEffect(() => {
    const snapshot = prependSnapshotRef.current
    const el = scrollRef.current
    if (!snapshot || !el) return
    prependSnapshotRef.current = null
    el.scrollTop = snapshot.scrollTop + (el.scrollHeight - snapshot.scrollHeight)
  }, [visibleTurns])
  // 左侧导航栏的条目：每条用户消息一个圆点（turn.id 即首条用户消息 ID）
  const navTurns = useMemo<NavTurn[]>(
    () =>
      turns
        .map((turn) => {
          const message = turn.messages.find((m) => m.role === 'user')
          if (!message) return null
          return {
            id: turn.id,
            message,
          // 预览用可读正文：协议注释里的下标会让纯文本预览出现一串花括号
          preview: userMessageText(message.content).replace(/\s+/g, ' ').slice(0, 60)
          }
        })
        .filter((item): item is NavTurn => item !== null),
    [turns]
  )

  useEffect(() => {
    activeSessionIdRef.current = sessionId
  }, [sessionId])

  const sourceSessionKey = JSON.stringify([connectionKey, sourceEpoch, sessionId])
  const displayedSessionRef = useRef(sourceSessionKey)
  useLayoutEffect(() => { displayedSessionRef.current = sourceSessionKey }, [sourceSessionKey])

  useEffect(() => {
    if (!sessionId) return
    const stored = loadComposerResources(sessionId, storageSource)
    // Restore knowledge-base bindings into the slash resource state so persisted
    // session selections continue to be sent even though the composer stays compact.
    const knowledgeBases = getKnowledgeBaseBindingIds(sessionId, storageSource)
    setComposerResources({ ...stored, knowledgeBases: knowledgeBases.length ? knowledgeBases : stored.knowledgeBases })
    // The input draft is restored by the following effect. Reset this edge detector
    // here so a session/source switch cannot remove bindings from the new session.
    resourceTextRef.current = ''
  }, [sessionId, storageSource, sourceEpoch])

  const updateComposerResources = useCallback((next: ComposerResources): void => {
    setComposerResources(next)
    if (sessionId) saveComposerResources(sessionId, storageSource, next)
  }, [sessionId, storageSource])

  const chooseComposerResource = useCallback((item: ResourceItem): void => {
    const key = item.kind === 'skill' ? 'skills' : item.kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const current = item.kind === 'kb' ? getKnowledgeBaseBindingIds(sessionId, storageSource) : composerResources[key]
    // A binding is session-scoped. Selecting the same row again should focus the
    // existing chip instead of appending a second raw `/kind:id` token that cannot
    // be removed independently from the single binding entry.
    if (current.includes(item.id)) {
      // The binding already exists (for example, selected through the dedicated
      // KB picker), but the slash query still needs to be consumed from the draft.
      suppressResourceReconcileRef.current = true
      inputRef.current?.completeSlash(`/${item.kind}:${item.id}`)
      suppressResourceReconcileRef.current = false
      inputRef.current?.focus()
      setResourceQuery(null)
      return
    }
    const next = current.includes(item.id) ? current : [...current, item.id]
    updateComposerResources({ ...composerResources, [key]: next })
    if (item.kind === 'kb' && sessionId) saveKnowledgeBinding(sessionId, next, storageSource)
    suppressResourceReconcileRef.current = true
    inputRef.current?.completeSlash(`/${item.kind}:${item.id}`)
    suppressResourceReconcileRef.current = false
    setResourceQuery(null)
  }, [composerResources, sessionId, storageSource, updateComposerResources])

  /** Remove bindings whose slash token the user deleted from the draft. */
  const reconcileComposerResources = useCallback((text: string): void => {
    const previous = resourceTextRef.current
    resourceTextRef.current = text
    if (suppressResourceReconcileRef.current || !previous || !sessionId) return
    const removed: Array<{ kind: 'skill' | 'mcp' | 'kb'; id: string }> = []
    const inspect = (kind: 'skill' | 'mcp' | 'kb', ids: readonly string[]): void => {
      for (const id of ids) {
        const token = `/${kind}:${id}`
        if (previous.includes(token) && !text.includes(token)) removed.push({ kind, id })
      }
    }
    inspect('skill', composerResources.skills)
    inspect('mcp', composerResources.mcpServers)
    inspect('kb', composerResources.knowledgeBases)
    if (!removed.length) return
    setComposerResources(current => {
      let next = current
      for (const { kind, id } of removed) {
        const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
        const values = next[key].filter(value => value !== id)
        if (values !== next[key]) next = { ...next, [key]: values }
        if (kind === 'kb') saveKnowledgeBinding(sessionId, values, storageSource)
      }
      saveComposerResources(sessionId, storageSource, next)
      return next
    })
  }, [composerResources.knowledgeBases, composerResources.mcpServers, composerResources.skills, sessionId, storageSource])

  const removeComposerResource = useCallback((kind: 'skill' | 'mcp' | 'kb', id: string): void => {
    const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const next = composerResources[key].filter(item => item !== id)
    updateComposerResources({ ...composerResources, [key]: next })
    inputRef.current?.removeTextToken(`/${kind}:${id}`)
    if (kind === 'kb') saveKnowledgeBinding(sessionId, next, storageSource)
  }, [composerResources, sessionId, storageSource, updateComposerResources])

  // 切换会话时重置分页窗口（sessionId 声明之后，依赖其值）
  useEffect(() => {
    setVisibleCount(MESSAGE_PAGE_SIZE)
  }, [sessionId])

  // 启动 / 会话切换时回放引擎侧历史：conversations 表本来是 AI 的上下文来源，
  // 把同一份数据还原到界面，解决「重启后界面空白但 AI 记得一切」的割裂感
  const historyLoadedRef = useRef('')
  useEffect(() => {
    if (!ready) { historyLoadedRef.current = ''; return }
    if (!sessionId) return
    if (historyLoadedRef.current === sourceSessionKey) return
    historyLoadedRef.current = sourceSessionKey
    // 优先尝试恢复正在进行的流（刷新/切回会话后端仍在跑的场景）；
    // resumeStream 内部会先做历史回放，无需恢复时返回 false，再退回纯历史回放
    void resumeStream(sessionId)
  }, [ready, sessionId, sourceSessionKey, loadHistory, resumeStream])

  // ── 每会话输入草稿（对齐 wuzu lobster-chat:draft）──
  // 切会话/重启时恢复该会话未发送的草稿；保存走防抖，不用 effect 持久化
  // （避免会话切换瞬间把旧会话文本写进新会话槽位）。
  const draftSessionRef = useRef('')
  const draftTimerRef = useRef(0)
  const pendingDraftSaveRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current?.()
    pendingDraftSaveRef.current = null
    if (!sessionId || draftSessionRef.current === sourceSessionKey) return
    draftSessionRef.current = sourceSessionKey
    const draft = loadChatDraftState(sessionId, storageSource)
    mentionsRef.current = draft.mentions
    inputRef.current?.setDraft(draft.text, draft.mentions)
    setInput(draft.text)
  }, [sessionId, sourceSessionKey, storageSource])
  useEffect(() => () => {
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current?.()
  }, [])

  // 先恢复草稿再插入新引用，避免打开隐藏的对话面板时被恢复 effect 覆盖。
  useEffect(() => {
    const drain = (): void => {
      if (!sessionId || remoteReadOnly || sourceEpoch !== getEngineSource() || !inputRef.current) return
      const queue = consumePendingMentions()
      for (const mention of queue) inputRef.current.insertMention(mention)
      if (queue.length) inputRef.current.focus()
    }
    drain()
    return subscribePendingMentions(drain)
  }, [sessionId, remoteReadOnly, sourceEpoch])

  /** 用户编辑后防抖保存草稿（仅 onChange 路径，程序化 setInput 由调用方自行保存） */
  const scheduleDraftSave = useCallback(
    (text: string) => {
      window.clearTimeout(draftTimerRef.current)
      if (!sessionId || sourceEpoch !== getEngineSource()) return
      const mentions = [...mentionsRef.current]
      const persist = (): void => saveChatDraft(sessionId, text, storageSource, mentions)
      pendingDraftSaveRef.current = persist
      draftTimerRef.current = window.setTimeout(() => {
        pendingDraftSaveRef.current = null
        persist()
      }, 400)
    },
    [sessionId, sourceEpoch, storageSource]
  )

  // ── 吸底跟随（对齐 wuzu-client CliChatView）──
  // followBottom 只由真实用户手势切换，不听 scroll 事件：程序化滚动
  // （scrollTop = scrollHeight）也触发 scroll，用它判定会在流式期间误关跟随。
  const [followBottom, setFollowBottom] = useState(true)
  // 非跟随期间来了新内容 → 显示「回到底部」按钮
  const [hasNewWhileUnfollowed, setHasNewWhileUnfollowed] = useState(false)
  /** 使 pending 的 rAF 滚动回调作废的计数器：用户离开吸底后，旧滚动不再执行 */
  const scrollGenerationRef = useRef(0)
  /** 对齐 Wuzu：距底 8px 内才恢复跟随；较大的距离只用于显示回到底部按钮。 */
  const RESUME_FOLLOW_PX = 8
  const SHOW_BACK_TO_BOTTOM_PX = 80

  const measureDistToBottom = useCallback((): number => {
    const el = scrollRef.current
    if (!el) return 0
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }, [])

  const resumeFollowBottom = useCallback((): void => {
    scrollGenerationRef.current += 1
    setFollowBottom(true)
    setHasNewWhileUnfollowed(false)
  }, [])

  const scrollToBottom = useCallback(
    (force = false) => {
      const el = scrollRef.current
      if (!el) return
      if (!force && !followBottom) {
        // 非跟随时不滚动，按实际距离决定「回到底部」按钮浮不浮出
        setHasNewWhileUnfollowed(measureDistToBottom() > SHOW_BACK_TO_BOTTOM_PX)
        return
      }
      const generation = scrollGenerationRef.current
      // 先贴一次，再连续两帧贴底：覆盖「DOM 已插入但布局未撑开」的异步布局，
      // 每一帧都检查 generation，防止用户上翻后被旧的自动滚动拉回。
      requestAnimationFrame(() => {
        if (scrollGenerationRef.current !== generation) return
        el.scrollTop = el.scrollHeight
        requestAnimationFrame(() => {
          if (scrollGenerationRef.current === generation) el.scrollTop = el.scrollHeight
        })
      })
      el.scrollTop = el.scrollHeight
    },
    [followBottom, measureDistToBottom]
  )

  // 用户手势离开吸底：只认「向上滚轮」与「按在滚动容器本身（滚动条）上」。
  // 点消息内部不算 —— 否则点气泡里的按钮会被误判为离开底部。
  const handleListWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      // 思考正文有自己的滚动区域；上翻它不能改变外层消息列表的跟随状态。
      if ((event.target as HTMLElement).closest('.logline__detail--thinking')) return
      if (event.deltaY >= 0) return
      const el = scrollRef.current
      if (!el || el.scrollHeight <= el.clientHeight) return
      scrollGenerationRef.current += 1
      setFollowBottom(false)
    },
    []
  )

  const handleListPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const el = scrollRef.current
    if (!el || el.scrollHeight <= el.clientHeight) return
    scrollGenerationRef.current += 1
    setFollowBottom(false)
  }, [])

  // 滚回底部附近（含拖动滚动条）时恢复跟随；滚到顶部附近时加载更早的消息
  const handleListScroll = useCallback(() => {
    if (measureDistToBottom() < RESUME_FOLLOW_PX) resumeFollowBottom()
    const el = scrollRef.current
    if (el && el.scrollTop < LOAD_EARLIER_PX) loadEarlier()
  }, [measureDistToBottom, resumeFollowBottom, loadEarlier])

  // 新内容到达时：跟随态保持贴底；非跟随态只更新「回到底部」按钮显隐。
  // followBottom 为 true 时传 force：80ms 节流攒批可能让首帧延迟，期间 scrollHeight 尚未撑开，
  // 非 force 的 scrollToBottom 会量到旧高度提前 return；force 分支用 rAF 在下一帧再贴一次兜底。
  useEffect(() => {
    scrollToBottom(followBottom)
  }, [messages, scrollToBottom, followBottom])

  // 切换会话或引擎来源时恢复 Wuzu 的默认状态：新会话第一次渲染始终从底部开始，
  // 不继承上一个会话用户上翻后的暂停状态。
  useEffect(() => {
    scrollGenerationRef.current += 1
    const generation = scrollGenerationRef.current
    setFollowBottom(true)
    setHasNewWhileUnfollowed(false)
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el || scrollGenerationRef.current !== generation) return
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        if (scrollGenerationRef.current === generation) el.scrollTop = el.scrollHeight
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [sessionId, sourceEpoch])

  // 回到底部按钮：立即贴底并恢复跟随
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    scrollGenerationRef.current += 1
    setHasNewWhileUnfollowed(false)
    el.scrollTop = el.scrollHeight
    resumeFollowBottom()
  }, [resumeFollowBottom])

  const showBackToBottom = !followBottom && hasNewWhileUnfollowed

  // 输入框高度随内容增长：contenteditable 交给 CSS（max-height + overflow），无需 JS 撑高

  // 一轮对话结束（完成/中止/出错）时刷新 git：Agent 改了哪些文件此刻刚落盘定局。
  // refreshGit 是模块级函数（引用恒定），不属于 hook 依赖
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (!remoteReadOnly && wasStreaming.current && !streaming) void refreshGit(workspace.root)
    wasStreaming.current = streaming
  }, [streaming, workspace.root, remoteReadOnly])

  const selectModel = useCallback(
    (next: string) => {
      setSelectedModelId(next)
      void updateSettings({ lastModelId: next })
      // 运行中切换模型：把队列里待发消息的模型改写为新模型，
      // 避免出现「正在运行的回合显示成输入框后选的模型」这类错标
      retargetQueuedModel(next)
    },
    [updateSettings, retargetQueuedModel]
  )

  // 默认选中：列表就绪后，若当前模型未选中或已失效（被删/改名），自动落到第一个
  const modelExists = models.some((model) => model.modelId === modelId)
  useEffect(() => {
    if (!modelsLoaded || models.length === 0 || modelExists) return
    selectModel(models[0].modelId)
  }, [modelsLoaded, models, modelExists, selectModel])

  /** 附件失败提示：短暂展示后自动消失，不打扰后续输入 */
  useEffect(() => {
    if (!attach.error) {
      setAttachHint(null)
      return
    }
    setAttachHint(attach.error)
    attach.clearError()
    const timer = window.setTimeout(() => setAttachHint(null), 5000)
    return () => window.clearTimeout(timer)
  }, [attach])

  const buildSendOptions = useCallback(
    () => ({
      sessionId,
      agentId: settings.lastAgentId || undefined,
      model: modelId || undefined,
      knowledgeBases: getKnowledgeBaseBindingIds(sessionId, storageSource),
      skills: composerResources.skills,
      mcpServers: composerResources.mcpServers,
      // 按用途指派：子代理 / 轻任务模型（空 = 跟随主模型，引擎侧回退）
      subagentModel: settings.subagentModelId || undefined,
      utilityModel: settings.utilityModelId || undefined,
      // Do not guess global while the engine has not confirmed this session's
      // setting. Sending off is the safe compatibility behavior for old sessions.
      memoryScope: memorySettingsLoaded ? (memorySettingsScope ?? 'off') : 'off',
      // 从 store 直接读取而非依赖闭包：发送瞬间的根目录才是准确的
      workspacePaths: remoteReadOnly ? [] : currentWorkspacePaths(),
      thinkingMode: resolveThinkingMode(settings.thinkingMode)
    }),
    [modelId, remoteReadOnly, sessionId, storageSource, composerResources, memorySettingsLoaded, memorySettingsScope, settings.lastAgentId, settings.subagentModelId, settings.utilityModelId, settings.thinkingMode]
  )

  const submit = useCallback(() => {
    // When the slash palette is open, Enter belongs to palette selection;
    // ResourcePicker's document listener consumes it after this guard.
    if (resourceQuery !== null) return
    const text = input.trim()
    // 允许「只发附件」：丢张截图直接问，是视觉模型的常见用法
    const files = attach.attachments
    if ((!text && files.length === 0) || attach.uploading || !canExecute || !sessionId || sourceEpoch !== getEngineSource()) return
    // 流式进行中不再拦截：send 内部会入队，当前流结束后自动按序发出
    // Mentions are workspace-relative.  They are safe for remote sessions;
    // the main-process remote adapter strips local paths and resolves them
    // against the session-bound server workspace.
    const message = buildMentionMessage(text, mentionsRef.current)
    setInput('')
    mentionsRef.current = []
    // Clearing the editor after a send is not a user deletion. Keep the
    // session-scoped resource bindings and only reset the edge detector.
    suppressResourceReconcileRef.current = true
    inputRef.current?.clear()
    suppressResourceReconcileRef.current = false
    resourceTextRef.current = ''
    attach.clear()
    // 发送成功后该会话草稿即作废
    window.clearTimeout(draftTimerRef.current)
    pendingDraftSaveRef.current = null
    saveChatDraft(sessionId, '', storageSource)
    // 占位条目（若该会话是本次新建的）刷新时间戳，继续待在列表顶部；
    // 引擎落库后由列表侧的 prune 让它退场
    touchPendingSession(sessionId)
    // 发送是用户主动发起的「看最新输出」动作：无条件吸底（覆盖任何此前上滚导致的非跟随态），
    // 否则 80ms 流式节流窗口内 followBottom 已是 false 时整轮都不再跟随
    resumeFollowBottom()
    void send(message, {
      ...buildSendOptions(),
      attachments: files.length > 0 ? files : undefined
    })
    scrollToBottom(true)
  }, [attach, buildSendOptions, input, canExecute, sourceEpoch, storageSource, send, sessionId, resumeFollowBottom, scrollToBottom, resourceQuery])

  /** 托盘的「发送」：空闲时按当前模式（逐条/合并）立即发出队列 */
  const flushQueueFromTray = useCallback(() => {
    if (!canExecute || !sessionId || sourceEpoch !== getEngineSource()) return
    void flushQueue()
  }, [flushQueue, canExecute, sessionId, sourceEpoch])

  /**
   * 授权卡片上的「一路放行」入口。
   *
   * 只切模式不动当前这一步是没用的：引擎已经对本次调用下了 ask 决定并在等应答，
   * 切模式不会让挂起的流自己恢复。所以调用方要「先切模式、再放行」——
   * 切模式保证恢复后的后续命令不再被拦，放行用于解开眼前这一次。
   */
  const allowAllForSession = useCallback(
    async () => {
      if (!canExecute || sourceEpoch !== getEngineSource()) throw new Error('当前连接不能修改安全模式')
      await changeSecurityMode(sessionId, 'full-access')
      if (sourceEpoch !== getEngineSource()) throw new Error('引擎连接已变化，请在当前会话重试')
    },
    [canExecute, sessionId, sourceEpoch]
  )

  /**
   * 新建会话：换上新的会话 ID 即开一条全新对话。
   *
   * 不引入会话对象：sessionId 本就跟随 settings.lastSessionId，换 ID 后
   * 上面的回放 effect 会重新取历史（新 ID 无记录 → 空对话）。
   * 若正有流在跑先中止，避免把上一会话的输出写进新会话里。
   */
  const createSession = useCallback(() => {
    if (!canExecute || sourceEpoch !== getEngineSource()) return
    if (streaming) abort()
    const generated = newSessionId()
    // 引擎只列举「有对话记录」的会话，空会话不出现在列表里；
    // 先登记本地占位条目，让新建的会话在侧栏立刻可见
    registerPendingSession(generated)
    void updateSettings({ lastSessionId: generated })
  }, [abort, streaming, updateSettings, canExecute, sourceEpoch])

  // 回合结束（流式停止）时通知会话列表重新拉取：首条消息落库后引擎才开始
  // 返回该会话，此时 lastSessionId 没变、列表页的刷新 effect 不会触发，
  // 占位条目需要这次信号才能退场换成真条目（时间/摘要有真实数据）
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) requestSessionListRefresh()
    wasStreamingRef.current = streaming
  }, [streaming])

  // ── 多选导出 ────────────────────────────────────────────────────────────────
  const toggleSelectMode = useCallback(() => {
    setSelectMode((value) => !value)
    setSelectedIds(new Set())
  }, [])

  const toggleMessage = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const allSelected = messages.length > 0 && messages.every((m) => selectedIds.has(m.id))
  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(messages.map((m) => m.id)))
  }, [allSelected, messages])

  /** 选中内容按会话时间顺序（而非点击顺序）序列化成 Markdown */
  const buildExportText = useCallback(() => {
    const picked = messages.filter((m) => selectedIds.has(m.id))
    return serializeMessages(picked)
  }, [messages, selectedIds])

  const copySelected = useCallback(() => {
    const text = buildExportText()
    if (!text) return
    void navigator.clipboard.writeText(text).then(
      () => {
        setToast(`已复制 ${selectedIds.size} 项`)
        // 复制是这一步的终点：退出多选，回到正常阅读状态
        setSelectMode(false)
        setSelectedIds(new Set())
      },
      () => setToast('复制失败')
    )
  }, [buildExportText, selectedIds])

  // ── 消息级操作（hover 工具条）─────────────────────────────────────────────
  const copyMessage = useCallback((message: ChatMessage) => {
    void navigator.clipboard.writeText(serializeMessages([message])).then(
      () => setToast('已复制'),
      () => setToast('复制失败')
    )
  }, [])

  /** 轻提示：出现后短暂停留自动消失，不打断后续操作 */
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  /** 错误提示（替代 window.alert，主题化展示） */
  const showError = useCallback((err: unknown, prefix?: string) => {
    const message = err instanceof Error ? err.message : String(err)
    void confirmDialog({
      title: '操作失败',
      body: prefix ? `${prefix}${message}` : message,
      confirmText: '知道了'
    })
  }, [])

  /** 删除引擎侧该消息之后的历史并重新发送（重新发送 / 重新生成共用） */
  const retryTurn = useCallback(
    (message: ChatMessage) => {
      if (!canExecute || sourceEpoch !== getEngineSource()) return
      // 重新生成（助手消息）等价于从它前面的用户提问处重发
      const index = messages.findIndex((m) => m.id === message.id)
      const userMessage =
        message.role === 'user' ? message : messages.slice(0, index).reverse().find((m) => m.role === 'user')
      if (!userMessage) return
      void confirmDialog({
        title: message.role === 'user' ? '重新发送' : '重新生成',
        body: message.role === 'user' ? '删除此后的对话并重新发送？' : '删除本轮回答并重新生成？',
        danger: true
      }).then((confirmed) => {
        if (!confirmed || sourceEpoch !== getEngineSource()) return
        void retryFrom(userMessage, {
          sessionId,
          agentId: settings.lastAgentId || undefined,
          model: modelId || undefined,
          knowledgeBases: getKnowledgeBaseBindingIds(sessionId, storageSource),
          skills: composerResources.skills,
          mcpServers: composerResources.mcpServers,
          subagentModel: settings.subagentModelId || undefined,
          utilityModel: settings.utilityModelId || undefined,
          memoryScope: memorySettingsLoaded ? (memorySettingsScope ?? 'off') : 'off',
          workspacePaths: remoteReadOnly ? [] : currentWorkspacePaths(),
          thinkingMode: resolveThinkingMode(settings.thinkingMode)
        }).catch(showError)
      })
    },
    [canExecute, remoteReadOnly, sourceEpoch, messages, modelId, retryFrom, sessionId, storageSource, composerResources, memorySettingsLoaded, memorySettingsScope, settings.lastAgentId, settings.subagentModelId, settings.utilityModelId, settings.thinkingMode, showError]
  )

  const deleteTurnById = useCallback(
    (message: ChatMessage) => {
      if (!canExecute || sourceEpoch !== getEngineSource()) return
      void confirmDialog({
        title: '删除本轮',
        body: '删除这一轮问答（含引擎侧历史）？',
        danger: true,
        confirmText: '删除'
      }).then((confirmed) => {
        if (!confirmed || sourceEpoch !== getEngineSource()) return
        void deleteTurn(sessionId, message).catch((err) => showError(err))
      })
    },
    [canExecute, sourceEpoch, deleteTurn, sessionId, showError]
  )

  /**
   * 「添加到对话」：把一条用户消息恢复成输入框里的「正文 + 引用 chip」。
   *
   * 正文里的引用原数据（代码块 / 终端输出）会换回 `@路径` token，chip 按 token 下标重建，
   * 所以能原样改完再发。messagesRef 同步一份，避免把整轮消息列表塞进这个回调的依赖里。
   */
  const refillFromMessage = useCallback((message: ChatMessage) => {
    const draft = userMessageDraft(message.content)
    mentionsRef.current = draft.mentions
    resourceTextRef.current = draft.text
    inputRef.current?.setDraft(draft.text, draft.mentions)
    setInput(draft.text)
    saveChatDraft(sessionId, draft.text, storageSource, draft.mentions)
    inputRef.current?.focus()
  }, [sessionId, storageSource])

  /** 消息级回退（对齐 wuzu revert-files）：恢复该消息后全部文件改动（含已保留）并截断对话，原文回填输入框 */
  const revertToMessage = useCallback(
    (message: ChatMessage) => {
      if (!canExecute || sourceEpoch !== getEngineSource()) return
      void confirmDialog({
        title: '回退到此处',
        body: '按轮次回退此消息及后续改动（包含已保留）。文件版本有冲突或缺少快照时将保留并报告；仅全部文件回退完成后删除对应对话。',
        danger: true,
        confirmText: '回退'
      }).then((confirmed) => {
        if (!confirmed || sourceEpoch !== getEngineSource()) return
        // 引用 chip 一并还原：当初能改「这段代码」再发，回退后也应该能
        const draft = userMessageDraft(message.content)
        void revertFrom(sessionId, message)
          .then(() => {
            if (sourceEpoch !== getEngineSource()) return
            saveChatDraft(sessionId, draft.text, storageSource, draft.mentions)
            if (displayedSessionRef.current !== sourceSessionKey) return
            mentionsRef.current = draft.mentions
            resourceTextRef.current = draft.text
            inputRef.current?.setDraft(draft.text, draft.mentions)
            setInput(draft.text)
          })
          .catch(showError)
      })
    },
    [canExecute, sourceEpoch, sourceSessionKey, storageSource, revertFrom, sessionId, showError]
  )

  /** 挂起卡片的应答提交：引用稳定，保证 MessageItem memo 生效（流式时不让所有历史消息跟着重渲染） */
  const respondToEngine = useCallback(
    (requestId: string, values: string[]) => {
      if (!canExecute || sourceEpoch !== getEngineSource()) return
      void respond(requestId, values, {
        sessionId,
        model: modelId || undefined,
        subagentModel: settings.subagentModelId || undefined,
        utilityModel: settings.utilityModelId || undefined,
        workspacePaths: remoteReadOnly ? [] : currentWorkspacePaths(),
        thinkingMode: resolveThinkingMode(settings.thinkingMode)
      }).catch(showError)
    },
    [canExecute, remoteReadOnly, sourceEpoch, respond, sessionId, modelId, settings.subagentModelId, settings.utilityModelId, settings.thinkingMode, showError]
  )

  const exportSelected = useCallback(() => {
    const text = buildExportText()
    if (!text) return
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `aether-对话导出-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    setToast(`已导出 ${selectedIds.size} 项`)
  }, [buildExportText, selectedIds])

  // 列表不含引擎环境中的默认模型；提供配置入口，不能据空列表断言对话不可用。
  const needsModel = canExecute && modelsLoaded && models.length === 0

  // ── 代码图索引（产品自带 codegraph：一键建索引，Agent 随之获得代码图查询能力）──
  // initialized：项目是否已有索引。已建索引时页脚不再常驻按钮（入口收进右上角菜单），
  // 仅在「尚未建索引」时才把「建索引」露在输入框下方，引导用户补上这一步。
  const [cgIndex, setCgIndex] = useState<{
    busy: boolean
    label: string | null
    initialized: boolean
    /** 是否已知索引状态（避免未知期间误报「未建索引」而闪出一个按钮） */
    known: boolean
  }>({ busy: false, label: null, initialized: false, known: false })
  const cgPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopCgPoll = useCallback(() => {
    if (cgPollRef.current) {
      clearInterval(cgPollRef.current)
      cgPollRef.current = null
    }
  }, [])

  /** 查一次索引状态：是否已建索引（进入会话 / 切换项目时调用） */
  const refreshCgState = useCallback(async () => {
    if (!ready || (!codegraphRoot && !sessionId) || sourceEpoch !== getEngineSource()) {
      setCgIndex((s) => ({ ...s, initialized: false, known: true }))
      return
    }
    try {
      const s = await requestOrThrow<{ initialized: boolean; indexing: boolean }>({
        method: 'GET',
        path: '/codegraph/status',
        query: { sessionId, path: codegraphRoot }
      })
      if (sourceEpoch !== getEngineSource()) return
      setCgIndex((prev) => ({ ...prev, initialized: s.initialized, known: true, busy: s.indexing }))
      if (s.indexing) pollCgStatus()
    } catch {
      if (sourceEpoch !== getEngineSource()) return
      setCgIndex((prev) => ({ ...prev, initialized: false, known: true }))
    }
    // pollCgStatus 定义在下方（useCallback 引用稳定），此处不列入依赖以免循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, codegraphRoot, ready, sourceEpoch])

  /** 轮询引擎 /codegraph/status 直到索引完成/失败；label 短暂展示结果后复位 */
  const pollCgStatus = useCallback(() => {
    stopCgPoll()
    if (sourceEpoch !== getEngineSource()) return
    cgPollRef.current = setInterval(() => {
      if (sourceEpoch !== getEngineSource()) { stopCgPoll(); return }
      void (async () => {
        try {
          const s = await requestOrThrow<{
            initialized: boolean
            indexing: boolean
            run: {
              phase: string
              progress: { current: number; total: number } | null
              error?: string
            } | null
          }>({
            method: 'GET',
            path: '/codegraph/status',
            query: { sessionId, path: codegraphRoot }
          })
          if (sourceEpoch !== getEngineSource()) return
          if (s.indexing && s.run) {
            const p = s.run.progress
            setCgIndex((prev) => ({
              ...prev,
              busy: true,
              known: true,
              label: p ? `索引中 ${p.current}/${p.total}` : '索引中…'
            }))
            return
          }
          stopCgPoll()
          const failed = s.run?.phase === 'failed'
          setCgIndex((prev) => ({
            ...prev,
            busy: false,
            initialized: s.initialized,
            known: true,
            label: failed
              ? `索引失败${s.run?.error ? `: ${s.run.error.slice(0, 30)}` : ''}`
              : '索引完成'
          }))
        } catch {
          if (sourceEpoch !== getEngineSource()) return
          stopCgPoll()
          setCgIndex((prev) => ({ ...prev, busy: false, label: '状态查询失败' }))
        }
        setTimeout(() => { if (sourceEpoch === getEngineSource()) setCgIndex((prev) => ({ ...prev, busy: false, label: null })) }, 4000)
      })()
    }, 1500)
  }, [sessionId, codegraphRoot, stopCgPoll, sourceEpoch])

  const startCgIndex = useCallback(async () => {
    if (!canExecute || sourceEpoch !== getEngineSource() || !sessionId || (!codegraphRoot && !sessionId) || cgIndex.busy) return
    setCgIndex((prev) => ({ ...prev, busy: true, label: '启动中…' }))
    try {
      const r = await requestOrThrow<{
        started: boolean
        alreadyRunning?: boolean
        alreadyInitialized?: boolean
      }>({
        method: 'POST',
        path: '/codegraph/index',
        body: { sessionId, path: codegraphRoot }
      })
      if (sourceEpoch !== getEngineSource()) return
      if (r.alreadyInitialized && !r.started) {
        // 已有索引：只需把状态标记为已建，页脚按钮随之收起
        setCgIndex((prev) => ({
          ...prev,
          busy: false,
          initialized: true,
          known: true,
          label: null
        }))
        return
      }
      pollCgStatus()
    } catch (e) {
      if (sourceEpoch !== getEngineSource()) return
      setCgIndex((prev) => ({
        ...prev,
        busy: false,
        label: e instanceof Error ? e.message.slice(0, 40) : '请求失败'
      }))
      setTimeout(() => { if (sourceEpoch === getEngineSource()) setCgIndex((prev) => ({ ...prev, busy: false, label: null })) }, 4000)
    }
  }, [canExecute, sourceEpoch, sessionId, codegraphRoot, cgIndex.busy, pollCgStatus])

  // 进入会话 / 切换项目时同步一次索引状态（决定页脚是否显示「建索引」）
  useEffect(() => {
    void refreshCgState()
  }, [refreshCgState])

  // 卸载时停止轮询
  useEffect(() => stopCgPoll, [stopCgPoll, sourceEpoch])

  return (
    <div className="chat">
      <div className="chat__topbar">
        {remoteReadOnly ? <span className="chat__workspace" title="任务在远端引擎的会话工作目录中执行">远端会话</span> : workspace.root ? (
          <span className="chat__workspace" title={`Agent 的工作区：${workspace.root}`}>
            {workspace.root.replace(/\\/g, '/').split('/').pop()}
          </span>
        ) : null}
        <div className="chat__toolbar-spacer" />
        {usageTotal.total > 0 || usageTotal.unknownSubagents > 0 ? (
          <UsageMeter
            total={usageTotal.total}
            rounds={usageTotal.rounds}
            summary={usageTotal.summary}
            startedAt={usageTotal.startedAt}
            endedAt={usageTotal.endedAt}
            streaming={streaming}
          />
        ) : null}
        <button
          type="button"
          className="chat__toolbar-btn"
          title="新建会话（开一条全新对话）"
          disabled={!canExecute}
          onClick={createSession}
        >
          <Icon name="plus" size={16} />
          新建
        </button>
        <button
          type="button"
          className={`chat__toolbar-btn${selectMode ? ' is-active' : ''}`}
          disabled={messages.length === 0}
          title="多选消息，可复制或导出为 Markdown"
          onClick={toggleSelectMode}
        >
          <Icon name="check" size={16} />
          多选
        </button>
      </div>

      {selectMode ? (
        <div className="chat__select-bar">
          <div className="chat__select-leading">
            <button type="button" className="chat__toolbar-btn" onClick={toggleAll}>
              {allSelected ? '取消全选' : '全选'}
            </button>
            <span className="chat__select-count">已选 {selectedIds.size} 项</span>
          </div>
          <div className="chat__select-actions">
            <button
              type="button"
              className="chat__toolbar-btn"
              disabled={selectedIds.size === 0}
              onClick={copySelected}
            >
              复制
            </button>
            <button
              type="button"
              className="chat__toolbar-btn"
              disabled={selectedIds.size === 0}
              onClick={exportSelected}
            >
              导出
            </button>
            <button type="button" className="chat__toolbar-btn chat__toolbar-btn--done" onClick={toggleSelectMode}>
              完成
            </button>
          </div>
        </div>
      ) : null}

      <div className="chat__body">
        <MessageNavRail
          sessionId={sessionId}
          turns={navTurns}
          containerRef={scrollRef}
          disabled={!canExecute || streaming || selectMode}
          onCopy={copyMessage}
          onRetry={retryTurn}
          onRevert={revertToMessage}
          onDelete={deleteTurnById}
        />
        <div
          className="chat__messages"
          data-chat-scroll-region="true"
          ref={scrollRef}
          onWheel={handleListWheel}
          onPointerDown={handleListPointerDown}
          onScroll={handleListScroll}
        >
        {/* 非跟随期间来了新内容：浮动「回到底部」（对齐 wuzu-client） */}
        {showBackToBottom ? (
          <button type="button" className="chat__back-to-bottom" onClick={jumpToBottom}>
            <Icon name="chevron-double-down" size={16} />
          </button>
        ) : null}
        {messages.length === 0 ? (
          <div className="chat__empty">
            <h2>Agent IDE</h2>
            <p>
              {ready && remoteReadOnly
                ? '远端已连接。输入任务即可开始；新会话使用设置中的远端工作目录，未填写时使用服务端沙箱。'
                : ready
                ? '引擎已就绪。输入你的问题或任务，Agent 会调用工具直接在你的工作区里完成。'
                : '正在准备引擎，就绪后即可开始对话。'}
            </p>
          </div>
        ) : (
          <>
            {historyCompacted ? (
              <button
                type="button"
                className="chat__load-earlier"
                onClick={() => void loadArchive(sessionId)}
              >
                当前上下文已压缩，点击加载仍保留在归档中的更早对话
              </button>
            ) : null}
            {hiddenTurnCount > 0 ? (
              <button
                type="button"
                className="chat__load-earlier"
                onClick={loadEarlier}
              >
                还有 {hiddenTurnCount} 轮更早的对话，点击或滚到顶部加载
              </button>
            ) : null}
            {visibleTurns.map((turn) => (
            <div key={turn.id} className="chat__turn" data-turn-id={turn.id}>
              {(() => {
                // 本轮的累计用量并入最后一条 AI 消息底部的过程行，不再单独占一行
                const lastAssistantId = [...turn.messages]
                  .reverse()
                  .find((m) => m.role === 'assistant')?.id
                const usage =
                  turn.tokens > 0 && lastAssistantId
                    ? {
                        tokens: turn.tokens,
                        summary: turn.summary,
                        askedAt: turn.askedAt,
                        startedAt: turn.startedAt,
                        endedAt: turn.endedAt,
                        model: turn.modelId ?? modelId,
                        streaming: turn.messages.some((m) => m.status === 'streaming')
                      }
                    : undefined
                return turn.messages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    sessionId={sessionId}
                    usage={message.id === lastAssistantId ? usage : undefined}
                    disabled={!canExecute || streaming}
                  onAllowAll={allowAllForSession}
                  selectionMode={selectMode}
                  selected={selectedIds.has(message.id)}
                  onToggleSelect={() => toggleMessage(message.id)}
                  onRespond={respondToEngine}
                  onCopy={copyMessage}
                  onRetryFrom={retryTurn}
                  onRefill={refillFromMessage}
                  onRevertFiles={revertToMessage}
                  onDeleteTurn={deleteTurnById}
                  canAct={canExecute && !streaming && !selectMode}
                  workspaceRoot={workspace.root}
                  onPreviewImage={(f, src) => setPreviewImage({ file: f, src })}
                />
                ))
              })()}
            </div>
            ))}
          </>
        )}
        </div>
      </div>

      {needsModel ? (
        <div className="chat__notice">
          <span>尚未配置模型，可添加模型或确认引擎已设置默认模型。</span>
          <button type="button" className="link" onClick={() => openAppSettings('models')}>
            去添加模型
          </button>
        </div>
      ) : null}

      {visibleChildCommandJobs(messages, commandJobs, sessionId).length > 0 ? (
        <section className="command-job-children" aria-label="子代理后台命令">
          <div className="command-job-card__meta">子代理后台命令</div>
          {visibleChildCommandJobs(messages, commandJobs, sessionId).map(job => <CommandJobCard key={job.jobId} job={job} sessionId={sessionId} />)}
        </section>
      ) : null}
      <SessionTray
        sessionId={sessionId}
        streaming={streaming}
        todos={todos}
        queue={queue}
        workspaceRoot={workspace.root}
        queueSendMode={queueSendMode}
        onSetQueueSendMode={setQueueSendMode}
        onUpdateQueued={updateQueued}
        onMoveQueued={moveQueued}
        onRemoveQueued={removeQueued}
        onClearQueue={clearQueue}
        onMergeQueue={flushQueueFromTray}
      />

      <div
        className={`chat__composer${attach.dragging ? ' is-dragover' : ''}`}
        onDragOver={(event) => {
          // 不 preventDefault 的话浏览器会直接打开被拖入的文件
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          if (!canExecute) return
          attach.setDragging(true)
        }}
        onDragLeave={(event) => {
          // 移到子元素上也会触发 leave：只有真正离开容器才取消高亮
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          attach.setDragging(false)
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          attach.setDragging(false)
          if (!canExecute) return
          attach.accept([...event.dataTransfer.files])
        }}
      >
        <div className="chat__surface">
          {(attach.attachments.length > 0 || attach.uploading) ? (
            <div className="chat__attach-strip">
              {attach.attachments.map((file) => (
                <AttachmentChip
                  key={file.path}
                  root={workspace.root}
                  file={file}
                  onPreview={(f, src) => setPreviewImage({ file: f, src })}
                  onRemove={() => attach.remove(file.path)}
                />
              ))}
              {attach.uploading ? (
                <span className="attach-chip attach-chip--busy">上传中…</span>
              ) : null}
            </div>
          ) : null}

          {(composerResources.skills.length + composerResources.mcpServers.length + composerResources.knowledgeBases.length) > 0 ? (
            <div className="resource-binding-strip" aria-label="本轮对话资源">
              {composerResources.skills.map(id => <button key={`skill:${id}`} type="button" aria-label={`移除技能 ${id}`} className="resource-binding-chip is-skill" title={`移除技能 ${id}`} onClick={() => removeComposerResource('skill', id)}>技能 · {id}<span aria-hidden="true">×</span></button>)}
              {composerResources.mcpServers.map(id => <button key={`mcp:${id}`} type="button" aria-label={`移除 MCP ${id}`} className="resource-binding-chip is-mcp" title={`移除 MCP ${id}`} onClick={() => removeComposerResource('mcp', id)}>MCP · {id}<span aria-hidden="true">×</span></button>)}
              {composerResources.knowledgeBases.map(id => <button key={`kb:${id}`} type="button" aria-label={`移除知识库 ${id}`} className="resource-binding-chip is-kb" title={`移除知识库 ${id}`} onClick={() => removeComposerResource('kb', id)}>知识库 · {id}<span aria-hidden="true">×</span></button>)}
            </div>
          ) : null}

          <MentionInput
            ref={inputRef}
            value={input}
            disabled={!settingsLoaded}
            placeholder={
              ready ? '输入消息，Enter 发送，Shift+Enter 换行；@ 引用文件，/ 选择 MCP、技能或知识库' : '可先准备问题和代码引用，引擎就绪后发送'
            }
            onChange={(text, mentions) => {
              mentionsRef.current = mentions
              reconcileComposerResources(text)
              inputValueRef.current = text
              setInput(text)
              scheduleDraftSave(text)
            }}
            onSubmit={submit}
            onPasteFiles={(files) => { if (canExecute) attach.accept(files) }}
            onPasteText={(text) => {
              // 长文本落成「粘贴的文本-xxx.txt」附件；短文本返回 false 由输入框自行插入
              if (!canExecute || !shouldAttachPastedText(text) || (!remoteReadOnly && !workspace.root)) return false
              attach.accept([createPastedTextFile(text)])
              return true
            }}
            onMentionQuery={(query) => { setMentionQuery(query); if (query !== null) setResourceQuery(null) }}
            onSlashQuery={(query) => { setResourceQuery(query); if (query !== null) setMentionQuery(null) }}
          />
          {canExecute && workspace.root && (mentionQuery !== null || manualPalette) ? (
            <FileRefPalette
              root={workspace.root}
              keyword={mentionQuery ?? ''}
              showSearch={manualPalette && mentionQuery === null}
              onSelect={(mention) => {
                if (mentionQuery !== null) inputRef.current?.completeMention(mention)
                else inputRef.current?.insertMention(mention)
                setManualPalette(false)
                setMentionQuery(null)
              }}
              onClose={() => {
                setManualPalette(false)
                setMentionQuery(null)
                inputRef.current?.focus()
              }}
            />
          ) : null}
          {resourceQuery !== null ? (
            <ResourcePicker
              query={resourceQuery}
              projectPath={remoteReadOnly ? settings.remoteWorkspaceRoot.trim() || undefined : workspace.root || undefined}
              source={sourceEpoch}
              onSelect={chooseComposerResource}
              onClose={() => { setResourceQuery(null); inputRef.current?.focus() }}
            />
          ) : null}
          {attachHint ? <div className="chat__attach-hint">{attachHint}</div> : null}
          {previewImage ? (
            <AttachmentPreviewDialog
              root={workspace.root}
              preview={previewImage}
              onClose={() => setPreviewImage(null)}
            />
          ) : null}
          <input
            ref={attach.fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              // 清空 value：否则再次选择同一个文件不会触发 change
              event.target.value = ''
              if (!canExecute) return
              attach.accept(files)
            }}
          />

          {/* 工具条：左「＋ / 权限 / Agent」，右「模型 / 语音 / 发送」——同 Trae 的排布 */}
          <div className="chat__toolbar">
            <button
              type="button"
              className={`chat__icon-btn${attach.dragging ? ' is-active' : ''}`}
              disabled={!canExecute || attach.uploading || (!remoteReadOnly && !workspace.root)}
              title={
                remoteReadOnly ? '上传附件到远端引擎当前会话工作区' : workspace.root
                  ? '添加附件或引用（图片 / 文本 / 工作空间文件 / 目录）'
                  : '先打开一个项目目录再添加附件'
              }
              aria-label="添加附件或引用"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setAttachMenu({ x: rect.left, y: rect.top })
              }}
            >
              <Icon name="plus" size={16} />
            </button>
            {attachMenu ? (
              <ContextMenu
                x={attachMenu.x}
                y={attachMenu.y - 8}
                onClose={() => setAttachMenu(null)}
                items={[
                  {
                    id: 'upload',
                    label: '上传附件',
                    hint: '图片 / 文本 / 文档',
                    onSelect: () => {
                      setAttachMenu(null)
                      attach.pick()
                    }
                  },
                  {
                    id: 'workspace',
                    label: '引用工作空间文件 / 目录',
                    hint: '@ 引用，随消息发送给 Agent',
                    onSelect: () => {
                      setAttachMenu(null)
                      setManualPalette(true)
                      inputRef.current?.focus()
                    }
                  }
                ]}
              />
            ) : null}

            <ComposerOptions sessionId={sessionId} />

            {/* 仅当项目「尚未建索引」时才露出建索引入口；已建索引则不占位（重建走设置页 / 菜单） */}
            {cgIndex.known && !cgIndex.initialized ? (
              <button
                type="button"
                className={`chat__index-cta${cgIndex.busy ? ' is-active' : ''}`}
                disabled={!canExecute || !sessionId || (!codegraphRoot && !sessionId) || cgIndex.busy}
                title={
                  codegraphRoot
                    ? `为「${codegraphRoot.replace(/\\/g, '/').split('/').pop()}」创建代码图索引（Agent 随之可查询符号 / 调用关系 / 影响面）`
                    : '为当前会话工作区创建代码图索引'
                }
                onClick={() => void startCgIndex()}
              >
                <Icon name="search" size={16} />
                <span className="picker__label">{cgIndex.label ?? '建索引'}</span>
              </button>
            ) : null}

            <div className="chat__toolbar-spacer" />

            <button
              type="button"
              className="chat__icon-btn chat__polish-btn"
              disabled={!canExecute || polishing || !input.trim()}
              title="AI 润色：让指令更清晰具体（使用轻任务模型）"
              aria-label="AI 润色输入"
              onClick={() => void handlePolish()}
            >
              <Icon name={polishing ? 'sync' : 'sparkles'} size={16} />
            </button>

            {contextUsed > 0 ? (
              <ContextRing
                used={contextUsed}
                limit={contextLimit}
                sessionId={sessionId}
                streaming={streaming}
                onCompacted={() => void loadHistory(sessionId)}
              />
            ) : null}

            <ModelPicker
              value={modelId}
              onChange={selectModel}
              onManage={() => openAppSettings('models')}
            />

            {streaming ? (
              <button
                type="button"
                className="chat__send chat__send--stop"
                aria-label="停止生成"
                disabled={!canExecute}
                title="停止生成"
                onClick={abort}
              >
                <Icon name="stop" size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="chat__send"
                disabled={
                  !canExecute || attach.uploading || (!input.trim() && attach.attachments.length === 0)
                }
                title="发送（Enter）"
                aria-label="发送"
                onClick={submit}
              >
                <Icon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {toast ? (
        <div className="chat__toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  )
}

// ==================== 消息渲染 ====================

/**
 * 上下文用量环：显示当前上下文占用占估算窗口的百分比。
 * 数据来自最近一轮 usage 的 promptTokens；分母为估算值（引擎未下发各模型窗口上限）。
 *
 * 点击触发压缩：调引擎 POST /conversation/compress（LLM 摘要 + 历史重建），
 * 过程中环内显示转圈；完成后短暂显示压缩前后 token 对比，再回落为百分比。
 */
function ContextRing({
  used,
  limit,
  sessionId,
  streaming,
  onCompacted
}: {
  used: number
  limit: number
  sessionId: string
  streaming: boolean
  onCompacted: () => void
}): JSX.Element {
  const { ready } = useApp()
  const sourceEpoch = getEngineSource()
  const [phase, setPhase] = useState<'idle' | 'compacting' | 'done' | 'failed'>('idle')
  const [compactInfo, setCompactInfo] = useState<{ before: number; after: number } | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [hoverAnchor, setHoverAnchor] = useState<DOMRect | null>(null)
  const closeTimerRef = useRef(0)

  const openHover = (rect: DOMRect): void => {
    window.clearTimeout(closeTimerRef.current)
    setHoverAnchor(rect)
  }
  const scheduleCloseHover = (): void => {
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setHoverAnchor(null), 200)
  }
  useEffect(() => () => window.clearTimeout(closeTimerRef.current), [])

  const ratio = Math.min(1, used / limit)
  const percent = Math.round(ratio * 100)
  const radius = 10
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - ratio)
  const warn = ratio >= 0.85

  const compact = async (): Promise<void> => {
    if (!ready || sourceEpoch !== getEngineSource() || phase === 'compacting' || streaming || !sessionId) return
    setPhase('compacting')
    setErrorMsg('')
    const startedAt = Date.now()
    try {
      const stats = await requestOrThrow<{
        originalTokens?: number
        compressedTokens?: number
      }>({ method: 'POST', path: '/conversation/compress', query: { sessionId } })
      if (sourceEpoch !== getEngineSource()) return
      setCompactInfo({
        before: stats.originalTokens ?? used,
        after: stats.compressedTokens ?? 0
      })
      setPhase('done')
      onCompacted()
      // 6 秒后回落到百分比（对齐竞品行为）
      window.setTimeout(() => { if (sourceEpoch === getEngineSource()) setPhase('idle') }, 6000)
    } catch (e) {
      if (sourceEpoch !== getEngineSource()) return
      setErrorMsg(e instanceof Error ? e.message : '压缩失败')
      setPhase('failed')
      window.setTimeout(() => { if (sourceEpoch === getEngineSource()) setPhase('idle') }, 6000)
    }
    void startedAt
  }

  // 悬停详情由 ContextRingCard 弹窗卡片承载，这里只保留无障碍标签（原生 title 会与卡片重复弹出）
  const title =
    phase === 'compacting'
      ? '正在压缩上下文…'
      : phase === 'done' && compactInfo
        ? `已压缩 ${formatTokens(compactInfo.before)} → ${formatTokens(compactInfo.after)}`
        : phase === 'failed'
          ? `压缩失败：${errorMsg}`
          : `上下文用量约 ${percent}%（${formatTokens(used)} / 估算 ${formatTokens(limit)}），点击压缩上下文`

  return (
    <>
      <button
        type="button"
        className={`context-ring${warn ? ' context-ring--warn' : ''}${phase === 'compacting' ? ' context-ring--busy' : ''}`}
        aria-label={title}
        aria-disabled={!ready || phase === 'compacting' || streaming || !sessionId}
        onClick={() => void compact()}
        onMouseEnter={(event) => openHover(event.currentTarget.getBoundingClientRect())}
        onMouseLeave={scheduleCloseHover}
      >
        <svg width="26" height="26" viewBox="0 0 26 26">
          <circle className="context-ring__track" cx="13" cy="13" r={radius} fill="none" strokeWidth="2.5" />
          <circle
            className="context-ring__bar"
            cx="13"
            cy="13"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={phase === 'compacting' ? circumference * 0.25 : offset}
          />
        </svg>
        <span className="context-ring__label">
          {phase === 'compacting' ? '…' : phase === 'done' ? '✓' : phase === 'failed' ? '✕' : percent}
        </span>
      </button>
      {hoverAnchor ? (
        <ContextRingCard
          anchor={hoverAnchor}
          used={used}
          limit={limit}
          percent={percent}
          phase={phase}
          compactInfo={compactInfo}
          errorMsg={errorMsg}
          streaming={streaming}
          readOnly={!ready}
          onKeep={() => window.clearTimeout(closeTimerRef.current)}
          onLeave={scheduleCloseHover}
        />
      ) : null}
    </>
  )
}

/**
 * 上下文用量环的 hover 卡片（布局对齐 wuzu ContextUsageRing 的 tooltip）。
 * 结构：标题行（上下文窗口）→ 大号百分比 + 右侧「已用 / 上限」→ 底部状态提示；
 * 压缩中 / 失败时正文整块替换为对应状态。
 * 定位与 GitStashHoverCard 同模式：卡片上方居中、贴边钳制，鼠标在「环 → 卡片」间移动不消失。
 */
function ContextRingCard({
  anchor,
  used,
  limit,
  percent,
  phase,
  compactInfo,
  errorMsg,
  streaming,
  readOnly,
  onKeep,
  onLeave
}: {
  anchor: DOMRect
  used: number
  limit: number
  percent: number
  phase: 'idle' | 'compacting' | 'done' | 'failed'
  compactInfo: { before: number; after: number } | null
  errorMsg: string
  streaming: boolean
  readOnly: boolean
  onKeep: () => void
  onLeave: () => void
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const margin = 8
    const rect = el.getBoundingClientRect()
    // 优先放在环的正上方居中；上方放不下翻到底部，水平贴边钳制
    let x = anchor.left + (anchor.width - rect.width) / 2
    x = Math.min(Math.max(margin, x), window.innerWidth - rect.width - margin)
    let y = anchor.top - rect.height - 8
    if (y < margin) y = anchor.bottom + 8
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [anchor, phase])

  const hint =
    readOnly
      ? '引擎未就绪，连接恢复后可压缩上下文'
      : phase === 'done' && compactInfo
      ? `已压缩 ${formatTokens(compactInfo.before)} → ${formatTokens(compactInfo.after)}`
      : streaming
        ? '生成中，结束后可点击压缩'
        : '使用接近上限时，可点击立即压缩上下文'

  return createPortal(
    <div ref={cardRef} className="git-stashcard ctx-card" onMouseEnter={onKeep} onMouseLeave={onLeave}>
      <div className="ctx-card__header">
        <span>上下文窗口</span>
        {phase === 'failed' ? (
          <Icon name="close" size={16} className="ctx-card__warn-icon" />
        ) : phase === 'idle' || phase === 'done' ? (
          <span className="ctx-card__percent">
            {percent}
            <span className="ctx-card__percent-sign">%</span>
          </span>
        ) : null}
      </div>
      {phase === 'compacting' ? (
        <div className="ctx-card__status">正在压缩上下文…</div>
      ) : phase === 'failed' ? (
        <div className="ctx-card__status">
          上下文压缩失败
          {errorMsg ? <div className="ctx-card__error">{errorMsg}</div> : null}
        </div>
      ) : (
        <>
          <div className="ctx-card__tokens">
            <span className="ctx-card__tokens-value">
              {formatTokens(used)} / {formatTokens(limit)}
            </span>
            <span className="ctx-card__tokens-label">使用 / 上限</span>
          </div>
          <div className="ctx-card__bar">
            <div
              className={`ctx-card__bar-fill${percent >= 90 ? ' ctx-card__bar-fill--warn' : ''}`}
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
        </>
      )}
      {phase !== 'failed' && phase !== 'compacting' ? (
        <div className="ctx-card__hint">{hint}</div>
      ) : null}
    </div>,
    document.body
  )
}

/**
 * 把选中的消息序列化成 Markdown（复制与导出共用）。
 * 选择单位 = 一条消息：用户消息取正文；AI 消息含思考过程、工具活动与输出。
 */
function serializeMessages(selected: ChatMessage[]): string {
  return selected
    .map((message) => {
      const parts: string[] = [message.role === 'user' ? '## 用户' : '## Agent']

      if (message.thinking) {
        parts.push(`<details>\n<summary>思考过程</summary>\n\n${message.thinking}\n\n</details>`)
      }

      if (message.role !== 'user') {
        const exportedTools = message.tools.filter((tool) => !tool.hidden)
        if (exportedTools.length > 0) {
          const toolLines = exportedTools.map((tool) => {
            const state = toolStatusLabel(tool)
            const summary = tool.args ? toolParamSummary(tool.args) : ''
            const details = tool.commandJob ? exportCommandJob(tool.commandJob) : tool.name === 'subagent' ? exportSubagentDetails(tool) : tool.error ?? ''
            return `- ${toolDisplayName(tool.name)}${summary ? `：${summary}` : ''}（${state}）${details ? `\n\n${details}\n` : ''}`
          })
          parts.push(`\n**工具调用**\n\n${toolLines.join('\n')}`)
        }
      }

      if (message.content) {
        // 用户消息导出的是可读正文：引用原数据块与协议注释不进剪贴板
        parts.push(`\n${message.role === 'user' ? userMessageText(message.content) : message.content}`)
      }
      return parts.join('\n')
    })
    .join('\n\n---\n\n')
}

/**
 * 用户消息气泡正文。
 *
 * 落库的是「发给 AI 的原文」：引用标签已被替换成 `<reference>` 原数据块，末尾还挂着
 * 一行机器数据注释（下标）——这些都是给机器看的，不该糊到用户脸上。这里按注释里的
 * 下标把整段替换内容收成一枚行内标签，显示成与输入框同款样式的 chip；没有注释的
 * 历史消息（旧协议在文末追加说明块）退化成清洗后的纯文本。
 *
 * 按下标切、不做文本匹配：`@public` 后面紧跟用户打的内容时，文本匹配必然串位。
 */
const UserBubbleContent = memo(function UserBubbleContent({ content }: { content: string }): JSX.Element {
  const segments = useMemo(() => {
    const { body, refs } = parseMentionContent(content)
    if (!refs.length) return [{ text: userMessageText(content), ref: null }]
    const out: { text: string; ref: PromptRef | null }[] = []
    let cursor = 0
    for (const ref of refs) {
      if (ref.s > cursor) out.push({ text: body.slice(cursor, ref.s), ref: null })
      out.push({ text: ref.d, ref })
      cursor = ref.e
    }
    if (cursor < body.length) out.push({ text: body.slice(cursor), ref: null })
    return out
  }, [content])

  return (
    <>
      {segments.map((segment, index) =>
        segment.ref ? (
          <span
            key={index}
            className={`mention-chip mention-chip--${segment.ref.t}`}
            style={{ color: MENTION_META[segment.ref.t].color }}
            title={mentionTitle({
              source: segment.ref.t,
              path: segment.ref.p,
              startLine: segment.ref.r?.[0],
              endLine: segment.ref.r?.[1]
            })}
          >
            {segment.ref.d}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  )
})

const MessageItem = memo(function MessageItem({
  message,
  sessionId,
  usage,
  disabled,
  onAllowAll,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onRespond,
  onCopy,
  onRetryFrom,
  onRefill,
  onRevertFiles,
  onDeleteTurn,
  canAct,
  workspaceRoot,
  onPreviewImage
}: {
  message: ChatMessage
  /** 当前会话 ID（子代理停止按钮走 /subagent/cancel 要用） */
  sessionId: string
  /** 该轮的累计用量：只挂在最后一条 AI 消息底部的过程行上 */
  usage?: TurnUsageInfo
  disabled: boolean
  /** 把本会话切成 full-access（用于授权卡片的一键放行） */
  onAllowAll: () => Promise<void>
  /** 多选模式：true 时消息头部显示复选框 */
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  onRespond: (requestId: string, values: string[]) => void
  /** 复制该消息文本 */
  onCopy: (message: ChatMessage) => void
  /** 从该用户消息处删除此后内容并重新发送（重新发送 / 重新生成共用） */
  onRetryFrom: (message: ChatMessage) => void
  /** 把这条用户消息（含引用 chip）放回输入框，改完再发 */
  onRefill: (message: ChatMessage) => void
  /** 消息级回退：恢复该消息后所有文件改动（含已保留）并截断对话 */
  onRevertFiles: (message: ChatMessage) => void
  /** 删除该消息所在的一整轮对话 */
  onDeleteTurn: (message: ChatMessage) => void
  /** 是否允许执行重试/删除（流式进行中或多选模式下禁止） */
  canAct: boolean
  /** 工作区根目录：附件图片缩略图按相对路径回读 */
  workspaceRoot: string | null
  /** 图片附件点击放大 */
  onPreviewImage: (file: ChatAttachment, src: string | null) => void
}): JSX.Element {
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const [copied, setCopied] = useState(false)

  const pick = selectionMode ? (
    <label className="message__pick">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={isUser ? '选择这条用户消息' : '选择这条 Agent 消息'}
      />
    </label>
  ) : null

  const copy = (): void => {
    onCopy(message)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const actions = selectionMode || streaming ? null : (
    <div className="message__actions">
      <button
        type="button"
        className="message__action"
        title={copied ? '已复制' : '复制'}
        aria-label="复制"
        onClick={copy}
      >
        <Icon name={copied ? 'check' : 'copy'} size={16} />
      </button>
      {isUser ? (
        <>
          <button
            type="button"
            className="message__action"
            title="添加到对话：把这条消息（含引用）放回输入框，改完再发"
            aria-label="添加到对话"
            disabled={!canAct}
            onClick={() => onRefill(message)}
          >
            <Icon name="pencil" size={16} />
          </button>
          <button
            type="button"
            className="message__action"
            title="回退到此处：撤销此消息及后续轮次的全部文件修改（含已保留），并删除对应对话"
            aria-label="回退到此处"
            disabled={!canAct}
            onClick={() => onRevertFiles(message)}
          >
            <Icon name="restart" size={16} />
          </button>
          <button
            type="button"
            className="message__action"
            title="删除此后的对话并重新发送"
            aria-label="重新发送"
            disabled={!canAct}
            onClick={() => onRetryFrom(message)}
          >
            <Icon name="send" size={16} />
          </button>
        </>
      ) : (
        <button
          type="button"
          className="message__action"
          title="从上一条提问处重新生成"
          aria-label="重新生成"
          disabled={!canAct}
          onClick={() => onRetryFrom(message)}
        >
          <Icon name="restart" size={16} />
        </button>
      )}
      <button
        type="button"
        className="message__action message__action--danger"
        title="删除这一轮问答"
        aria-label="删除本轮"
        disabled={!canAct}
        onClick={() => onDeleteTurn(message)}
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
  )

  if (isUser) {
    // 用户消息：右对齐气泡，无角色标签 —— 对齐靠位置与底色区分
    return (
      <article className="message message--user" data-message-id={message.id} data-turn-id={message.conversationId}>
        {pick}
        <div className="message__bubble-wrap">
          {actions}
          <div className="message__bubble">
            <UserBubbleContent content={message.content} />
          </div>
          {message.attachments && message.attachments.length > 0 ? (
            <div className="message__attachments">
              {message.attachments.map((file) => (
                <AttachmentChip
                  key={file.path}
                  root={workspaceRoot}
                  file={file}
                  onPreview={onPreviewImage}
                />
              ))}
            </div>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article className="message message--assistant" data-message-id={message.id} data-turn-id={message.conversationId}>
      {pick}

      <MessageTimeline message={message} sessionId={sessionId} streaming={streaming} />

      {/* 该轮累计用量常显；操作图标随悬停出现，两者同行（用量在左） */}
      <div className="message__footer">
        {usage ? (
          <TurnUsage
            tokens={usage.tokens}
            summary={usage.summary}
            askedAt={usage.askedAt}
            startedAt={usage.startedAt}
            endedAt={usage.endedAt}
            model={usage.model}
            streaming={usage.streaming}
          />
        ) : message.modelId ? <span className="turn-usage__model">{message.modelId}</span> : null}
        {actions}
      </div>

      {message.run ? <div className="pending-card__hint" role="status" aria-label="运行状态">{message.status === 'interrupted' ? '已中断' : message.status === 'aborted' ? '已取消' : message.status === 'error' ? '失败' : rootStatusLabel(message.run.status)}</div> : null}
      {(() => {
        const interactions = message.interactions ?? (message.pending ? [message.pending] : [])
        // 只有仍处于 waiting 的请求才是可操作的待办。已回答项以及终态运行
        // 中遗留的 pending 记录属于审计历史，折叠展示，避免对话区不断堆积
        // 已完成的警示卡片，也避免让用户误以为它们仍在等待选择。
        // 无 durable requestId 的旧交互无法走当前应答协议，不能显示永久禁用
        // 的操作按钮。保留为历史记录，等待新的运行快照提供可应答请求。
        const active = interactions.filter(item => item.status === 'pending' &&
          Boolean(item.requestId) && item.runId === message.run?.runId && message.run?.status === 'waiting')
        const history = interactions.filter(item => !active.includes(item))
        return (
          <>
            {history.length > 0 ? <InteractionHistory interactions={history} /> : null}
            {active.map((pending) => (
              <PendingCard
                key={pending.requestId ?? pending.toolCallId}
                pending={pending}
                disabled={disabled || !pending.requestId || message.run?.status !== 'waiting'}
                onAllowAll={onAllowAll}
                onRespond={(values) => { if (pending.requestId) onRespond(pending.requestId, values) }}
              />
            ))}
          </>
        )
      })()}

      {message.error ? <div className="message__error">{message.error}</div> : null}
    </article>
  )
})

/** 全尺寸卡片工具（diff / 子代理）：不进折叠过程块，永远在原位全显 */
function isFullSizeTool(tool: ToolActivity): boolean {
  return (
    tool.name === 'subagent' ||
    (tool.name === 'execute_cmd' && Boolean(tool.commandJob)) ||
    ((tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'delete_file') &&
      Boolean(tool.change))
  )
}

/**
 * 待办类工具对用户是噪音：状态已在顶部待办列表呈现，时间线再插一条只是刷屏。
 * 界面过滤，但复制/导出仍包含（不能用 hidden 字段，那条链会让导出也漏掉）。
 */
function isTimelineHiddenTool(tool: ToolActivity): boolean {
  return (
    tool.name === 'todo_create' ||
    tool.name === 'todo_list' ||
    tool.name === 'todo_update' ||
    tool.name === 'todo_delete'
  )
}

/** 过程块内的紧凑条目：一段思考 或 一次过程性工具调用 */
type CompactEntry = { kind: 'thinking'; text: string } | { kind: 'tool'; tool: ToolActivity }

/** 一轮问答的累计用量（并入最后一条 AI 消息底部的过程行） */
type TurnUsageInfo = {
  tokens: number
  summary: UsageDetailRow[]
  askedAt: number
  startedAt?: number
  endedAt?: number
  model?: string
  streaming: boolean
}

/** 内联段落：正文段 / 全尺寸卡片（diff）/ 单个子代理 / 子代理组，在过程块之后按原顺序渲染 */
type InlineSegment =
  | { type: 'process'; entries: CompactEntry[] }
  | { type: 'tool'; tool: ToolActivity }
  | { type: 'content'; text: string }
  | { type: 'subagent-group'; tools: ToolActivity[] }

/** 流式状态文案分层：正在执行的工具名 > 「正在生成回复」> 兜底「处理中…」（对齐 wuzu streamStatusDisplay） */
function streamStatusText(message: ChatMessage): string {
  // 正在执行的工具优先：用户最关心的是「此刻在干什么」
  const running = [...message.tools].reverse().find((tool) => tool.state === 'running')
  if (running) return `${toolDisplayName(running.name)}…`
  // 已有正文流出说明在生成回复
  if (message.content) return '正在生成回复…'
  return '处理中…'
}

/**
 * 消息时间线：只合并连续的思考 / 工具调用，正文与全尺寸卡片保留真实发生位置。
 *
 * useChat 在收 SSE 帧时同步维护 message.items（帧严格按发生顺序到达）。
 * 每段连续的过程性条目可折叠；正文不会因为收拢工具而移到工具之后。
 */
function MessageTimeline({
  message,
  sessionId,
  streaming
}: {
  message: ChatMessage
  sessionId: string
  streaming: boolean
}): JSX.Element | null {  const { inline } = useMemo(() => {
    const toolById = new Map(
      message.tools
        .filter((tool) => !tool.hidden && !isTimelineHiddenTool(tool))
        .map((tool) => [tool.id, tool])
    )
    let processEntries: CompactEntry[] = []
    const inline: InlineSegment[] = []
    const flushProcess = (): void => {
      if (processEntries.length) inline.push({ type: 'process', entries: processEntries })
      processEntries = []
    }
    const seen = new Set<string>()

    for (const item of message.items) {
      if (item.kind === 'thinking') {
        processEntries.push({ kind: 'thinking', text: item.text })
      } else if (item.kind === 'tool') {
        const tool = toolById.get(item.id)
        if (!tool || seen.has(tool.id)) continue
        seen.add(tool.id)
        if (isFullSizeTool(tool)) { flushProcess(); inline.push({ type: 'tool', tool }) }
        else processEntries.push({ kind: 'tool', tool })
      } else if (item.kind === 'content') {
        flushProcess()
        inline.push({ type: 'content', text: item.text })
      }
      // interaction：应答卡片由 MessageItem 单独渲染，时间线不占位
    }

    // 兜底：tools 里存在但时间线没记录的条目（异常帧序），挂到过程块末尾
    for (const tool of toolById.values()) {
      if (seen.has(tool.id)) continue
      if (isFullSizeTool(tool)) { flushProcess(); inline.push({ type: 'tool', tool }) }
      else processEntries.push({ kind: 'tool', tool })
    }

    flushProcess()

    // 把连续的子代理段收进一个组（对齐 wuzu 的 AgentSubagentGroup）：
    // 并行派发 N 个子代理会产生 N 张连续大卡片，占满整屏还看不清彼此关系；
    // 收成一组后默认只露「子代理 ×N」一行汇总。单个出现时仍保持原位全显（走 tool 分支）。
    const grouped: InlineSegment[] = []
    let pendingSubagents: ToolActivity[] = []
    const flushSubagents = (): void => {
      if (pendingSubagents.length === 0) return
      if (pendingSubagents.length === 1) grouped.push({ type: 'tool', tool: pendingSubagents[0] })
      else grouped.push({ type: 'subagent-group', tools: [...pendingSubagents] })
      pendingSubagents = []
    }
    for (const segment of inline) {
      if (segment.type === 'tool' && segment.tool.name === 'subagent') {
        pendingSubagents.push(segment.tool)
        continue
      }
      flushSubagents()
      grouped.push(segment)
    }
    flushSubagents()

    return { inline: grouped }
  }, [message.items, message.tools])

  if (inline.length === 0) {
    return streaming && !message.pending ? (
      <div className="message__streaming-hint">
        <span className="message__spinner" />
        {streamStatusText(message)}
      </div>
    ) : null
  }

  // Wuzu Code 只自动展开当前时间线末尾的过程块；较早的过程块保留为摘要，
  // 否则一次包含多轮工具调用的回答会把正文推到很远的位置。
  const lastProcessIndex = inline.reduce(
    (last, item, itemIndex) => (item.type === 'process' ? itemIndex : last),
    -1
  )

  return (
    <>
      {inline.map((segment, index) => {
        return (
          segment.type === 'process' ? (
            <ProcessGroup
              key={`p-${index}`}
              entries={segment.entries}
              streaming={streaming}
              autoOpen={streaming && index === lastProcessIndex}
              collapseKey={`${message.id}:${index}`}
            />
          ) : segment.type === 'tool' ? (
            <div key={`t-${segment.tool.id}`} className="message__tools">
              <ToolItem tool={segment.tool} sessionId={sessionId} />
            </div>
          ) : segment.type === 'subagent-group' ? (
            <div key={`sg-${segment.tools[0].id}`} className="message__tools">
              <SubagentGroup tools={segment.tools} sessionId={sessionId} />
            </div>
          ) : (
            <div key={`c-${index}`} className="message__content">
              <Markdown text={segment.text} />
            </div>
          )
        )
      })}
      {streaming && !message.pending ? (
        <div className="message__streaming-hint">
          <span className="message__spinner" />
          {streamStatusText(message)}
        </div>
      ) : null}
    </>
  )
}

/**
 * 子代理组（对齐 wuzu 的 AgentSubagentGroup）
 *
 * 并行派发多个子代理时收拢为一组：组头显示调用次数、整体状态与失败提示，
 * 默认收起只露一行汇总，点开后逐张渲染子代理卡片。
 */
function SubagentGroup({
  tools,
  sessionId
}: {
  tools: ToolActivity[]
  sessionId: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const running = tools.some((tool) => tool.state === 'running')
  const failCount = tools.filter((tool) => tool.state === 'error').length
  const unknownCount = tools.filter((tool) => tool.state === 'unknown').length
  const cancelledCount = tools.filter((tool) => tool.state === 'cancelled').length

  return (
    <div className="subagent-group">
      <button
        type="button"
        className="subagent-group__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="subagent-group__name">子代理</span>
        <span className="subagent-group__count">{tools.length} 次调用</span>
        <span className="subagent-group__status">
          {running ? '运行中' : failCount ? '有任务失败' : unknownCount ? '含未知状态' : cancelledCount ? '含已取消任务' : '已完成'}
        </span>
        {failCount > 0 ? (
          <span className="subagent-group__fail">{failCount} 失败</span>
        ) : null}
        <Icon name="chevron" size={16} className="subagent-group__chevron" />
      </button>
      {open ? (
        <div className="subagent-group__body">
          {tools.map((tool) => (
            <SubagentCard key={tool.id} tool={tool} sessionId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 过程区（思考 + 过程性工具调用）
 *
 * 对齐 wuzu-client 的双层折叠形制：
 * - 单条思考 / 工具调用是一行 24px 紧凑日志行（圆点 + 名称 + 摘要 + hover 才出现的箭头）；
 * - 一轮结束后，整段过程收成一行摘要「过程 · 思考 N 段 · 工具调用 M」，点开原样还原；
 *   流式进行中只展开时间线最后一段，方便实时围观；用户手动点过后以用户为准。
 */
function ProcessGroup({
  entries,
  streaming,
  autoOpen,
  collapseKey
}: {
  entries: CompactEntry[]
  streaming: boolean
  /** 只有当前时间线最后一个过程块才有自动展开资格。 */
  autoOpen: boolean
  /** 折叠记忆的稳定 key（消息 id）；分页回收/切换会话后能恢复用户手动的折叠选择 */
  collapseKey?: string
}): JSX.Element {
  // 折叠状态：默认只展开当前末段 / 历史收起；一旦用户手动点过，以用户选择为准
  const [manual, setManual] = useCollapseMemory(collapseKey ? `process:${collapseKey}` : undefined)
  const expanded = manual ?? autoOpen

  const thinkingCount = entries.filter((entry) => entry.kind === 'thinking').length
  const toolCount = entries.length - thinkingCount
  const summaryParts: string[] = []
  if (thinkingCount > 0) summaryParts.push(`思考 ${thinkingCount} 段`)
  if (toolCount > 0) summaryParts.push(`工具调用 ${toolCount}`)
  const failCount = entries.filter(
    (entry) => entry.kind === 'tool' && entry.tool.state === 'error'
  ).length
  if (failCount > 0) summaryParts.push(`${failCount} 失败`)
  const lastThinkingIndex = entries.reduce(
    (last, entry, index) => (entry.kind === 'thinking' ? index : last),
    -1
  )

  return (
    <div className="process">
      <button
        type="button"
        className="process__summary"
        aria-expanded={expanded}
        onClick={() => setManual(!expanded)}
      >
        <span className="process__summary-dot" />
        <span className="process__summary-text">
          {streaming ? '过程中' : '过程'} · {summaryParts.join(' · ')}
        </span>
        <Icon name="chevron" size={16} className="process__chevron" />
      </button>
      {expanded ? (
        <div className="process__body">
          {entries.map((entry, index) =>
            entry.kind === 'thinking' ? (
              <ThinkingRow
                key={`think-${index}`}
                text={entry.text}
                autoOpen={autoOpen && index === lastThinkingIndex}
                memoryKey={collapseKey ? `think:${collapseKey}:${index}` : undefined}
              />
            ) : (
              <CompactToolRow key={entry.tool.id} tool={entry.tool} />
            )
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 思考行：紫色圆点 + 单行预览，展开看全文（左侧竖线表示从属于该行） */
function ThinkingRow({
  text,
  autoOpen,
  memoryKey
}: {
  text: string
  autoOpen: boolean
  memoryKey?: string
}): JSX.Element | null {
  // 使用消息/过程/索引组成稳定 key；不能用思考文本本身，否则流式追加前 32 字变化时
  // 会把用户刚刚手动折叠的状态重置掉。
  const [memory, setMemory] = useCollapseMemory(memoryKey)
  const open = memory ?? autoOpen
  const detailRef = useRef<HTMLPreElement | null>(null)
  const followDetailRef = useRef(true)
  const THINKING_RESUME_PX = 40

  const syncDetailFollow = useCallback((): void => {
    const el = detailRef.current
    if (!el) return
    followDetailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= THINKING_RESUME_PX
  }, [])

  // 打开思考区时从底部开始；之后只在用户仍贴底时跟随新增文本。
  useEffect(() => {
    if (!open) return
    followDetailRef.current = true
    const frame = requestAnimationFrame(() => {
      const el = detailRef.current
      if (el && followDetailRef.current) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open || !followDetailRef.current) return
    const frame = requestAnimationFrame(() => {
      const el = detailRef.current
      if (el && followDetailRef.current) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [open, text])
  const preview = text.replace(/\s+/g, ' ').trim()
  // 空/纯空白思考不渲染（回放路径历史里可能残留，避免一列孤立箭头）
  if (!preview) return null
  const truncated = preview.length > 90 ? `${preview.slice(0, 87)}…` : preview

  return (
    <div className="logline-wrap">
      <button
        type="button"
        className="logline"
        aria-expanded={open}
        onClick={() => setMemory(!open)}
      >
        <span className="logline__dot logline__dot--think" />
        <span className="logline__text" title={preview}>
          {truncated}
        </span>
        <Icon name="chevron" size={16} className="logline__chevron" />
      </button>
      {open ? (
        <div className="logline__detail logline__detail--thinking">
          <pre
            ref={detailRef}
            onScroll={syncDetailFollow}
            onWheel={(event) => event.stopPropagation()}
          >{text}</pre>
        </div>
      ) : null}
    </div>
  )
}

/** 紧凑工具行：7px 状态圆点 + 中文工具名 + 参数摘要，展开看原始参数与结果 */
function CompactToolRow({ tool }: { tool: ToolActivity }): JSX.Element {
  const { engine } = useApp()
  const remoteReadOnly = engine.snapshot.mode === 'remote'
  // key 用 toolUseId：分页回收/切换会话后恢复用户手动的展开选择
  const [memory, setMemory] = useCollapseMemory(`tool:${tool.id}`)
  const open = memory ?? false
  const label = toolDisplayName(tool.name)
  const summary = toolParamSummary(tool.args)
  const hasDetail = Boolean(tool.args || tool.result || tool.error)
  // 摘要恰是文件路径时（读取/写入文件等），点摘要直接在编辑器里打开该文件
  const pathArg = toolPathArg(tool.args)
  const openablePath = !remoteReadOnly && pathArg && summary === pathArg ? pathArg : null

  return (
    <div className="logline-wrap">
      <button
        type="button"
        className={`logline${hasDetail ? '' : ' logline--static'}`}
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setMemory(!open)}
      >
        <span
          className={`logline__dot logline__dot--${tool.state === 'running' ? 'running' : tool.state === 'done' ? 'done' : 'error'}`}
          title={toolStatusLabel(tool)}
        />
        <span className={`logline__name${tool.state === 'error' ? ' logline__name--error' : ''}`}>
          {label}
        </span>
        <span className="pending-card__hint">{toolStatusLabel(tool)}{tool.durationMs !== undefined ? ` · ${tool.durationMs} ms` : ''}</span>
        {summary ? (
          openablePath ? (
            <span
              role="button"
              tabIndex={-1}
              className="logline__summary logline__summary--link"
              title={`在编辑器中打开 ${openablePath}`}
              onClick={(event) => {
                // 点摘要是打开文件，不触发展开/收起
                event.stopPropagation()
                void openFileFromChat(openablePath)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.stopPropagation()
                  void openFileFromChat(openablePath)
                }
              }}
            >
              {summary}
            </span>
          ) : (
            <span className="logline__summary" title={summary}>
              {summary}
            </span>
          )
        ) : null}
        {hasDetail ? <Icon name="chevron" size={16} className="logline__chevron" /> : null}
      </button>
      {open && hasDetail ? (
        <div className="logline__detail">
          {tool.args ? <pre>{tool.args}</pre> : null}
          {tool.error ? <div className="message__error">{tool.error}</div> : null}
          {tool.result ? <pre>{tool.result}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 一次用户提问的累计用量（挂在「用户提问 + 其后的全部 AI 输出」整段的末尾）
 *
 * 一轮对话里 Agent 会跑很多步（思考 → 执行命令 → 再思考 …），逐步显示 token
 * 会把消息流打成碎片。这里按用户消息切分，只在该轮结尾给一个累计值。
 *
 * 除了 token，还要回答"这一轮是什么时候问的、跑了多久、用的哪个模型" ——
 * 这三项是回顾历史时最常需要的上下文，缺了就得翻设置页去猜。
 *
 * 外观与顶部会话用量一致，那它就也得能点开 —— 长得一样却有的能点有的不能点，
 * 比不能点本身更让人困惑。明细由调用方传入本轮的汇总行。
 */
function TurnUsage({
  tokens,
  summary,
  askedAt,
  startedAt,
  endedAt,
  model,
  streaming
}: {
  tokens: number
  summary: UsageDetailRow[]
  /** 用户提问时刻（epoch ms） */
  askedAt: number
  /** 本轮开始时刻；缺失表示尚未开始 */
  startedAt?: number
  /** 本轮结束时刻；缺失表示仍在进行中 */
  endedAt?: number
  /** 本轮使用的模型 id */
  model?: string
  /** 是否仍在输出：进行中用「当前时刻」估算已用时长 */
  streaming: boolean
}): JSX.Element {
  // 进行中时 endedAt 还没有：需要一个随渲染推进的值来累计已用时长
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming])

  const duration = formatDuration(startedAt, streaming ? now : endedAt)
  const stamp = formatTimestamp(askedAt)

  return (
    <Popover
      className="turn-usage"
      label="本次问答用量"
      // 向上弹：每轮用量贴在消息流末尾，向下弹会盖住即将输入的区域
      placement="up"
      align="start"
      width={268}
      trigger={({ open }) => (
        <button
          type="button"
          className={`turn-usage__trigger${open ? ' is-open' : ''}`}
          title="查看本次问答的时间、耗时与 Token 明细"
        >
          <Icon name="model" size={16} />
          <span className="turn-usage__value">{formatTokens(tokens)}</span>
          <span className="turn-usage__unit">tokens{summary.some((row) => row.unknown) ? '（已知）' : ''}</span>
          {duration ? <span className="turn-usage__time">{duration}</span> : null}
          {model ? <span className="turn-usage__model">{model}</span> : null}
        </button>
      )}
    >
      <div className="usage-popover__head">
        <span className="usage-popover__title">本次问答</span>
        {stamp ? <span className="usage-popover__meta">{stamp}</span> : null}
      </div>
      <div className="usage-popover__total">
        <span className="usage-popover__total-value">{formatTokens(tokens)}</span>
        <span className="usage-popover__total-unit">tokens{summary.some((row) => row.unknown) ? '（已知部分）' : ''}</span>
        {duration ? <span className="usage-popover__meta">耗时 {duration}</span> : null}
      </div>
      {model ? (
        <div className="usage-detail usage-detail--meta">
          <div className="usage-detail__row">
            <Icon name="model" size={16} className="usage-detail__icon" />
            <span className="usage-detail__label">模型</span>
            <span className="usage-detail__value">{model}</span>
          </div>
          {stamp ? (
            <div className="usage-detail__row">
              <Icon name="clock-outline" size={16} className="usage-detail__icon" />
              <span className="usage-detail__label">对话时间</span>
              <span className="usage-detail__value">{stamp}</span>
            </div>
          ) : null}
          {duration ? (
            <div className="usage-detail__row">
              <Icon name="sync" size={16} className="usage-detail__icon" />
              <span className="usage-detail__label">任务耗时</span>
              <span className="usage-detail__value">{duration}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="usage-detail">
        {summary.map((row) => (
          <div
            key={row.label}
            className={`usage-detail__row${row.child ? ' usage-detail__row--child' : ''}`}
          >
            <span className={`usage-detail__bar usage-detail__bar--${row.group}`} />
            <span className="usage-detail__label">{row.label}</span>
            <span className="usage-detail__value">{row.unknown ? '未知' : formatTokens(row.tokens)}</span>
          </div>
        ))}
      </div>
    </Popover>
  )
}

/**
 * 页脚会话用量仪表
 *
 * 只统计整条会话的累计值 —— 会话可能先后用到多个模型，因此不显示模型名，
 * 只给「token + 使用时间」。触发区用胶囊按钮，明细走锚定在按钮上方的浮层，
 * 符合 macOS 里「状态项 → 向上弹出 popover」的惯例。
 */
function UsageMeter({
  total,
  rounds,
  summary,
  startedAt,
  endedAt,
  streaming
}: {
  total: number
  rounds: number
  summary: UsageDetailRow[]
  startedAt?: number
  endedAt?: number
  streaming: boolean
}): JSX.Element {
  // 进行中时没有 endedAt，用「当前时刻」估算已用时长：需要一个随渲染推进的值
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming])

  const duration = formatDuration(startedAt, streaming ? now : endedAt)

  return (
    <Popover
      className="usage-meter"
      label="会话用量明细"
      placement="down"
      align="end"
      width={268}
      trigger={({ open }) => (
        <button
          type="button"
          className={`usage-meter__trigger${open ? ' is-open' : ''}`}
          title="查看本会话的 Token 明细"
        >
          <Icon name="model" size={16} />
          <span className="usage-meter__tokens">{formatTokens(total)}</span>
          <span className="usage-meter__unit">tokens{summary.some((row) => row.unknown) ? '（已知）' : ''}</span>
          {duration ? <span className="usage-meter__time">{duration}</span> : null}
        </button>
      )}
    >
      <div className="usage-popover__head">
        <span className="usage-popover__title">本会话用量</span>
        <span className="usage-popover__meta">
          {rounds} 轮{duration ? ` · ${duration}` : ''}
        </span>
      </div>
      <div className="usage-popover__total">
        <span className="usage-popover__total-value">{formatTokens(total)}</span>
        <span className="usage-popover__total-unit">tokens{summary.some((row) => row.unknown) ? '（已知部分）' : ''}</span>
      </div>
      <div className="usage-detail">
        {summary.map((row) => (
          <div
            key={row.label}
            className={`usage-detail__row${row.child ? ' usage-detail__row--child' : ''}`}
          >
            <span className={`usage-detail__bar usage-detail__bar--${row.group}`} />
            <span className="usage-detail__label">{row.label}</span>
            <span className="usage-detail__value">{row.unknown ? '未知' : formatTokens(row.tokens)}</span>
          </div>
        ))}
      </div>
    </Popover>
  )
}

/**
 * 等待应答卡片
 *
 * 引擎发出提问/授权帧后会挂起当前流等待应答 —— 用户看到的就是"卡住了"。
 * 这张卡片是唯一的出口，因此要显眼并把原因说清楚（尤其是安全拦截，
 * 用户需要知道被拦的是哪条命令才能判断该不该放行）。
 */
function PendingCard({
  pending,
  disabled,
  onAllowAll,
  onRespond
}: {
  pending: PendingInteraction
  disabled: boolean
  onAllowAll: () => Promise<void>
  onRespond: (values: string[]) => void
}): JSX.Element {
  const sourceEpoch = getEngineSource()
  const [groupSelected, setGroupSelected] = useState<Record<number, string[]>>({})
  const [groupInput, setGroupInput] = useState<Record<number, string>>({})
  const [allowAllBusy, setAllowAllBusy] = useState(false)
  const [allowAllError, setAllowAllError] = useState<string | null>(null)
  const currentRequestRef = useRef(true)
  useEffect(() => {
    currentRequestRef.current = true
    return () => { currentRequestRef.current = false }
  }, [pending.requestId, pending.runId, sourceEpoch])
  const isPermission = pending.kind === 'permission'

  const toggle = (groupIndex: number, value: string, multi: boolean): void => {
    setGroupSelected((prev) => {
      const current = prev[groupIndex] ?? []
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : multi
          ? [...current, value]
          : [value]
      return { ...prev, [groupIndex]: next }
    })
  }

  /**
   * 一键放行：先切会话模式，再放行当前这一步。
   *
   * 切模式失败时**仍然放行**——用户点这个按钮的意图是「继续做下去」，
   * 而单次放行本身足以解开眼前这次拦截（引擎会把该命令写入会话白名单）。
   * 失败只提示，不阻断。
   */
  const allowAll = async (): Promise<void> => {
    if (disabled || allowAllBusy || sourceEpoch !== getEngineSource()) return
    setAllowAllBusy(true)
    setAllowAllError(null)
    try {
      await onAllowAll()
    } catch (err) {
      if (currentRequestRef.current) setAllowAllError(err instanceof Error ? err.message : String(err))
    } finally {
      if (currentRequestRef.current) setAllowAllBusy(false)
    }
    if (currentRequestRef.current && sourceEpoch === getEngineSource()) onRespond(['approved'])
  }

  return (
    <div className={`pending-card${isPermission ? ' pending-card--permission' : ''}`}>
      <div className="pending-card__title">
        <span>{isPermission ? '允许这次操作？' : '需要你确认'}</span>
        <span className="pending-card__state">等待你的选择</span>
      </div>

      {isPermission ? (
        <>
          <div className="pending-card__question">{pending.question}</div>
          <div className="pending-card__options">
            {pending.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`btn btn--sm${option.value === 'approved' ? ' btn--primary' : ''}`}
                disabled={disabled}
                title={option.description}
                onClick={() => onRespond([option.value])}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        // 提问：对齐 wuzu AskUserQuestion —— 每个问题一组：tab 胶囊 + 标题 +
        // 选项卡（标题 + 描述 + 勾选框）+ 自由输入框，底部「跳过 / 提交」
        <>
          {pending.groups.map((group, groupIndex) => (
            <div key={groupIndex} className="pending-card__group">
              <div className="pending-card__group-head">
                {group.tab ? <span className="pending-card__tab">{group.tab}</span> : null}
                <span className="pending-card__group-question">{group.question}</span>
              </div>
              {group.options.length > 0 ? (
                <div className="pending-card__choices">
                  {group.options.map((option) => {
                    const checked = (groupSelected[groupIndex] ?? []).includes(option.value)
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`pending-card__choice${checked ? ' pending-card__choice--on' : ''}`}
                        aria-pressed={checked}
                        disabled={disabled}
                        onClick={() => toggle(groupIndex, option.value, group.multiSelect)}
                      >
                        <span className="pending-card__choice-body">
                          <span className="pending-card__choice-label">{option.label}</span>
                          {option.description ? (
                            <span className="pending-card__choice-desc">{option.description}</span>
                          ) : null}
                        </span>
                        <span
                          className={`pending-card__choice-box${group.multiSelect ? '' : ' pending-card__choice-box--radio'}`}
                        >
                          {checked ? <Icon name="check" size={16} /> : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
              {group.allowInput ? (
                <input
                  type="text"
                  className="pending-card__input"
                  aria-label={group.question}
                  placeholder="或直接输入回复…"
                  disabled={disabled}
                  value={groupInput[groupIndex] ?? ''}
                  onChange={(event) =>
                    setGroupInput((prev) => ({ ...prev, [groupIndex]: event.target.value }))
                  }
                />
              ) : null}
            </div>
          ))}
          <div className="pending-card__actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={disabled}
              onClick={() => onRespond(['跳过'])}
            >
              跳过
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={disabled}
              onClick={() => {
                const values: string[] = []
                pending.groups.forEach((group, groupIndex) => {
                  const picked = groupSelected[groupIndex] ?? []
                  const freeText = (groupInput[groupIndex] ?? '').trim()
                  if (group.multiSelect) {
                    values.push(...picked)
                  } else if (picked.length > 0) {
                    values.push(picked[0])
                  }
                  if (freeText) values.push(freeText)
                })
                onRespond(values.length > 0 ? values : ['跳过'])
              }}
            >
              提交
            </button>
          </div>
        </>
      )}

      {isPermission ? (
        <div className="pending-card__footer">
          <button
            type="button"
            className="btn btn--sm btn--danger-ghost"
            disabled={disabled || allowAllBusy}
            title="本会话内所有命令不再询问，并放行当前这一步（注意：同时会解除 Agent 的工作区路径限制）"
            onClick={() => void allowAll()}
          >
            <Icon name="shield" size={16} />
            {allowAllBusy ? '切换中…' : '本会话改为完全访问并放行'}
          </button>
          {allowAllError ? (
            <span className="pending-card__hint pending-card__hint--error">
              未切换会话模式：{allowAllError}
            </span>
          ) : (
            <span className="pending-card__hint">连续被拦时用它一次放开</span>
          )}
        </div>
      ) : null}

      {disabled ? <div className="pending-card__hint">等待上一轮响应结束后可继续操作</div> : null}
    </div>
  )
}

/**
 * 已处理的交互记录只保留一条可展开的时间线摘要。
 * RootRun 会永久保留 answered 记录以保证幂等应答和审计，因此不能在 UI
 * 层把每一条记录都当成新的待办卡片渲染。
 */
function InteractionHistory({ interactions }: { interactions: PendingInteraction[] }): JSX.Element {
  const permissionCount = interactions.filter(item => item.kind === 'permission').length
  const summary = '确认记录'

  const choiceText = (pending: PendingInteraction): string => {
    if (!pending.output) return pending.status === 'answered' ? '已提交' : pending.requestId && pending.runId ? '未执行' : '请重新发起任务'
    // Free-text answers can contain commas; preserve the submitted text exactly.
    return pending.output
  }

  const statusText = (pending: PendingInteraction): string => {
    if (pending.status === 'answered') {
      if (pending.kind === 'permission') {
        if (pending.output === 'approved') return '已允许这次操作'
        if (pending.output === 'rejected') return '已拒绝这次操作'
        return '已处理，未记录授权结果'
      }
      return '已应答 Agent 提问'
    }
    if (!pending.requestId || !pending.runId) return '历史请求，当前不可应答'
    return '已结束，未执行'
  }

  return (
    <details className="interaction-history pending-card--history">
      <summary className="pending-card__summary">
        <Icon name="chevron" size={14} className="interaction-history__chevron" />
        <Icon name={permissionCount === interactions.length ? 'shield' : 'chat'} size={16} />
        <span className="pending-card__summary-text">{summary}</span>
        <span className="pending-card__summary-choice">{interactions.length} 项</span>
      </summary>
      <div className="pending-card__history-list">
        {interactions.map((pending, index) => (
          <div
            className="pending-card__history-item"
            key={pending.requestId ?? pending.toolCallId ?? index}
            // Older persisted runs may predate requestId; toolCallId is still
            // stable and keeps each audit entry addressable after recovery.
            data-request-id={pending.requestId ?? pending.toolCallId}
          >
            <div className="pending-card__history-row interaction-history__result">
              <Icon name={pending.kind === 'permission' ? 'shield' : 'chat'} size={14} />
              <span>{statusText(pending)}</span>
              {pending.kind === 'ask' ? (
                <span className="pending-card__summary-choice">{choiceText(pending)}</span>
              ) : null}
            </div>
            <div className="pending-card__history-question">{
              pending.kind === 'ask' && pending.groups.length > 1
                ? pending.groups.map((group, index) => `${index + 1}. ${group.question}`).join('\n')
                : pending.question
            }</div>
          </div>
        ))}
      </div>
    </details>
  )
}

function ToolItem({
  tool,
  sessionId
}: {
  tool: ToolActivity
  sessionId: string
}): JSX.Element {
  // 子代理： Trae 风格执行详情卡片（目标任务 / 执行详情 / 返回结果 / 底栏统计）
  if (tool.name === 'subagent') return <SubagentCard tool={tool} sessionId={sessionId} />
  if (tool.name === 'execute_cmd' && tool.commandJob) return <CommandJobCard job={tool.commandJob} sessionId={sessionId} />

  // 文件写入/删除：git diff 风格卡片（引擎下发了内容快照时）
  if (
    (tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'delete_file') &&
    tool.change
  ) {
    return <FileChangeCard change={tool.change} state={tool.state} />
  }

  // 其余过程性工具由 ProcessSection 里的紧凑日志行承接，走到这里说明是兜底
  return <CompactToolRow tool={tool} />
}
