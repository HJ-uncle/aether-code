import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useChat, type ChatMessage, type ToolActivity } from '@renderer/core/engine/useChat'
import type { PendingInteraction } from '@renderer/core/engine/pending'
import { TodoTray } from './TodoTray'
import { ChangesPanel } from './ChangesPanel'
import { FileChangeCard } from './FileChangeCard'
import { SubagentCard } from './SubagentCard'
import { Markdown } from './Markdown'
import { toolDisplayName, toolParamSummary } from './tool-names'
import { useModels } from '@renderer/core/engine/model-store'
import { changeSecurityMode } from '@renderer/core/engine/security-store'
import { requestOrThrow } from '@renderer/core/engine/client'
import { openAppSettings } from '@renderer/contrib/settings/app-settings-navigation'
import { refreshGit } from '@renderer/core/git/git-store'
import { currentWorkspacePaths, useWorkspace } from '@renderer/core/workspace/workspace-store'
import { Icon } from '@renderer/workbench/icons'
import { Dialog } from '@renderer/workbench/Dialog'
import { Popover } from '@renderer/workbench/Popover'
import { ModelPicker } from '../models/ModelPicker'
import { ComposerOptions } from './ComposerOptions'
import {
  formatDuration,
  formatTimestamp,
  formatTokens,
  groupIntoTurns,
  sumUsage,
  type UsageDetailRow
} from './usage'
import { useAttachments } from './useAttachments'

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

/** 主题化确认 / 提示弹窗（替代原生 window.confirm / alert） */
interface ConfirmState {
  title: string
  body: string
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
}

