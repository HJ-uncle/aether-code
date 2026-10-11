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
import { buildMentionMessage, type Mention } from '@renderer/contrib/chat/mention-context'
import {
  getWorkState,
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
  return `attachments/${stem}-${crypto.randomUUID().slice(0, 8)}${extension}`
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
  const [loaded, setLoaded] = useState<{ source: string; epoch: number; id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploadCount, setUploadCount] = useState(0)
  const [sending, setSending] = useState(false)
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const pendingStart = useRef<{ source: string; id: string; text: string; mentions: Mention[] } | null>(null)
  const submitted = useRef(
    new Map<
      string,
      { source: string; text: string; attachments: ChatAttachment[]; createdAt: number }
    >()
  )
  const sendCountRef = useRef(0)
  const sendingTaskIdsRef = useRef(new Set<string>())
  const { resumeStream, send: chatSend, abort, respond: chatRespond, isHistoryReady } = chat

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
      updateWorkState(source, (previous) => ({
        ...previous,
        tasks: previous.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
      }))
    },
    [source]
  )

  /** Keep task rows truthful while another task is running in the engine. */
  useEffect(() => {
    if (!engineReady) return
    let cancelled = false
    let syncing = false
    const sync = async (): Promise<void> => {
      if (syncing) return
      syncing = true
      const current = getWorkState(source).tasks.filter((task) =>
        ['running', 'waiting'].includes(task.status)
      )
      syncing = false
      await Promise.all(
        current.map(async (task) => {
          try {
            const snapshot = await requestOrThrow<{
              finished?: boolean
              run?: { status?: string }
            }>({ method: 'GET', path: '/chat/snapshot', query: { sessionId: task.id } })
            if (cancelled || epoch !== getEngineSource()) return
            const status = snapshot.run?.status
            const next: WorkTask['status'] =
              status === 'running' ? 'running' :
                status === 'waiting' ? 'waiting' :
                  status === 'cancelled' ? 'stopped' :
                    status === 'interrupted' ? 'interrupted' :
                      status === 'failed' ? 'error' :
                        status === 'succeeded' || snapshot.finished ? 'done' : task.status
            if (next !== task.status) updateTask(task.id, { status: next, updatedAt: Date.now() })
          } catch {
            // Snapshot polling is advisory; the active stream remains authoritative.
          }
        })
      )
    }
    void sync()
    const timer = window.setInterval(() => void sync(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [engineReady, epoch, source, updateTask])

  const optionsFor = useCallback(
    (task: WorkTask): SendOptions => ({
      sessionId: task.id,
      model: task.modelId || settings.lastModelId || undefined,
      workspacePaths: task.workspacePath ? [task.workspacePath] : undefined,
      attachments: task.attachments,
      thinkingMode:
        settings.thinkingMode === 'off'
          ? false
          : settings.thinkingMode === 'low'
            ? 'low'
            : settings.thinkingMode === 'max'
              ? 'high'
              : undefined,
      subagentModel: settings.subagentModelId || undefined,
      utilityModel: settings.utilityModelId || undefined,
      agentId: task.agentId || undefined,
      skills: task.resources?.skills,
      mcpServers: task.resources?.mcpServers,
      knowledgeBases: task.resources?.knowledgeBases,
      // A new product mode must not silently adopt Code's global memory or Agent bindings.
      memoryScope: 'off'
    }),
    [settings.lastModelId, settings.thinkingMode, settings.subagentModelId, settings.utilityModelId]
  )

  const sendTask = useCallback(
    async (task: WorkTask, text: string, mentions: Mention[] = task.mentions ?? []): Promise<void> => {
      assertEngineSource(epoch)
      if (sendingTaskIdsRef.current.has(task.id)) return
      sendingTaskIdsRef.current.add(task.id)
      sendCountRef.current += 1
      setSending(true)
      setError(null)
      updateTask(task.id, { status: 'running', updatedAt: Date.now() })
      submitted.current.set(task.id, {
        source,
        text,
        attachments: task.attachments,
        createdAt: Date.now()
      })
      try {
        await chatSend(buildMentionMessage(text, mentions), optionsFor(task))
        if (epoch !== getEngineSource()) return
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
                  draft: item.draft === task.draft ? '' : item.draft,
                  mentions: item.draft === task.draft ? [] : item.mentions,
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
      if (last.status === 'error' && task) {
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
    setError(null)
    updateWorkState(source, (previous) => ({ ...previous, activeTaskId: null }))
  }, [source])
  const setDraft = useCallback(
    (draft: string, mentions: Mention[] = []): void => {
      if (activeId) updateTask(activeId, { draft, mentions })
      else updateWorkState(source, (previous) => ({ ...previous, homeDraft: draft, homeMentions: mentions }))
    },
    [activeId, source, updateTask]
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
    (agentId: string): void => {
      if (activeTask && ['running', 'waiting'].includes(activeTask.status)) return
      if (activeId) updateTask(activeId, { agentId: agentId || undefined })
      else updateWorkState(source, (previous) => ({ ...previous, homeAgentId: agentId }))
    },
    [activeId, activeTask, source, updateTask]
  )
  const resources = activeTask?.resources ?? state.homeResources
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
      const currentTaskSending = activeTask ? sendingTaskIdsRef.current.has(activeTask.id) : false
      if (!engineReady || streaming || currentTaskSending || pending.length || uploadCount > 0) return
      if (!activeTask) {
        await createTask(text ?? state.homeDraft, mentions.length ? mentions : state.homeMentions)
        return
      }
      if (!restored || !isHistoryReady(activeTask.id)) return
      const draft = text ?? activeTask.draft
      if (!draft.trim() && !activeTask.attachments.length) return
      await sendTask(activeTask, draft, mentions.length ? mentions : activeTask.mentions ?? [])
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
      isHistoryReady
    ]
  )

  const stop = useCallback(async (): Promise<void> => {
    if (!activeTask || !engineReady) return
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
    }
  }, [activeTask, engineReady, chat.streaming, abort, epoch, resumeStream])

  const stopTask = useCallback(async (id: string): Promise<void> => {
    const task = getWorkState(source).tasks.find((item) => item.id === id)
    if (!task || !engineReady) return
    if (activeTask?.id === id) {
      await stop()
      return
    }
    await requestOrThrow({ method: 'POST', path: '/chat/cancel', body: { sessionId: id } })
    assertEngineSource(epoch)
    updateTask(id, { status: 'stopped', updatedAt: Date.now() })
  }, [source, engineReady, activeTask?.id, stop, epoch, updateTask])

  const exportTask = useCallback(async (id: string): Promise<string> => {
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
              snapshot?.run?.status === 'succeeded' || snapshot?.finished ? 'done' : task.status
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
  }, [activeTask, activeId, state.homeAttachments.length, epoch, source, updateTask])

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
      const current = activeTask?.draft ?? state.homeDraft
      setDraft(
        `${current}${current ? '\n\n' : ''}针对成果「${artifact.name}」（${artifact.path}，版本记录 ${artifact.id}）：\n`
      )
    },
    [activeTask?.draft, state.homeDraft, setDraft]
  )

  return {
    tasks: state.tasks,
    archivedTasks: state.tasks.filter((task) => task.archived === true),
    activeTask,
    homeDraft: state.homeDraft,
    draft: activeTask?.draft ?? state.homeDraft,
    attachments: activeTask?.attachments ?? state.homeAttachments,
    sources: activeTask?.sources ?? [],
    workspacePath: activeTask ? activeTask.workspacePath : state.homeWorkspacePath,
    agentId: activeTask?.agentId ?? state.homeAgentId,
    resources,
    securitySessionId: activeTask?.id ?? state.homeSessionId ?? null,
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
    setResource,
    removeResource,
    addReference,
    clearError: () => setError(null),
    retryHistory: () => setHistoryAttempt((attempt) => attempt + 1)
  }
}
