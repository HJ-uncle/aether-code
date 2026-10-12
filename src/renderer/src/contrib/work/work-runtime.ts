import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useChat, type ChatAttachment, type SendOptions } from '@renderer/core/engine/useChat'
import { useModels } from '@renderer/core/engine/model-store'
import { restoreChatSnapshot, type ChatRecoverySnapshot } from '@renderer/core/engine/chat-recovery'
import {
  assertEngineSource,
  getEngineStorageKey,
  getEngineSource,
  isRemoteEngine
} from '@renderer/core/engine/source'
import {
  cancelAttachmentUpload,
  requestOrThrow,
  uploadAttachment
} from '@renderer/core/engine/client'
import { allowRoot, copyIntoWorkspace, pickFolder } from '@renderer/core/workspace/fs-client'
import { isSupportedFile } from '@renderer/contrib/chat/useAttachments'
import { buildMentionMessage, mentionToken, type Mention } from '@renderer/contrib/chat/mention-context'
import { ATTACHMENTS_DIRECTORY } from '@shared/attachments'
import { loadSessionThinkingMode, saveSessionThinkingMode, type SessionThinkingMode } from '../chat/session-thinking-store'
import { requestedThinkingMode } from '../chat/session-request-config'
import { getMemoryScopeState } from '@renderer/core/engine/memory-store'
import type { SubagentRun } from '@shared/subagent'
import { pollWorkTaskStatuses } from './work-status-poller'
import { getAppMode } from '@renderer/core/platform/app-mode'
import {
  flushWorkDrafts,
  getWorkDraft,
  getWorkState,
  updateWorkDraft,
  updateWorkState,
  useWorkState,
  workArtifacts,
  workStatus,
  type WorkArtifact,
  type WorkTask
} from './work-state'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Keep attachment bytes inside the engine-owned scratch workspace when the
 * user has not selected a project. The browser File API does not expose a
 * local path, so the engine workspace API is the only safe place to persist
 * these bytes without silently adopting Code's current project. */
function encodeBase64(data: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, Math.min(offset + chunkSize, data.length)))
  }
  return btoa(binary)
}

function scratchAttachmentPath(name: string): string {
  const base = name.split(/[\\/]/).filter(Boolean).at(-1) || 'file'
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_') || 'file'
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const extension = dot > 0 ? safe.slice(dot) : ''
  return `${ATTACHMENTS_DIRECTORY}/${stem}-${crypto.randomUUID()}${extension}`
}