function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }): JSX.Element {
  return (
    <Dialog
      title={state.title}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`btn btn--primary${state.danger ? ' btn--danger' : ''}`}
            onClick={() => {
              onClose()
              state.onConfirm()
            }}
          >
            {state.confirmText ?? '确定'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.6 }}>{state.body}</p>
    </Dialog>
  )
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
  const { ready, settings, updateSettings, settingsLoaded } = useApp()
  const { messages, streaming, todos, send, respond, abort, loadHistory, deleteTurn, retryFrom, revertFrom, mergeAndSend, queueLength } = useChat()
  const { models, loaded: modelsLoaded } = useModels()
  const workspace = useWorkspace()
  const [input, setInput] = useState('')
  /** 多选模式：按消息粒度勾选，复制或导出为 Markdown */
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  /** 主题化确认 / 提示弹窗；null 关闭 */
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  /** 轻提示（复制 / 导出等即时反馈），短暂展示后自动消失 */
  const [toast, setToast] = useState<string | null>(null)
  /** 用户手动选择的模型；null 表示未选择，跟随设置（设置异步加载后自动生效） */
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const modelId = selectedModelId ?? settings.lastModelId
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 附件：落盘到当前工作区，发送时把相对路径交给引擎（图片→视觉/OCR，文本→smart_read）
  const attach = useAttachments(workspace.root)
  // 附件进度提示只在出现后短暂停留，避免常驻噪音
  const [attachHint, setAttachHint] = useState<string | null>(null)

  // 会话累计用量：按消息里的 usage 帧汇总，作为工具栏「模型 / Token / 使用时间」的数据源
  const usageTotal = useMemo(() => sumUsage(messages), [messages])
  // 按用户提问切分轮次：每轮末尾展示「一问一答」的累计 token
  const turns = useMemo(() => groupIntoTurns(messages), [messages])

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

  // 启动 / 会话切换时回放引擎侧历史：conversations 表本来是 AI 的上下文来源，
  // 把同一份数据还原到界面，解决「重启后界面空白但 AI 记得一切」的割裂感
  const historyLoadedRef = useRef('')
  useEffect(() => {
    if (!ready || !sessionId) return
    if (historyLoadedRef.current === sessionId) return
    historyLoadedRef.current = sessionId
    void loadHistory(sessionId)
  }, [ready, sessionId, loadHistory])

  // 新内容到达时保持贴底
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // 输入框高度随内容增长：resize:none 后要靠 JS 改高度，
  // 先归零再读 scrollHeight，否则缩短文本时高度降不下来
  const growInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useLayoutEffect(growInput, [input, growInput])

  // 一轮对话结束（完成/中止/出错）时刷新 git：Agent 改了哪些文件此刻刚落盘定局。
  // refreshGit 是模块级函数（引用恒定），不属于 hook 依赖
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refreshGit(workspace.root)
    wasStreaming.current = streaming
  }, [streaming, workspace.root])

  const selectModel = useCallback(
    (next: string) => {
      setSelectedModelId(next)
      void updateSettings({ lastModelId: next })
    },
    [updateSettings]
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
      // 从 store 直接读取而非依赖闭包：发送瞬间的根目录才是准确的
      workspacePaths: currentWorkspacePaths(),
      thinkingMode: resolveThinkingMode(settings.thinkingMode)
    }),
    [modelId, ready, sessionId, settings.lastAgentId, settings.thinkingMode]
  )

  const submit = useCallback(() => {
    const text = input.trim()
    // 允许「只发附件」：丢张截图直接问，是视觉模型的常见用法
    const files = attach.attachments
    if ((!text && files.length === 0) || attach.uploading || !ready || !sessionId) return
    // 流式进行中不再拦截：send 内部会入队，当前流结束后自动按序发出
    setInput('')
    attach.clear()
    void send(text, {
      ...buildSendOptions(),
      attachments: files.length > 0 ? files : undefined
    })
  }, [attach, buildSendOptions, input, ready, send, sessionId])

  /** 合并发送：把输入框内容与排队中的消息合并成一条发出 */
  const submitMerged = useCallback(() => {
    const text = input.trim()
    const files = attach.attachments
    if ((!text && files.length === 0) || attach.uploading || !ready || !sessionId) return
    setInput('')
    attach.clear()
    void mergeAndSend(text, {
      ...buildSendOptions(),
      attachments: files.length > 0 ? files : undefined
    })
  }, [attach, buildSendOptions, input, mergeAndSend, ready, sessionId])

  /**
   * 授权卡片上的「一路放行」入口。
   *
   * 只切模式不动当前这一步是没用的：引擎已经对本次调用下了 ask 决定并在等应答，
   * 切模式不会让挂起的流自己恢复。所以调用方要「先切模式、再放行」——
   * 切模式保证恢复后的后续命令不再被拦，放行用于解开眼前这一次。
   */
  const allowAllForSession = useCallback(
    () => changeSecurityMode(sessionId, 'full-access'),
    [sessionId]
  )

  /**
   * 新建会话：换上新的会话 ID 即开一条全新对话。
   *
   * 不引入会话对象：sessionId 本就跟随 settings.lastSessionId，换 ID 后
   * 上面的回放 effect 会重新取历史（新 ID 无记录 → 空对话）。
   * 若正有流在跑先中止，避免把上一会话的输出写进新会话里。
   */
  const createSession = useCallback(() => {
    if (streaming) abort()
    const generated = newSessionId()
    void updateSettings({ lastSessionId: generated })
  }, [abort, streaming, updateSettings])

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
    setConfirmState({
      title: '操作失败',
      body: prefix ? `${prefix}${message}` : message,
      confirmText: '知道了',
      onConfirm: () => undefined
    })
  }, [])

  /** 删除引擎侧该消息之后的历史并重新发送（重新发送 / 重新生成共用） */
  const retryTurn = useCallback(
    (message: ChatMessage) => {
      // 重新生成（助手消息）等价于从它前面的用户提问处重发
      const index = messages.findIndex((m) => m.id === message.id)
      const userMessage =
        message.role === 'user' ? message : messages.slice(0, index).reverse().find((m) => m.role === 'user')
      if (!userMessage) return
      setConfirmState({
        title: message.role === 'user' ? '重新发送' : '重新生成',
        body: message.role === 'user' ? '删除此后的对话并重新发送？' : '删除本轮回答并重新生成？',
        danger: true,
        onConfirm: () =>
          void retryFrom(userMessage, {
            sessionId,
            agentId: settings.lastAgentId || undefined,
            model: modelId || undefined,
            workspacePaths: currentWorkspacePaths(),
            thinkingMode: resolveThinkingMode(settings.thinkingMode)
          }).catch(showError)
      })
    },
    [messages, modelId, retryFrom, sessionId, settings.lastAgentId, settings.thinkingMode, showError]
  )

  const deleteTurnById = useCallback(
    (message: ChatMessage) => {
      setConfirmState({
        title: '删除本轮',
        body: '删除这一轮问答（含引擎侧历史）？',
        danger: true,
        confirmText: '删除',
        onConfirm: () => void deleteTurn(sessionId, message).catch((err) => showError(err))
      })
    },
    [deleteTurn, sessionId, showError]
  )

  /** 消息级回退（对齐 wuzu revert-files）：恢复该消息后全部文件改动（含已保留）并截断对话，原文回填输入框 */
  const revertToMessage = useCallback(
    (message: ChatMessage) => {
      setConfirmState({
        title: '回退到此处',
        body: '撤销此消息及后续轮次的全部修改（包含已保留的修改），成功后删除对应对话。文件无法自动恢复的大改动会跳过。',
        danger: true,
        confirmText: '回退',
        onConfirm: () => {
          const content = message.content
          void revertFrom(sessionId, message)
            .then(() => setInput(content))
            .catch(showError)
        }
      })
    },
    [revertFrom, sessionId, showError]
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

  // 未配置任何模型时对话必然失败，提前给出明确出口而不是等报错
  const needsModel = ready && modelsLoaded && models.length === 0

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
    if (!workspace.root) {
      setCgIndex((s) => ({ ...s, initialized: false, known: true }))
      return
    }
    try {
      const s = await requestOrThrow<{ initialized: boolean; indexing: boolean }>({
        method: 'GET',
        path: '/codegraph/status',
        query: { sessionId, path: workspace.root }
      })
      setCgIndex((prev) => ({ ...prev, initialized: s.initialized, known: true, busy: s.indexing }))
      if (s.indexing) pollCgStatus()
    } catch {
      setCgIndex((prev) => ({ ...prev, initialized: false, known: true }))
    }
    // pollCgStatus 定义在下方（useCallback 引用稳定），此处不列入依赖以免循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, workspace.root])

  /** 轮询引擎 /codegraph/status 直到索引完成/失败；label 短暂展示结果后复位 */
  const pollCgStatus = useCallback(() => {
    stopCgPoll()
    cgPollRef.current = setInterval(() => {
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
            query: { sessionId, path: workspace.root || undefined }
          })
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
          stopCgPoll()
          setCgIndex((prev) => ({ ...prev, busy: false, label: '状态查询失败' }))
        }
        setTimeout(() => setCgIndex((prev) => ({ ...prev, busy: false, label: null })), 4000)
      })()
    }, 1500)
  }, [sessionId, workspace.root, stopCgPoll])

  const startCgIndex = useCallback(async () => {
    if (!sessionId || !workspace.root || cgIndex.busy) return
    setCgIndex((prev) => ({ ...prev, busy: true, label: '启动中…' }))
    try {
      const r = await requestOrThrow<{
        started: boolean
        alreadyRunning?: boolean
        alreadyInitialized?: boolean
      }>({
        method: 'POST',
        path: '/codegraph/index',
        body: { sessionId, path: workspace.root }
      })
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
      setCgIndex((prev) => ({
        ...prev,
        busy: false,
        label: e instanceof Error ? e.message.slice(0, 40) : '请求失败'
      }))
      setTimeout(() => setCgIndex((prev) => ({ ...prev, busy: false, label: null })), 4000)
    }
  }, [sessionId, workspace.root, cgIndex.busy, pollCgStatus])

  // 进入会话 / 切换项目时同步一次索引状态（决定页脚是否显示「建索引」）
  useEffect(() => {
    void refreshCgState()
  }, [refreshCgState])

  // 卸载时停止轮询
  useEffect(() => stopCgPoll, [stopCgPoll])

  return (
    <div className="chat">
      <div className="chat__topbar">
        {workspace.root ? (
          <span className="chat__workspace" title={`Agent 的工作区：${workspace.root}`}>
            {workspace.root.replace(/\\/g, '/').split('/').pop()}
          </span>
        ) : null}
        <div className="chat__toolbar-spacer" />
        {usageTotal.total > 0 ? (
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
          onClick={createSession}
        >
          <Icon name="plus" size={14} />
          新建
        </button>
        <button
          type="button"
          className={`chat__toolbar-btn${selectMode ? ' is-active' : ''}`}
          disabled={messages.length === 0}
          title="多选消息，可复制或导出为 Markdown"
          onClick={toggleSelectMode}
        >
          <Icon name="check" size={14} />
          多选
        </button>
      </div>

      {selectMode ? (
        <div className="chat__select-bar">
          <button type="button" className="chat__toolbar-btn" onClick={toggleAll}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="chat__select-count">已选 {selectedIds.size} 项</span>
          <div className="chat__toolbar-spacer" />
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
          <button type="button" className="chat__toolbar-btn" onClick={toggleSelectMode}>
            完成
          </button>
        </div>
      ) : null}

      <div className="chat__messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat__empty">
            <h2>Agent IDE</h2>
            <p>
              {ready
                ? '引擎已就绪。输入你的问题或任务，Agent 会调用工具直接在你的工作区里完成。'
                : '正在准备引擎，就绪后即可开始对话。'}
            </p>
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className="chat__turn">
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
                    usage={message.id === lastAssistantId ? usage : undefined}
                    disabled={streaming}
                  onAllowAll={allowAllForSession}
                  selectionMode={selectMode}
                  selected={selectedIds.has(message.id)}
                  onToggleSelect={() => toggleMessage(message.id)}
                  onRespond={(values) =>
                    void respond(values, {
                      sessionId,
                      model: modelId || undefined,
                      workspacePaths: currentWorkspacePaths(),
                      thinkingMode: resolveThinkingMode(settings.thinkingMode)
                    })
                  }
                  onCopy={copyMessage}
                  onRetryFrom={retryTurn}
                  onRevertFiles={revertToMessage}
                  onDeleteTurn={deleteTurnById}
                  canAct={!streaming && !selectMode}
                />
                ))
              })()}
            </div>
          ))
        )}
      </div>

      {needsModel ? (
        <div className="chat__notice">
          <span>尚未配置模型，对话会失败。</span>
          <button type="button" className="link" onClick={() => openAppSettings('models')}>
            去添加模型
          </button>
        </div>
      ) : null}

      <TodoTray todos={todos} />

      <ChangesPanel sessionId={sessionId} streaming={streaming} />

      <div
        className={`chat__composer${attach.dragging ? ' is-dragover' : ''}`}
        onDragOver={(event) => {
          // 不 preventDefault 的话浏览器会直接打开被拖入的文件
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
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
          attach.accept([...event.dataTransfer.files])
        }}
      >
        <div className="chat__surface">
          {attach.attachments.length > 0 || attach.uploading ? (
            <div className="chat__attach-strip">
              {attach.attachments.map((file) => (
                <span key={file.path} className="attach-chip" title={file.path}>
                  <Icon name={file.type.startsWith('image/') ? 'image' : 'file'} size={12} />
                  <span className="attach-chip__name">{file.name}</span>
                  <span className="attach-chip__size">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    className="attach-chip__remove"
                    title="移除附件"
                    aria-label={`移除附件 ${file.name}`}
                    onClick={() => attach.remove(file.path)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
              {attach.uploading ? (
                <span className="attach-chip attach-chip--busy">上传中…</span>
              ) : null}
            </div>
          ) : null}

          <textarea
            ref={inputRef}
            className="chat__input"
            value={input}
            placeholder={
              ready ? '输入消息，Enter 发送，Shift+Enter 换行；可拖入或粘贴文件' : '引擎未就绪…'
            }
            rows={2}
            disabled={!ready}
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              // 粘贴截图 / 复制的文件：剪贴板里的 File 与拖拽拿到的是同一种对象
              const files = [...event.clipboardData.files]
              if (files.length === 0) return
              event.preventDefault()
              attach.accept(files)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {attachHint ? <div className="chat__attach-hint">{attachHint}</div> : null}
          <input
            ref={attach.fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              // 清空 value：否则再次选择同一个文件不会触发 change
              event.target.value = ''
              attach.accept(files)
            }}
          />

          {/* 工具条：左「＋ / 权限 / Agent」，右「模型 / 语音 / 发送」——同 Trae 的排布 */}
          <div className="chat__toolbar">
            <button
              type="button"
              className={`chat__icon-btn${attach.dragging ? ' is-active' : ''}`}
              disabled={!ready || attach.uploading || !workspace.root}
              title={
                workspace.root
                  ? '添加附件（图片 / 文本 / 文档），也可直接拖入或粘贴'
                  : '先打开一个项目目录再添加附件'
              }
              aria-label="添加附件"
              onClick={attach.pick}
            >
              <Icon name="plus" size={16} />
            </button>

            <ComposerOptions sessionId={sessionId} />

            {/* 仅当项目「尚未建索引」时才露出建索引入口；已建索引则不占位（重建走设置页 / 菜单） */}
            {cgIndex.known && !cgIndex.initialized ? (
              <button
                type="button"
                className={`chat__index-cta${cgIndex.busy ? ' is-active' : ''}`}
                disabled={!ready || !sessionId || !workspace.root || cgIndex.busy}
                title={
                  workspace.root
                    ? `为「${workspace.root.replace(/\\/g, '/').split('/').pop()}」创建代码图索引（Agent 随之可查询符号 / 调用关系 / 影响面）`
                    : '先打开一个项目目录再创建索引'
                }
                onClick={() => void startCgIndex()}
              >
                <Icon name="search" size={13} />
                <span className="picker__label">{cgIndex.label ?? '建索引'}</span>
              </button>
            ) : null}

            <div className="chat__toolbar-spacer" />

            <ModelPicker
              value={modelId}
              onChange={selectModel}
              onManage={() => openAppSettings('models')}
            />

            {streaming ? (
              <>
                {queueLength > 0 ? (
                  <button
                    type="button"
                    className="chat__send chat__send--merge"
                    title={`把输入框内容与队列中 ${queueLength} 条消息合并成一条发送`}
                    disabled={!input.trim() && attach.attachments.length === 0}
                    aria-label="合并发送"
                    onClick={submitMerged}
                  >
                    <Icon name="copy" size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="chat__send chat__send--stop"
                  title="停止生成"
                  aria-label="停止生成"
                  onClick={abort}
                >
                  <Icon name="stop" size={14} />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="chat__send"
                disabled={
                  !ready || attach.uploading || (!input.trim() && attach.attachments.length === 0)
                }
                title="发送（Enter）"
                aria-label="发送"
                onClick={submit}
              >
                <Icon name="send" size={14} />
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

      {confirmState ? <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} /> : null}
    </div>
  )
}

// ==================== 消息渲染 ====================

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
            const state =
              tool.state === 'done'
                ? '成功'
                : tool.state === 'error'
                  ? '失败'
                  : tool.state === 'running'
                    ? '执行中'
                    : '已停止'
            const summary = tool.args ? toolParamSummary(tool.args) : ''
            return `- ${toolDisplayName(tool.name)}${summary ? `：${summary}` : ''}（${state}）`
          })
          parts.push(`\n**工具调用**\n\n${toolLines.join('\n')}`)
        }
      }

      if (message.content) parts.push(`\n${message.content}`)
      return parts.join('\n')
    })
    .join('\n\n---\n\n')
}