/** Work owns its session IDs and drafts. The existing transport still uses the Code tool profile. */
export function useWorkController() {
  const { settings, ready: engineReady } = useApp()
  const source = getEngineStorageKey()
  const epoch = getEngineSource()
  const state = useWorkState(source)
  const chat = useChat({ commandOwner: 'work' })
  const { models } = useModels()
  const activeTask = state.tasks.find((task) => task.id === state.activeTaskId) ?? null
  const activeId = activeTask?.id ?? null
  const securitySessionId = activeId ?? state.homeSessionId ?? null
  const [thinkingSelection, setThinkingSelection] = useState<{ source: string; id: string; mode: SessionThinkingMode } | null>(null)
  const thinkingFor = (id: string): SessionThinkingMode =>
    thinkingSelection?.source === source && thinkingSelection.id === id ? thinkingSelection.mode : loadSessionThinkingMode(id, source) ?? settings.thinkingMode
  const thinkingMode = thinkingFor(securitySessionId ?? '')
  const setThinkingMode = (mode: SessionThinkingMode): void => {
    if (!securitySessionId) return
    saveSessionThinkingMode(securitySessionId, mode, source)
    setThinkingSelection({ source, id: securitySessionId, mode })
  }
  const [loaded, setLoaded] = useState<{ source: string; epoch: number; id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploadCount, setUploadCount] = useState(0)
  const [sending, setSending] = useState(false)
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const pendingStart = useRef<{ source: string; id: string; text: string; mentions: Mention[] } | null>(null)
  const submitted = useRef(
    new Map<
      string,
      { source: string; text: string; attachments: ChatAttachment[]; createdAt: number; preserveDraft: boolean }
    >()
  )
  const sendCountRef = useRef(0)
  const sendingTaskIdsRef = useRef(new Set<string>())
  const stoppingTaskIdsRef = useRef(new Set<string>())
  const taskRevisionsRef = useRef(new Map<string, number>())
  const invalidateStatusProbe = (id: string): void => {
    taskRevisionsRef.current.set(id, (taskRevisionsRef.current.get(id) ?? 0) + 1)
  }
  const { resumeStream, send: chatSend, abort, respond: chatRespond, isHistoryReady } = chat
  useEffect(() => () => flushWorkDrafts(source), [source])

  /**
   * Work keeps the selected project on the task so it can be restored after a
   * restart.  The main-process fs allow-list is intentionally process-scoped,
   * though, so a restored task must grant that previously selected root again
   * before the editor starts its document watcher.  Without this preflight the
   * first file read/watch after restarting Work is rejected as an out-of-workspace
   * path even though the task still points at the same project.
   *
   * The remote engine owns its workspace over HTTP and must never be passed to
   * the local fs bridge.  A stale/deleted local folder is advisory: keep the task
   * usable and surface the failure through the existing Work error area.
   */
  useEffect(() => {
    // Home has the same persisted directory selection before a task exists.
    // Once a task is active, never fall back to the stale home value: creating a
    // task intentionally copies the home selection into its own scope.
    const root = activeTask ? activeTask.workspacePath : state.homeWorkspacePath
    // Wait for the source snapshot before checking the mode.  It starts with an
    // embedded default during boot, while a configured remote engine has not yet
    // published its snapshot; authorizing that remote root locally would defeat
    // the local/remote workspace boundary.
    if (!engineReady || !root || isRemoteEngine()) return
    let alive = true
    void allowRoot(root).catch((cause: unknown) => {
      if (alive && epoch === getEngineSource()) setError(messageOf(cause))
    })
    return () => {
      alive = false
    }
  }, [activeTask?.workspacePath, engineReady, epoch, state.homeWorkspacePath])

  // Home needs a real session before the first message so the composer can expose
  // security mode immediately. It is replaced after a home task is created.
  useEffect(() => {
    if (state.homeSessionId) return
    updateWorkState(source, (previous) =>
      previous.homeSessionId
        ? previous
        : { ...previous, homeSessionId: 'work-home-' + crypto.randomUUID() }
    )
  }, [source, state.homeSessionId])

  const updateTask = useCallback(
    (id: string, patch: Partial<WorkTask>) => {
      if (patch.status !== undefined) invalidateStatusProbe(id)
      updateWorkState(source, previous => {
        const task = previous.tasks.find(item => item.id === id)
        if (!task || (Object.keys(patch) as Array<keyof WorkTask>).every(key => Object.is(task[key], patch[key]))) return previous
        return { ...previous, tasks: previous.tasks.map(item => item.id === id ? { ...item, ...patch } : item) }
      })
    },
    [source]
  )

  const probeAuthorityRef = useRef({ selectedId: activeId, selectedLive: false })
  probeAuthorityRef.current = {
    selectedId: activeId,
    selectedLive: Boolean(activeId && loaded?.id === activeId && loaded.source === source && loaded.epoch === epoch &&
      chat.sessionModel?.sessionId === activeId && chat.sessionModel.source === epoch && !chat.historyError &&
      (chat.streaming || chat.messages.findLast(message => message.role === 'assistant')?.status === 'waiting'))
  }
  /** SSE owns the selected run. Other rows use bounded, lightweight status probes. */
  useEffect(() => {
    if (!engineReady) return
    let cancelled = false
    let syncing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = async (): Promise<void> => {
      if (syncing) return
      syncing = true
      try {
        await pollWorkTaskStatuses({
          tasks: () => getWorkState(source).tasks,
          revision: id => taskRevisionsRef.current.get(id) ?? 0,
          shouldPoll: task => !stoppingTaskIdsRef.current.has(task.id) &&
            !(probeAuthorityRef.current.selectedId === task.id && probeAuthorityRef.current.selectedLive),
          isCurrent: () => !cancelled && epoch === getEngineSource(),
          request: id => requestOrThrow({ method: 'GET', path: '/chat/status', query: { sessionId: id } }),
          apply: (id, status) => updateTask(id, { status, updatedAt: Date.now() })
        })
      } finally {
        syncing = false
        if (!cancelled) timer = setTimeout(() => void sync(), document.hidden || getAppMode() !== 'work' ? 5000 : 1500)
      }
    }
    void sync()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [engineReady, epoch, source, updateTask])

  const optionsFor = useCallback(
    (task: WorkTask): SendOptions => ({
      sessionId: task.id,
      model: task.modelId || settings.lastModelId || undefined,
      workspacePaths: task.workspacePath ? [task.workspacePath] : undefined,
      attachments: task.attachments,
      thinkingMode: requestedThinkingMode(thinkingFor(task.id)),
      subagentModel: settings.subagentModelId || undefined,
      utilityModel: settings.utilityModelId || undefined,
      agentId: task.agentId || undefined,
      // An empty task resource array means "no manual override". Sending it
      // on every turn would be interpreted by the engine as an explicit
      // whitelist and would silently erase the selected Agent's own bindings.
      // The composer has no separate "disable all" state, so only non-empty
      // selections become request-level overrides; Agent bindings remain the
      // source of truth otherwise.
      skills: task.resources?.skills?.filter(Boolean).length ? task.resources.skills : undefined,
      mcpServers: task.resources?.mcpServers?.filter(Boolean).length ? task.resources.mcpServers : undefined,
      knowledgeBases: task.resources?.knowledgeBases?.filter(Boolean).length ? task.resources.knowledgeBases : undefined,
      // The shared picker persists this setting in the engine by session. An
      // unloaded UI must defer to that scope, never overwrite it with "off".
      memoryScope: getMemoryScopeState().sessionId === task.id && getMemoryScopeState().loaded
        ? getMemoryScopeState().scope ?? undefined : undefined
    }),
    [source, thinkingSelection, settings.lastModelId, settings.thinkingMode, settings.subagentModelId, settings.utilityModelId]
  )

  const sendTask = useCallback(
    async (task: WorkTask, text: string, mentions: Mention[] = task.mentions ?? [], preserveDraft = false): Promise<void> => {
      assertEngineSource(epoch)
      if (sendingTaskIdsRef.current.has(task.id)) return
      sendingTaskIdsRef.current.add(task.id)
      sendCountRef.current += 1
      setSending(true)
      setError(null)
      updateTask(task.id, { status: 'running', agentLocked: true, updatedAt: Date.now() })
      submitted.current.set(task.id, {
        source,
        text,
        attachments: preserveDraft ? [] : task.attachments,
        createdAt: Date.now(),
        preserveDraft
      })
      try {
        await chatSend(buildMentionMessage(text, mentions), optionsFor(preserveDraft ? { ...task, attachments: [] } : task))
        if (epoch !== getEngineSource()) return
        // A follow-up from the Agent panel is independent of an unsent composer
        // draft. Its attachments and mention offsets must stay untouched.
        if (preserveDraft) return
        const combined = [...task.sources, ...task.attachments]
        updateWorkState(source, (previous) => ({
          ...previous,
          tasks: previous.tasks.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  title:
                    item.title === '新任务'
                      ? text.trim().replace(/\s+/g, ' ').slice(0, 52) || item.title
                      : item.title,
                  draft: item.draft === task.draft && item.mentions === task.mentions ? '' : item.draft,
                  mentions: item.draft === task.draft && item.mentions === task.mentions ? [] : item.mentions,
                  attachments: item.attachments.filter(
                    (file) => !task.attachments.some((sent) => sent.path === file.path)
                  ),
                  sources: combined.filter(
                    (file, index) =>
                      combined.findIndex((other) => other.path === file.path) === index
                  ),
                  updatedAt: Date.now()
                }
              : item
          )
        }))
      } catch (cause) {
        if (epoch === getEngineSource()) {
          setError(messageOf(cause))
          updateTask(task.id, { status: 'error' })
        }
        if (preserveDraft) throw cause
      } finally {
        sendingTaskIdsRef.current.delete(task.id)
        sendCountRef.current = Math.max(0, sendCountRef.current - 1)
        setSending(sendCountRef.current > 0)
      }
    },
    [epoch, chatSend, optionsFor, updateTask, source]
  )
  const sendTaskRef = useRef(sendTask)
  useEffect(() => {
    sendTaskRef.current = sendTask
  }, [sendTask])

  useEffect(() => {
    if (!activeId || !engineReady) return
    let alive = true
    setError(null)
    setLoaded(null)
    void resumeStream(activeId)
      .then(async () => {
        if (!alive || epoch !== getEngineSource()) return
        setLoaded({ source, epoch, id: activeId })
        if (!isHistoryReady(activeId)) return
        const start = pendingStart.current
        if (start?.source === source && start.id === activeId) {
          pendingStart.current = null
          const task = getWorkState(source).tasks.find((item) => item.id === activeId)
          if (task) await sendTaskRef.current(task, start.text, start.mentions)
        }
      })
      .catch((cause) => {
        if (alive) {
          setLoaded({ source, epoch, id: activeId })
          setError(messageOf(cause))
        }
      })
    return () => {
      alive = false
    }
  }, [activeId, source, epoch, engineReady, resumeStream, isHistoryReady, historyAttempt])

  const restored = loaded?.source === source && loaded.epoch === epoch && loaded.id === activeId
  const messages = restored ? chat.messages : []
  const streaming = Boolean(restored && (chat.streaming || sending))
  const artifacts = useMemo(() => workArtifacts(messages), [messages])
  const pending = useMemo(
    () =>
      messages
        .flatMap((message) => message.interactions ?? (message.pending ? [message.pending] : []))
        .filter((item) => item.status !== 'answered'),
    [messages]
  )

  useEffect(() => {
    const observedId = chat.sessionModel?.sessionId
    if (!observedId || chat.sessionModel?.source !== epoch) return
    const next = workStatus(chat.messages, chat.streaming)
    const task = getWorkState(source).tasks.find((item) => item.id === observedId)
    if (next && task && next !== task.status)
      updateTask(observedId, { status: next, updatedAt: Date.now() })
    const sent = submitted.current.get(observedId)
    const last = chat.messages.filter((message) => message.role === 'assistant').at(-1)
    if (
      sent?.source === source &&
      last &&
      last.createdAt >= sent.createdAt &&
      !chat.streaming &&
      !sending
    ) {
      if (last.status === 'error' && task && !sent.preserveDraft) {
        const attachments = [...task.attachments, ...sent.attachments]
        updateTask(observedId, {
          draft: task.draft || sent.text,
          attachments: attachments.filter(
            (item, index) => attachments.findIndex((other) => other.path === item.path) === index
          )
        })
      }
      if (['done', 'error', 'aborted', 'interrupted'].includes(last.status))
        submitted.current.delete(observedId)
    }
  }, [epoch, chat.messages, chat.streaming, chat.sessionModel, source, sending, updateTask])

  const createTask = useCallback(
    async (text?: string, mentions: Mention[] = []): Promise<void> => {
      flushWorkDrafts(source)
      if (uploadCount) {
        setError('资料仍在上传，请完成后再新建任务。')
        return
      }
      const current = getWorkState(source)
      const fromHome = text !== undefined
      const draft = text ?? ''
      const id = (fromHome ? current.homeSessionId : null) ?? 'work-' + crypto.randomUUID()
      const now = Date.now()
      const task: WorkTask = {
        id,
        title: draft.trim().replace(/\s+/g, ' ').slice(0, 52) || '新任务',
        draft,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        workspacePath: current.homeWorkspacePath,
        modelId: current.homeModelId || settings.lastModelId,
        attachments: fromHome ? current.homeAttachments : [],
        sources: [],
        agentId: fromHome ? current.homeAgentId || undefined : undefined,
        mentions,
        resources: fromHome ? current.homeResources : { skills: [], mcpServers: [], knowledgeBases: [] },
        archived: false
      }
      if (fromHome && (draft.trim() || task.attachments.length))
        pendingStart.current = { source, id, text: draft, mentions }
      updateWorkState(source, (previous) => ({
        ...previous,
        tasks: [task, ...previous.tasks],
        activeTaskId: id,
        ...(fromHome ? { homeDraft: '', homeAttachments: [], homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } } : {})
      }))
    },
    [source, settings.lastModelId, uploadCount]
  )

  const selectTask = useCallback(
    (id: string): void => {
      flushWorkDrafts(source)
      if (!getWorkState(source).tasks.some((task) => task.id === id)) return
      setError(null)
      updateWorkState(source, (previous) => ({ ...previous, activeTaskId: id }))
      setHistoryAttempt((attempt) => attempt + 1)
    },
    [source]
  )

  const renameTask = useCallback(
    (id: string, title: string): void => {
      const next = title.trim().replace(/\s+/g, ' ').slice(0, 80)
      if (!next) throw new Error('任务名称不能为空')
      if (!getWorkState(source).tasks.some((task) => task.id === id)) return
      updateTask(id, { title: next, updatedAt: Date.now() })
    },
    [source, updateTask]
  )

  const archiveTask = useCallback(
    (id: string, archived = true): void => {
      const task = getWorkState(source).tasks.find((item) => item.id === id)
      if (!task) return
      updateWorkState(source, (previous) => ({
        ...previous,
        activeTaskId: archived && previous.activeTaskId === id ? null : previous.activeTaskId,
        tasks: previous.tasks.map((item) =>
          item.id === id
            ? { ...item, archived, archivedAt: archived ? Date.now() : undefined, updatedAt: Date.now() }
            : item
        )
      }))
      if (archived && activeId === id) setHistoryAttempt((attempt) => attempt + 1)
    },
    [source, activeId]
  )

  const continueTask = useCallback(
    (id: string): void => {
      invalidateStatusProbe(id)
      flushWorkDrafts(source)
      const task = getWorkState(source).tasks.find((item) => item.id === id)
      if (!task) return
      updateWorkState(source, (previous) => ({
        ...previous,
        activeTaskId: id,
        tasks: previous.tasks.map((item) =>
          item.id === id
            ? { ...item, archived: false, archivedAt: undefined, status: ['done', 'error', 'stopped', 'interrupted'].includes(item.status) ? 'draft' : item.status, updatedAt: Date.now() }
            : item
        )
      }))
      setError(null)
      setHistoryAttempt((attempt) => attempt + 1)
    },
    [source]
  )
  const showHome = useCallback((): void => {
    flushWorkDrafts(source)
    setError(null)
    updateWorkState(source, (previous) => ({ ...previous, activeTaskId: null }))
  }, [source])
  const setDraft = useCallback(
    (draft: string, mentions: Mention[] = []): void => {
      updateWorkDraft(source, activeId, draft, mentions)
    },
    [activeId, source]
  )
  const setModel = useCallback(
    (modelId: string): void => {
      if (activeTask && ['running', 'waiting'].includes(activeTask.status)) return
      if (activeId) updateTask(activeId, { modelId })
      else updateWorkState(source, (previous) => ({ ...previous, homeModelId: modelId }))
    },
    [activeId, activeTask, source, updateTask]
  )
  const setAgent = useCallback(
    (agentId: string): boolean => {
      if (activeTask && (activeTask.agentLocked || activeTask.status !== 'draft' || messages.length > 0)) return false
      if (activeId) updateTask(activeId, { agentId: agentId || undefined })
      else updateWorkState(source, (previous) => ({ ...previous, homeAgentId: agentId }))
      return true
    },
    [activeId, activeTask, messages.length, source, updateTask]
  )
  const resources = activeTask ? activeTask.resources ?? { skills: [], mcpServers: [], knowledgeBases: [] } : state.homeResources
  const setResource = useCallback((kind: 'skill' | 'mcp' | 'kb', id: string): void => {
    const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const update = (current: { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }) => ({
      ...current, [key]: current[key].includes(id) ? current[key] : [...current[key], id]
    })
    if (activeId) updateTask(activeId, { resources: update(activeTask?.resources ?? { skills: [], mcpServers: [], knowledgeBases: [] }) })
    else updateWorkState(source, previous => ({ ...previous, homeResources: update(previous.homeResources) }))
  }, [activeId, activeTask?.resources, source, updateTask])
  const removeResource = useCallback((kind: 'skill' | 'mcp' | 'kb', id: string): void => {
    const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : 'knowledgeBases'
    const update = (current: { skills: string[]; mcpServers: string[]; knowledgeBases: string[] }) => ({ ...current, [key]: current[key].filter(item => item !== id) })
    if (activeId) updateTask(activeId, { resources: update(activeTask?.resources ?? { skills: [], mcpServers: [], knowledgeBases: [] }) })
    else updateWorkState(source, previous => ({ ...previous, homeResources: update(previous.homeResources) }))
  }, [activeId, activeTask?.resources, source, updateTask])
  const send = useCallback(
    async (text?: string, mentions: Mention[] = []): Promise<void> => {
      flushWorkDrafts(source)
      const currentTaskSending = activeTask ? sendingTaskIdsRef.current.has(activeTask.id) : false
      if (!engineReady || streaming || currentTaskSending || pending.length || uploadCount > 0) return
      if (!activeTask) {
        const home = getWorkDraft(source, null)
        await createTask(text ?? home.text, mentions.length ? mentions : home.mentions)
        return
      }
      if (!restored || !isHistoryReady(activeTask.id)) return
      const currentTask = getWorkState(source).tasks.find(task => task.id === activeTask.id)
      if (!currentTask) return
      const draft = text ?? currentTask.draft
      if (!draft.trim() && !currentTask.attachments.length) return
      await sendTask(currentTask, draft, mentions.length ? mentions : currentTask.mentions ?? [])
    },
    [
      engineReady,
      streaming,
      sending,
      pending.length,
      uploadCount,
      activeTask,
      createTask,
      state.homeDraft,
      state.homeMentions,
      restored,
      sendTask,
      isHistoryReady,
      source
    ]
  )

  const stop = useCallback(async (): Promise<void> => {
    if (!activeTask || !engineReady) return
    invalidateStatusProbe(activeTask.id)
    stoppingTaskIdsRef.current.add(activeTask.id)
    setError(null)
    try {
      if (chat.streaming) await abort()
      else {
        await requestOrThrow({
          method: 'POST',
          path: '/chat/cancel',
          body: { sessionId: activeTask.id }
        })
        assertEngineSource(epoch)
        await resumeStream(activeTask.id)
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      stoppingTaskIdsRef.current.delete(activeTask.id)
      invalidateStatusProbe(activeTask.id)
    }
  }, [activeTask, engineReady, chat.streaming, abort, epoch, resumeStream])

  const continueSubagent = useCallback(async (run: SubagentRun, instruction: string): Promise<void> => {
    if (!activeTask || !instruction.trim()) throw new Error('请输入继续交给子代理的工作')
    if (!engineReady || !restored || !isHistoryReady(activeTask.id) || streaming || pending.length || uploadCount > 0)
      throw new Error('请等待当前任务完成或处理待确认事项，再继续子代理')
    const current = await requestOrThrow<SubagentRun>({ method: 'GET', path: `/subagent/runs/${encodeURIComponent(run.runId)}` })
    assertEngineSource(epoch)
    const latest = getWorkState(source)
    const task = latest.tasks.find(item => item.id === activeTask.id)
    if (latest.activeTaskId !== activeTask.id || !task || current.parentSessionId !== activeTask.id || current.runId !== run.runId)
      throw new Error('任务已切换，请在对应任务中继续子代理')
    if (['running', 'waiting'].includes(task.status) || !isHistoryReady(task.id))
      throw new Error('当前任务正在执行或等待确认，请完成后再继续子代理')
    if (['queued', 'running', 'cancelling'].includes(current.status)) throw new Error('这个子代理仍在运行，请等待本轮结束')
    if (sendingTaskIdsRef.current.has(activeTask.id)) throw new Error('当前任务已有请求正在发送')
    const prompt = `请继续已有子代理的工作，保留它的上下文。调用 subagent 工具并使用以下参数，不要创建一个替代子代理：\n${JSON.stringify({ resumeRunId: current.runId, task: instruction.trim(), description: current.description }, null, 2)}\n完成后汇总结果。`
    await sendTaskRef.current(task, prompt, [], true)
  }, [activeTask, engineReady, restored, isHistoryReady, streaming, pending.length, uploadCount, epoch, source, sendTask])

  const stopTask = useCallback(async (id: string): Promise<void> => {
    invalidateStatusProbe(id)
    const task = getWorkState(source).tasks.find((item) => item.id === id)
    if (!task || !engineReady) return
    if (activeTask?.id === id) {
      await stop()
      return
    }
    stoppingTaskIdsRef.current.add(id)
    try {
      await requestOrThrow({ method: 'POST', path: '/chat/cancel', body: { sessionId: id } })
      assertEngineSource(epoch)
      updateTask(id, { status: 'stopped', updatedAt: Date.now() })
    } finally {
      stoppingTaskIdsRef.current.delete(id)
      invalidateStatusProbe(id)
    }
  }, [source, engineReady, activeTask?.id, stop, epoch, updateTask])

  const exportTask = useCallback(async (id: string): Promise<string> => {
    flushWorkDrafts(source)
    const task = getWorkState(source).tasks.find((item) => item.id === id)
    if (!task) throw new Error('任务不存在')
    let snapshot: ChatRecoverySnapshot | null = null
    try {
      snapshot = await requestOrThrow<ChatRecoverySnapshot>({
        method: 'GET', path: '/chat/snapshot', query: { sessionId: id }
      })
      assertEngineSource(epoch)
      if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== id)
        throw new Error('任务历史不匹配，请重试导出')
    } catch (cause) {
      // A never-sent draft has no engine session yet; it is still useful to
      // export its local metadata and attachments. Sent tasks must surface a
      // snapshot error instead of silently exporting an empty transcript.
      if (task.status !== 'draft') throw cause
    }
    const exportedMessages = snapshot
      ? restoreChatSnapshot(snapshot).messages
      : activeId === id ? messages : []
    const prompt = exportedMessages.find((message) => message.role === 'user')?.content || task.draft
    const snapshotStatus: WorkTask['status'] = snapshot?.run?.status === 'running' ? 'running' :
      snapshot?.run?.status === 'waiting' ? 'waiting' :
        snapshot?.run?.status === 'cancelled' ? 'stopped' :
          snapshot?.run?.status === 'interrupted' ? 'interrupted' :
            snapshot?.run?.status === 'failed' ? 'error' :
              snapshot?.run?.status === 'succeeded' ? 'done' : task.status
    const payload = JSON.stringify({
      title: task.title,
      status: snapshotStatus,
      workspacePath: task.workspacePath,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      prompt,
      attachments: task.attachments,
      sources: task.sources,
      historyCompacted: snapshot?.historyCompacted === true,
      transcript: exportedMessages.map((message) => ({
              role: message.role,
              content: message.content,
              thinking: message.thinking,
              status: message.status,
              createdAt: message.createdAt,
              attachments: message.attachments
            })),
      artifacts: workArtifacts(exportedMessages)
    }, null, 2)
    if (typeof document !== 'undefined') {
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${task.title.replace(/[\\/:*?"<>|]/g, '_') || 'work-task'}.json`
      // Chromium only promotes blob downloads from an attached anchor. A
      // detached `click()` is ignored in Electron, which made export appear
      // to work while never producing a file.
      link.style.display = 'none'
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    }
    return payload
  }, [source, epoch, activeId, messages])
  const respond = useCallback(
    async (requestId: string, values: string[]): Promise<void> => {
      if (!activeTask || !restored) return
      invalidateStatusProbe(activeTask.id)
      setError(null)
      try {
        await chatRespond(requestId, values, optionsFor(activeTask))
      } catch (cause) {
        setError(messageOf(cause))
      }
    },
    [activeTask, restored, chatRespond, optionsFor]
  )

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    setError(null)
    if (uploadCount > 0) {
      setError('资料上传完成后再更换项目，已添加的资料会保留。')
      return
    }
    if (isRemoteEngine()) {
      setError('远端任务使用独立沙箱，不能选择本机目录。')
      return
    }
    if (activeTask && (activeTask.status !== 'draft' || activeTask.attachments.length)) {
      setError('任务开始或添加资料后，工作目录保持固定。请新建任务以使用另一个目录。')
      return
    }
    if (!activeTask && state.homeAttachments.length) {
      setError('请先移除已添加的资料，再更换工作目录。')
      return
    }
    try {
      const root = await pickFolder()
      if (!root || epoch !== getEngineSource()) return
      if (activeId) updateTask(activeId, { workspacePath: root })
      else updateWorkState(source, (previous) => ({ ...previous, homeWorkspacePath: root }))
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [activeTask, activeId, state.homeAttachments.length, epoch, source, updateTask, uploadCount])

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (!files.length) return
      setError(null)
      const taskId = activeId
      const root = activeTask ? activeTask.workspacePath : state.homeWorkspacePath
      const remote = isRemoteEngine()
      let sessionId = taskId ?? getWorkState(source).homeSessionId
      if (!sessionId) {
        sessionId = 'work-' + crypto.randomUUID()
        const homeSessionId = sessionId
        updateWorkState(source, (previous) => ({ ...previous, homeSessionId }))
      }
      setUploadCount((count) => count + 1)
      try {
        if (!remote && root) await allowRoot(root)
        for (const file of files) {
          if (!isSupportedFile(file)) throw new Error(`「${file.name}」的格式暂不支持`)
          if (file.size > 20 * 1024 * 1024)
            throw new Error(`「${file.name}」超过 20 MB，请缩小文件后重试`)
          assertEngineSource(epoch)
          const data = new Uint8Array(await file.arrayBuffer())
          assertEngineSource(epoch)
          const requestId = crypto.randomUUID()
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              if (remote) void cancelAttachmentUpload(requestId).catch(() => undefined)
              reject(new Error('资料上传超时，请重试'))
            }, 120_000)
          })
          const result = await Promise.race([
            remote
              ? uploadAttachment({
                  requestId,
                  sessionId,
                  fileName: file.name,
                  type: file.type || 'application/octet-stream',
                  data
                })
              : root
                ? copyIntoWorkspace({ root, fileName: file.name, data })
                : (async () => {
                    // No project is a valid Work state. Persist the attachment
                    // through the session-scoped engine API, which creates and
                    // owns the task's private scratch directory.
                    const relativePath = scratchAttachmentPath(file.name)
                    await requestOrThrow({
                      method: 'POST',
                      path: '/workspace/file',
                      body: {
                        sessionId,
                        path: relativePath,
                        content: encodeBase64(data),
                        encoding: 'base64'
                      }
                    })
                    return { path: relativePath, relativePath, size: data.byteLength }
                  })(),
            timeout
          ]).finally(() => clearTimeout(timer))
          assertEngineSource(epoch)
          const attachment: ChatAttachment = {
            path: 'relativePath' in result ? result.relativePath : result.path,
            ...('remoteUploadId' in result ? { remoteUploadId: result.remoteUploadId } : {}),
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: result.size
          }
          updateWorkState(source, (previous) =>
            taskId
              ? {
                  ...previous,
                  tasks: previous.tasks.map((task) =>
                    task.id === taskId
                      ? { ...task, attachments: [...task.attachments, attachment] }
                      : task
                  )
                }
              : { ...previous, homeAttachments: [...previous.homeAttachments, attachment] }
          )
        }
      } catch (cause) {
        if (epoch === getEngineSource()) setError(messageOf(cause))
      } finally {
        setUploadCount((count) => count - 1)
      }
    },
    [activeId, activeTask, state.homeWorkspacePath, epoch, source]
  )

  const removeAttachment = useCallback(
    (path: string): void => {
      updateWorkState(source, (previous) =>
        activeId
          ? {
              ...previous,
              tasks: previous.tasks.map((task) =>
                task.id === activeId
                  ? { ...task, attachments: task.attachments.filter((item) => item.path !== path) }
                  : task
              )
            }
          : {
              ...previous,
              homeAttachments: previous.homeAttachments.filter((item) => item.path !== path)
            }
      )
    },
    [source, activeId]
  )
  const addReference = useCallback(
    (artifact: WorkArtifact): void => {
      const latest = getWorkDraft(source, activeId)
      const current = latest.text
      const existing = latest.mentions
      const prefix = `${current}${current ? '\n\n' : ''}针对成果 `
      const mention: Mention = {
        source: 'file',
        displayText: artifact.name,
        path: artifact.path,
        content: artifact.content ?? undefined,
        textOffset: prefix.length
      }
      const token = mentionToken(mention)
      setDraft(`${prefix}${token}（版本记录 ${artifact.id}）：\n`, [...existing, mention])
    },
    [source, activeId, setDraft]
  )

  return {
    draftSource: source,
    tasks: state.tasks,
    archivedTasks: state.tasks.filter((task) => task.archived === true),
    activeTask,
    get homeDraft() { return getWorkDraft(source, null).text },
    get draft() { return getWorkDraft(source, activeId).text },
    attachments: activeTask?.attachments ?? state.homeAttachments,
    sources: activeTask?.sources ?? [],
    workspacePath: activeTask ? activeTask.workspacePath : state.homeWorkspacePath,
    agentId: activeTask ? activeTask.agentId ?? '' : state.homeAgentId,
    agentLocked: Boolean(activeTask && (activeTask.agentLocked || activeTask.status !== 'draft' || messages.length > 0)),
    get mentions() { return getWorkDraft(source, activeId).mentions },
    utilityModel: settings.utilityModelId,
    resources,
    securitySessionId,
    thinkingMode,
    setThinkingMode,
    modelId: activeTask?.modelId ?? state.homeModelId,
    models,
    messages,
    todos: restored ? chat.todos : [],
    artifacts,
    pending,
    streaming,
    remote: isRemoteEngine(),
    ready: engineReady,
    loading: Boolean(activeId && engineReady && !restored),
    uploading: uploadCount > 0,
    error: error ?? (activeId ? chat.historyError : null),
    createTask,
    selectTask,
    showHome,
    setDraft,
    send,
    stop,
    stopTask,
    renameTask,
    archiveTask,
    continueTask,
    exportTask,
    respond,
    chooseWorkspace,
    addFiles,
    removeAttachment,
    setModel,
    setAgent,
    continueSubagent,
    setResource,
    removeResource,
    addReference,
    clearError: () => setError(null),
    retryHistory: () => setHistoryAttempt((attempt) => attempt + 1)
  }
}