function MessageItem({
  message,
  usage,
  disabled,
  onAllowAll,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onRespond,
  onCopy,
  onRetryFrom,
  onRevertFiles,
  onDeleteTurn,
  canAct
}: {
  message: ChatMessage
  /** 该轮的累计用量：只挂在最后一条 AI 消息底部的过程行上 */
  usage?: TurnUsageInfo
  disabled: boolean
  /** 把本会话切成 full-access（用于授权卡片的一键放行） */
  onAllowAll: () => Promise<void>
  /** 多选模式：true 时消息头部显示复选框 */
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  onRespond: (values: string[]) => void
  /** 复制该消息文本 */
  onCopy: (message: ChatMessage) => void
  /** 从该用户消息处删除此后内容并重新发送（重新发送 / 重新生成共用） */
  onRetryFrom: (message: ChatMessage) => void
  /** 消息级回退：恢复该消息后所有文件改动（含已保留）并截断对话 */
  onRevertFiles: (message: ChatMessage) => void
  /** 删除该消息所在的一整轮对话 */
  onDeleteTurn: (message: ChatMessage) => void
  /** 是否允许执行重试/删除（流式进行中或多选模式下禁止） */
  canAct: boolean
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
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
      {isUser ? (
        <>
          <button
            type="button"
            className="message__action"
            title="回退到此处：撤销此消息及后续轮次的全部文件修改（含已保留），并删除对应对话"
            aria-label="回退到此处"
            disabled={!canAct}
            onClick={() => onRevertFiles(message)}
          >
            <Icon name="restart" size={13} />
          </button>
          <button
            type="button"
            className="message__action"
            title="删除此后的对话并重新发送"
            aria-label="重新发送"
            disabled={!canAct}
            onClick={() => onRetryFrom(message)}
          >
            <Icon name="send" size={13} />
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
          <Icon name="restart" size={13} />
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
        <Icon name="trash" size={13} />
      </button>
    </div>
  )

  if (isUser) {
    // 用户消息：右对齐气泡，无角色标签 —— 对齐靠位置与底色区分
    return (
      <article className="message message--user">
        {pick}
        <div className="message__bubble-wrap">
          {actions}
          <div className="message__bubble">{message.content}</div>
          {message.attachments && message.attachments.length > 0 ? (
            <div className="message__attachments">
              {message.attachments.map((file) => (
                <span key={file.path} className="attach-chip" title={file.path}>
                  <Icon name={file.type.startsWith('image/') ? 'image' : 'file'} size={12} />
                  <span className="attach-chip__name">{file.name}</span>
                  <span className="attach-chip__size">{formatBytes(file.size)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article className="message message--assistant">
      {pick}

      <MessageTimeline message={message} streaming={streaming} />

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
        ) : null}
        {actions}
      </div>

      {message.pending ? (
        <PendingCard
          pending={message.pending}
          answered={message.answered}
          disabled={disabled}
          onAllowAll={onAllowAll}
          onRespond={onRespond}
        />
      ) : null}

      {message.error ? <div className="message__error">{message.error}</div> : null}
    </article>
  )
}

/** 全尺寸卡片工具（diff / 子代理）：不进折叠过程块，永远在原位全显 */
function isFullSizeTool(tool: ToolActivity): boolean {
  return (
    tool.name === 'subagent' ||
    ((tool.name === 'write_file' || tool.name === 'edit_file' || tool.name === 'delete_file') &&
      Boolean(tool.change))
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

/** 内联段落：正文段 或 全尺寸卡片（diff / 子代理），在过程块之后按原顺序渲染 */
type InlineSegment = { type: 'tool'; tool: ToolActivity } | { type: 'content'; text: string }

/**
 * 消息时间线：思考 / 工具调用合并成一个可折叠过程块，正文与全尺寸卡片按序排在其后。
 *
 * useChat 在收 SSE 帧时同步维护 message.items（帧严格按发生顺序到达）。
 * 对齐 wuzu-client 的 CliThinkingTimeline：一轮里所有过程性条目（思考段、
 * 普通工具调用）收进**同一个**「过程 · 思考 N 段 · 工具调用 M」折叠块，
 * 块内按真实时间顺序穿插；正文段与 diff/子代理卡片信息量大，不进折叠，
 * 在块下按原顺序全显。
 */
function MessageTimeline({
  message,
  streaming
}: {
  message: ChatMessage
  streaming: boolean
}): JSX.Element | null {
  const { processEntries, inline } = useMemo(() => {
    const toolById = new Map(
      message.tools.filter((tool) => !tool.hidden).map((tool) => [tool.id, tool])
    )
    const processEntries: CompactEntry[] = []
    const inline: InlineSegment[] = []
    const seen = new Set<string>()

    for (const item of message.items) {
      if (item.kind === 'thinking') {
        processEntries.push({ kind: 'thinking', text: item.text })
      } else if (item.kind === 'tool') {
        const tool = toolById.get(item.id)
        if (!tool || seen.has(tool.id)) continue
        seen.add(tool.id)
        if (isFullSizeTool(tool)) inline.push({ type: 'tool', tool })
        else processEntries.push({ kind: 'tool', tool })
      } else if (item.kind === 'content') {
        inline.push({ type: 'content', text: item.text })
      }
      // interaction：应答卡片由 MessageItem 单独渲染，时间线不占位
    }

    // 兜底：tools 里存在但时间线没记录的条目（异常帧序），挂到过程块末尾
    for (const tool of toolById.values()) {
      if (seen.has(tool.id)) continue
      if (isFullSizeTool(tool)) inline.push({ type: 'tool', tool })
      else processEntries.push({ kind: 'tool', tool })
    }
    return { processEntries, inline }
  }, [message.items, message.tools])

  if (processEntries.length === 0 && inline.length === 0) {
    return streaming && !message.pending ? (
      <div className="message__streaming-hint">
        <span className="message__spinner" />
        处理中…
      </div>
    ) : null
  }

  return (
    <>
      {processEntries.length > 0 ? (
        <ProcessGroup entries={processEntries} streaming={streaming} />
      ) : null}
      {inline.map((segment, index) =>
        segment.type === 'tool' ? (
          <div key={`t-${segment.tool.id}`} className="message__tools">
            <ToolItem tool={segment.tool} />
          </div>
        ) : (
          <div key={`c-${index}`} className="message__content">
            <Markdown text={segment.text} />
          </div>
        )
      )}
      {streaming && !message.pending ? (
        <div className="message__streaming-hint">
          <span className="message__spinner" />
          处理中…
        </div>
      ) : null}
    </>
  )
}

/**
 * 过程区（思考 + 过程性工具调用）
 *
 * 对齐 wuzu-client 的双层折叠形制：
 * - 单条思考 / 工具调用是一行 24px 紧凑日志行（圆点 + 名称 + 摘要 + hover 才出现的箭头）；
 * - 一轮结束后，整段过程收成一行摘要「过程 · 思考 N 段 · 工具调用 M」，点开原样还原；
 *   流式进行中保持展开，方便实时围观；用户手动点过后以用户为准。
 */
function ProcessGroup({
  entries,
  streaming
}: {
  entries: CompactEntry[]
  streaming: boolean
}): JSX.Element {
  // 折叠状态：默认流式展开 / 结束收起；一旦用户手动点过，以用户选择为准
  const [manual, setManual] = useState<boolean | null>(null)
  const expanded = manual ?? streaming

  const thinkingCount = entries.filter((entry) => entry.kind === 'thinking').length
  const toolCount = entries.length - thinkingCount
  const summaryParts: string[] = []
  if (thinkingCount > 0) summaryParts.push(`思考 ${thinkingCount} 段`)
  if (toolCount > 0) summaryParts.push(`工具调用 ${toolCount}`)
  const failCount = entries.filter(
    (entry) => entry.kind === 'tool' && entry.tool.state === 'error'
  ).length
  if (failCount > 0) summaryParts.push(`${failCount} 失败`)

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
        <Icon name="chevron" size={12} className="process__chevron" />
      </button>
      {expanded ? (
        <div className="process__body">
          {entries.map((entry, index) =>
            entry.kind === 'thinking' ? (
              <ThinkingRow key={`think-${index}`} text={entry.text} />
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
function ThinkingRow({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const preview = text.replace(/\s+/g, ' ')
  const truncated = preview.length > 90 ? `${preview.slice(0, 87)}…` : preview

  return (
    <div className="logline-wrap">
      <button
        type="button"
        className="logline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="logline__dot logline__dot--think" />
        <span className="logline__text" title={preview}>
          {truncated}
        </span>
        <Icon name="chevron" size={12} className="logline__chevron" />
      </button>
      {open ? (
        <div className="logline__detail">
          <pre>{text}</pre>
        </div>
      ) : null}
    </div>
  )
}

/** 紧凑工具行：7px 状态圆点 + 中文工具名 + 参数摘要，展开看原始参数与结果 */
function CompactToolRow({ tool }: { tool: ToolActivity }): JSX.Element {
  const [open, setOpen] = useState(false)
  const label = toolDisplayName(tool.name)
  const summary = toolParamSummary(tool.args)
  const hasDetail = Boolean(tool.args || tool.result)

  return (
    <div className="logline-wrap">
      <button
        type="button"
        className={`logline${hasDetail ? '' : ' logline--static'}`}
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={`logline__dot logline__dot--${tool.state === 'running' ? 'running' : tool.state === 'error' ? 'error' : 'done'}`}
        />
        <span className={`logline__name${tool.state === 'error' ? ' logline__name--error' : ''}`}>
          {label}
        </span>
        {summary ? (
          <span className="logline__summary" title={summary}>
            {summary}
          </span>
        ) : null}
        {hasDetail ? <Icon name="chevron" size={12} className="logline__chevron" /> : null}
      </button>
      {open && hasDetail ? (
        <div className="logline__detail">
          {tool.args ? <pre>{tool.args}</pre> : null}
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
          <Icon name="model" size={12} />
          <span className="turn-usage__value">{formatTokens(tokens)}</span>
          <span className="turn-usage__unit">tokens</span>
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
        <span className="usage-popover__total-unit">tokens</span>
        {duration ? <span className="usage-popover__meta">耗时 {duration}</span> : null}
      </div>
      {model ? (
        <div className="usage-detail usage-detail--meta">
          <div className="usage-detail__row">
            <span className="usage-detail__bar usage-detail__bar--input" />
            <span className="usage-detail__label">模型</span>
            <span className="usage-detail__value">{model}</span>
          </div>
          {stamp ? (
            <div className="usage-detail__row">
              <span className="usage-detail__bar usage-detail__bar--output" />
              <span className="usage-detail__label">对话时间</span>
              <span className="usage-detail__value">{stamp}</span>
            </div>
          ) : null}
          {duration ? (
            <div className="usage-detail__row">
              <span className="usage-detail__bar usage-detail__bar--cache" />
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
            <span className="usage-detail__value">{formatTokens(row.tokens)}</span>
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
          <Icon name="model" size={13} />
          <span className="usage-meter__tokens">{formatTokens(total)}</span>
          <span className="usage-meter__unit">tokens</span>
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
        <span className="usage-popover__total-unit">tokens</span>
      </div>
      <div className="usage-detail">
        {summary.map((row) => (
          <div
            key={row.label}
            className={`usage-detail__row${row.child ? ' usage-detail__row--child' : ''}`}
          >
            <span className={`usage-detail__bar usage-detail__bar--${row.group}`} />
            <span className="usage-detail__label">{row.label}</span>
            <span className="usage-detail__value">{formatTokens(row.tokens)}</span>
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
  answered,
  disabled,
  onAllowAll,
  onRespond
}: {
  pending: PendingInteraction
  answered?: string
  disabled: boolean
  onAllowAll: () => Promise<void>
  onRespond: (values: string[]) => void
}): JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const [allowAllBusy, setAllowAllBusy] = useState(false)
  const [allowAllError, setAllowAllError] = useState<string | null>(null)
  const isPermission = pending.kind === 'permission'
  const isAnswered = Boolean(answered)
  // 回传存的是 value（授权场景是 approved/rejected 英文值），回显时反查成中文 label
  const answeredText = answered
    ? answered
        .split('，')
        .map((value) => pending.options.find((option) => option.value === value)?.label ?? value)
        .join('、')
    : ''

  const toggle = (value: string): void => {
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value]
    )
  }

  /**
   * 一键放行：先切会话模式，再放行当前这一步。
   *
   * 切模式失败时**仍然放行**——用户点这个按钮的意图是「继续做下去」，
   * 而单次放行本身足以解开眼前这次拦截（引擎会把该命令写入会话白名单）。
   * 失败只提示，不阻断。
   */
  const allowAll = async (): Promise<void> => {
    setAllowAllBusy(true)
    setAllowAllError(null)
    try {
      await onAllowAll()
    } catch (err) {
      setAllowAllError(err instanceof Error ? err.message : String(err))
    } finally {
      setAllowAllBusy(false)
    }
    onRespond(['approved'])
  }

  /**
   * 已回答：卡片坍缩成一行「已确认记录」。
   *
   * 交互一旦完成就不再需要占屏 —— 保留整张卡片会让用户以为还在等答复
   * （警示色边框 + 大块留白）。这里只留一行摘要，需要看原始命令时展开。
   */
  if (isAnswered) {
    return (
      <details className="pending-card pending-card--done">
        <summary className="pending-card__summary">
          <Icon name={isPermission ? 'shield' : 'chat'} size={12} />
          <span className="pending-card__summary-text">
            {isPermission ? '已放行一次安全拦截' : '已应答 Agent 提问'}
          </span>
          <span className="pending-card__summary-choice">{answeredText}</span>
        </summary>
        <div className="pending-card__detail">
          <div className="pending-card__detail-label">{isPermission ? '被拦截的操作' : '问题'}</div>
          <div className="pending-card__question">{pending.question}</div>
        </div>
      </details>
    )
  }

  return (
    <div className={`pending-card${isPermission ? ' pending-card--permission' : ''}`}>
      <div className="pending-card__title">
        <span>{isPermission ? '安全策略需要你确认' : 'Agent 需要你的回答'}</span>
        <span className="pending-card__state">等待你的选择</span>
      </div>
      <div className="pending-card__question">{pending.question}</div>

      {pending.multiSelect ? (
        <>
          <div className="pending-card__options">
            {pending.options.map((option) => (
              <label key={option.value} className="pending-card__check">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  disabled={disabled}
                  onChange={() => toggle(option.value)}
                />
                <span>
                  {option.label}
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={disabled || selected.length === 0}
            onClick={() => onRespond(selected)}
          >
            提交
          </button>
        </>
      ) : (
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
            <Icon name="shield" size={12} />
            {allowAllBusy ? '切换中…' : '本会话改为完全访问并放行'}
          </button>
          {allowAllError ? (
            <span className="pending-card__hint pending-card__hint--error">
              切换模式失败（本次已放行）：{allowAllError}
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

function ToolItem({ tool }: { tool: ToolActivity }): JSX.Element {
  // 子代理： Trae 风格执行详情卡片（目标任务 / 执行详情 / 返回结果 / 底栏统计）
  if (tool.name === 'subagent') return <SubagentCard tool={tool} />

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
