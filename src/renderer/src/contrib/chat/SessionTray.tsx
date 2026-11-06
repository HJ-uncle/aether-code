import { useEffect, useRef, useState, type JSX } from 'react'
import type { EngineTodo } from '@shared/ipc'
import type { ChatAttachment, QueuedMessage } from '@renderer/core/engine/useChat'
import { readFile } from '@renderer/core/workspace/fs-client'
import { Icon } from '@renderer/workbench/icons'
import { ActionMenu } from '@renderer/workbench/ActionMenu'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { MotionPresence, useMotionPresence } from '@renderer/workbench/MotionPresence'
import { ChangesPanel } from './ChangesPanel'
import { TodoTray } from './TodoTray'
import './apple-chat-panels.css'

type TrayTab = 'changes' | 'todos' | 'queue'

type QueueState = { ready: boolean; saving: boolean; paused: boolean; unknown: boolean; error: string | null }
const pendingItem = (item: QueuedMessage): boolean => item.phase === 'pending'
const itemStatus = (item: QueuedMessage): string => ({ pending: '待发', dispatching: '提交中', 'admission-unknown': '待核对', accepted: '已接纳', terminal: '已结束' })[item.phase ?? 'admission-unknown']

/** 队列项里的图片缩略图：按工作区相对路径读 base64，失败则显示通用图标 */
function QueueThumb({ root, file }: { root: string | null; file: ChatAttachment }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setSrc(null)
    if (root && file.type.startsWith('image/')) {
      void readFile(`${root}/${file.path}`.replace(/\//g, '/'))
        .then((result) => {
          if (alive && result.base64) setSrc(`data:${file.type};base64,${result.base64}`)
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [root, file.path, file.type])
  if (!src) {
    return (
      <span className="session-tray__queue-thumb session-tray__queue-thumb--icon">
        <Icon name="image" size={16} />
      </span>
    )
  }
  return <img className="session-tray__queue-thumb" src={src} alt={file.name} />
}

/**
 * 会话托盘（改动 / 任务 / 队列 三 tab 合并浮条）
 *
 * 对齐 wuzu-client 的 CodeChangesPanel：
 * - 默认收起成一行：左侧折叠箭头 + tab 组 + 中部当前 tab 摘要 + 右侧操作；
 * - 任一 tab 有内容才出现；新消息入队时自动切到队列 tab
 *   （用户手动点过 tab 后不再自动拽走）；
 * - 展开后复用 ChangesPanel（改动）与 TodoTray（任务），队列列表自带
 *   pending 才能编辑、移除或排序；接纳状态只由主进程的准确回执决定。
 *
 * 计数来源：改动数由 ChangesPanel 受控上报（收起时也保持挂载、仅视觉隐藏），
 * 任务/队列数直接来自 props。
 */
export function SessionTray({
  sessionId,
  streaming,
  todos,
  queue,
  workspaceRoot,
  queueState,
  onUpdateQueued,
  onMoveQueued,
  onRemoveQueued,
  onClearQueue,
  onMergeQueue,
  onPauseQueue,
  onReconcileQueue,
  onMergePending
}: {
  sessionId: string
  streaming: boolean
  todos: EngineTodo[]
  queue: QueuedMessage[]
  workspaceRoot: string | null
  queueState: QueueState
  onUpdateQueued: (id: string, text: string, attachments: ChatAttachment[]) => Promise<void>
  onMoveQueued: (fromIndex: number, toIndex: number) => Promise<void>
  onRemoveQueued: (id: string) => Promise<void>
  onClearQueue: () => Promise<void>
  onMergeQueue: () => Promise<void>
  onPauseQueue: () => Promise<void>
  onReconcileQueue: (retryIfAbsent?: boolean) => Promise<void>
  onMergePending: () => Promise<void>
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(true)
  const [changeCount, setChangeCount] = useState(0)
  const [hasChangeReport, setHasChangeReport] = useState(false)
  const [tab, setTab] = useState<TrayTab>('changes')
  /** 正在编辑的队列项；编辑中禁用拖拽/清空/其它编辑，保证状态互斥 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  /** 编辑时保留的附件（用户在编辑框里删掉的不再回写） */
  const [editAttachments, setEditAttachments] = useState<ChatAttachment[]>([])
  /** 拖拽中的队列项 id（HTML5 drag，不引第三方库） */
  const [dragId, setDragId] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const actionRef = useRef(false), sessionRef = useRef(sessionId), actionGeneration = useRef(0)
  if (sessionRef.current !== sessionId) { actionGeneration.current++; sessionRef.current = sessionId }
  /** 用户手动选过 tab 后，本轮不再自动切换 */
  const manualTabRef = useRef(false)
  const prevQueueLenRef = useRef(0)
  useEffect(() => {
    setCollapsed(true); setEditingId(null); setEditText(''); setEditAttachments([]); setDragId(null); setLocalError(null)
    setWorking(false); actionRef.current = false; manualTabRef.current = false; prevQueueLenRef.current = 0
  }, [sessionId])

  // 新消息入队（0 → >0）时自动切到队列 tab；清空后不抢回。
  // 只切 tab 不强制展开 —— 用户可能正收起托盘在读消息，后台入队一条就把托盘
  // 弹开会打断阅读。tab 徽标与摘要文案已经能提示「有队列」，想看再自己展开。
  useEffect(() => {
    if (queue.length > 0 && prevQueueLenRef.current === 0 && !manualTabRef.current) {
      setTab('queue')
    }
    prevQueueLenRef.current = queue.length
  }, [queue.length])

  const todoActive = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress')
  const todoCompleted = todos.length - todoActive.length
  const todoProgress = todos.length === 0 ? 0 : Math.round((todoCompleted / todos.length) * 100)
  const hasChanges = changeCount > 0 || hasChangeReport
  const editedItem = queue.find(item => item.id === editingId)
  const editUnavailable = editingId && (!editedItem || !pendingItem(editedItem)) ? '原消息已变更，编辑内容未保存。可复制内容后取消编辑。' : null
  const error = localError ?? queueState.error ?? editUnavailable
  const hasQueue = queue.length > 0 || Boolean(error) || editingId !== null
  const visibleQueue: QueuedMessage[] = editingId && !editedItem ? [...queue, { id: editingId, text: editText, attachments: editAttachments, phase: 'terminal' }] : queue
  const visible = hasChanges || todos.length > 0 || hasQueue
  const pending = queue.filter(pendingItem)
  const busy = working || queueState.saving
  const canChange = queueState.ready && !busy
  const inspectOnly = queueState.unknown || pending.length === 0 || !queueState.ready

  /** 当前 tab 没有内容时回落到第一个有内容的 tab */
  const effectiveTab: TrayTab =
    tab === 'changes' && !hasChanges
      ? hasQueue
        ? 'queue'
        : 'todos'
      : tab === 'queue' && !hasQueue
        ? hasChanges
          ? 'changes'
          : 'todos'
        : tab === 'todos' && todos.length === 0
          ? hasChanges
            ? 'changes'
            : 'queue'
          : tab

  const presence = useMotionPresence(visible)
  const changesPresence = useMotionPresence(visible && !collapsed && effectiveTab === 'changes')

  const summary = ((): string => {
    if (effectiveTab === 'changes') return changeCount > 0 ? `${changeCount} 处改动待确认` : '查看回退结果'
    if (effectiveTab === 'todos')
      return todoActive.length > 0 ? `进行中：${todoActive[0].title}` : '全部任务已完成'
    if (error) return '队列操作未完成'
    if (busy) return '正在保存队列'
    if (!queueState.ready) return '正在恢复队列'
    if (queueState.unknown) return '提交结果待核对'
    if (queueState.paused && pending.length) return `已暂停 · ${pending.length} 条待发`
    if (pending.length) return `${pending.length} 条待发 · 逐条发送`
    return queue.some(item => item.phase === 'accepted') ? '已接纳 · 正在执行' : ''
  })()

  const pick = (next: TrayTab): void => {
    manualTabRef.current = true
    setTab(next)
    setCollapsed(false)
  }

  const startEdit = (item: QueuedMessage): void => {
    if (editingId || !canChange || !pendingItem(item)) return
    setLocalError(null)
    setEditingId(item.id)
    setEditText(item.text)
    setEditAttachments(item.attachments)
  }

  const runAction = async (action: () => Promise<void>, success?: () => void): Promise<void> => {
    if (actionRef.current || queueState.saving) return
    const scope = actionGeneration.current
    actionRef.current = true; setWorking(true); setLocalError(null)
    try {
      await action()
      if (actionGeneration.current === scope) success?.()
    } catch (cause) {
      if (actionGeneration.current === scope) {
        setLocalError(cause instanceof Error ? cause.message : '操作未完成，请核对队列后重试')
        setTab('queue'); setCollapsed(false)
      }
    } finally {
      if (actionGeneration.current === scope) { actionRef.current = false; setWorking(false) }
    }
  }
  const commitEdit = (): void => {
    if (!editingId || !canChange) return
    if (!queue.some(item => item.id === editingId && pendingItem(item))) {
      setLocalError('该消息已开始投递，无法修改。未保存的编辑仍保留，可复制后取消。'); return
    }
    void runAction(() => onUpdateQueued(editingId, editText, editAttachments), () => setEditingId(null))
  }

  const cancelEdit = (): void => setEditingId(null)

  const clearQueueWithConfirm = async (): Promise<void> => {
    if (pending.length === 0) return
    const ok = await confirmDialog({
      title: '清空消息队列',
      body: `将移除 ${pending.length} 条尚未提交的消息，已提交的消息和当前回合继续保留。`,
      confirmText: '清空待发',
      danger: true
    })
    if (ok) await onClearQueue()
  }

  return (
    <div className="session-tray" hidden={!presence.present} {...presence.motionProps}>
      <div className="session-tray__bar">
        <button
          type="button"
          className={`session-tray__fold${collapsed ? '' : ' is-open'}`}
          title={collapsed ? '展开' : '收起'}
          aria-label={collapsed ? '展开托盘' : '收起托盘'}
          onClick={() => setCollapsed((v) => !v)}
        >
          <Icon name="chevron" size={16} />
        </button>

        {hasChanges ? (
          <button
            type="button"
            className={`session-tray__tab${effectiveTab === 'changes' ? ' is-active' : ''}`}
            onClick={() => pick('changes')}
          >
            改动 <span className="session-tray__count">{changeCount}</span>
          </button>
        ) : null}
        {todos.length > 0 ? (
          <button
            type="button"
            className={`session-tray__tab${effectiveTab === 'todos' ? ' is-active' : ''}`}
            onClick={() => pick('todos')}
          >
            任务{' '}
            <span className="session-tray__count">
              {todoCompleted}/{todos.length}
            </span>
            <span
              className="session-tray__tab-progress"
              aria-hidden="true"
              title={`${todoCompleted}/${todos.length} 个任务已完成`}
            >
              <span className="session-tray__tab-progress-fill" style={{ width: `${todoProgress}%` }} />
            </span>
          </button>
        ) : null}
        {hasQueue ? (
          <button
            type="button"
            className={`session-tray__tab session-tray__tab--queue${
              effectiveTab === 'queue' ? ' is-active' : ''
            }`}
            onClick={() => pick('queue')}
          >
            队列 <span className="session-tray__count">{queue.length || '!'}</span>
          </button>
        ) : null}

        {/* 摘要区可点：展开 / 收起托盘（对齐 wuzu 工具条摘要的 toggle 行为）。
            展开时顺带切到摘要对应的 tab，收起时保留用户当前所在的 tab */}
        <button
          type="button"
          className="session-tray__summary"
          aria-live="polite"
          aria-atomic="true"
          aria-expanded={!collapsed}
          title={collapsed ? `展开查看：${summary}` : `收起托盘：${summary}`}
          onClick={() => {
            if (collapsed) {
              setTab(effectiveTab)
              setCollapsed(false)
            } else {
              setCollapsed(true)
            }
          }}
        >
          {summary}
        </button>

        {effectiveTab === 'queue' && hasQueue ? (
          <>
            <button
              type="button"
              className="session-tray__action session-tray__action--primary"
              disabled={busy || editingId !== null || (!inspectOnly && streaming && !queueState.paused)}
              title={inspectOnly ? '核对原请求与执行状态，不创建新请求' : queueState.paused ? '恢复待发队列，当前回合结束后逐条发送' : '立即发送队首，其余逐条等待上一轮完成'}
              onClick={() => { void runAction(inspectOnly ? () => onReconcileQueue(false) : onMergeQueue) }}
            >
              <Icon name={inspectOnly ? 'sync' : 'send'} size={16} />
              {inspectOnly ? '核对' : queueState.paused ? '继续' : '发送'}
            </button>
            <ActionMenu
              label="队列更多操作"
              disabled={editingId !== null || busy}
              items={[
                {
                  id: 'reconcile', label: '核对原请求', description: '读取原请求回执，不重新发送', icon: 'sync',
                  onSelect: () => runAction(() => onReconcileQueue(false))
                },
                {
                  id: 'retry-exact', label: '核对并重试', description: '仅确认未接纳后，重试原请求', icon: 'restart', disabled: !queueState.unknown,
                  onSelect: () => runAction(() => onReconcileQueue(true))
                },
                {
                  id: 'pause', label: queueState.paused ? '继续队列' : '暂停队列', description: '保留待发消息与顺序', icon: queueState.paused ? 'play' : 'stop',
                  disabled: !canChange || pending.length === 0 || queueState.unknown,
                  onSelect: () => runAction(queueState.paused ? onMergeQueue : onPauseQueue)
                },
                {
                  id: 'merge-pending', label: '合并待发消息', description: '合并正文和附件，配置不同则保留原项', icon: 'source-merge',
                  disabled: !canChange || pending.length < 2 || queueState.unknown,
                  onSelect: () => runAction(onMergePending)
                },
                {
                  id: 'clear',
                  label: '清空待发',
                  description: '移除所有排队消息，不影响当前回合',
                  icon: 'trash',
                  danger: true,
                  disabled: !canChange || pending.length === 0,
                  onSelect: () => runAction(clearQueueWithConfirm)
                }
              ]}
            />
          </>
        ) : null}
      </div>
      <MotionPresence key={`notice:${sessionId}`} show={!collapsed && effectiveTab === 'queue' && Boolean(error)}>
        <div className="changes-panel__notice" role="alert">{error}</div>
      </MotionPresence>

      {/* 改动面板常挂（收起时仅隐藏）：计数上报与回合结束刷新依赖它的 effect */}
      <div className="ui-motion-collapse" hidden={!changesPresence.present} style={changesPresence.present ? undefined : { display: 'none' }} {...changesPresence.motionProps}><div className="ui-motion-collapse__content">
      <div className="session-tray__body">
        <ChangesPanel key={sessionId} sessionId={sessionId} streaming={streaming} onCountChange={setChangeCount} onReportChange={setHasChangeReport} bare />
      </div></div></div>
      <MotionPresence key={`todos:${sessionId}`} show={!collapsed && effectiveTab === 'todos'}><TodoTray todos={todos} /></MotionPresence>
      <MotionPresence key={`queue:${sessionId}`} show={!collapsed && effectiveTab === 'queue'}>
        <ul className="session-tray__queue" aria-label="持久待发队列" aria-busy={busy}>
          {visibleQueue.map((item, index) => (
            <li
              key={item.id}
              className={`session-tray__queue-item${dragId === item.id ? ' is-dragging' : ''}`}
              data-phase={item.phase ?? 'admission-unknown'}
              draggable={canChange && editingId === null && pendingItem(item)}
              onDragStart={event => { if (!canChange || editingId !== null || !pendingItem(item)) { event.preventDefault(); return }; setDragId(item.id) }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => {
                if (!canChange || !pendingItem(item) || !dragId || dragId === item.id) return
                event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = pending.findIndex(q => q.id === dragId), to = pending.findIndex(q => q.id === item.id)
                if (canChange && editingId === null && from >= 0 && to >= 0 && from !== to) void runAction(() => onMoveQueued(from, to))
                setDragId(null)
              }}
            >
              <span className="session-tray__queue-index">{index + 1}</span>
              <span className="session-tray__queue-attach" title={item.reason}>{item.id === editingId && !editedItem ? '未保存' : itemStatus(item)}</span>
              {editingId === item.id ? (
                <span className="session-tray__queue-edit">
                  <textarea
                    className="session-tray__queue-textarea"
                    value={editText}
                    aria-label="编辑待发消息"
                    disabled={busy}
                    autoFocus
                    rows={2}
                    onChange={(event) => setEditText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && !busy) cancelEdit()
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitEdit() }
                    }}
                  />
                  {editAttachments.length > 0 ? (
                    <span className="session-tray__queue-thumbs">
                      {editAttachments.map((file) => (
                        <span key={file.path} className="session-tray__queue-thumbwrap">
                          <QueueThumb root={workspaceRoot} file={file} />
                          <button
                            type="button"
                            className="session-tray__queue-thumb-remove"
                            title="移除该附件"
                            aria-label={`移除附件 ${file.name}`}
                            disabled={busy}
                            onClick={() =>
                              setEditAttachments((prev) => prev.filter((f) => f.path !== file.path))
                            }
                          >
                            <Icon name="close" size={16} />
                          </button>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="session-tray__queue-edit-actions">
                    <button type="button" className="session-tray__action" disabled={busy} onClick={cancelEdit}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="session-tray__action session-tray__action--primary"
                      title="保存（Ctrl+Enter）"
                      disabled={!canChange || !pendingItem(item) || (!editText.trim() && editAttachments.length === 0)}
                      onClick={commitEdit}
                    >
                      {busy ? '保存中' : '保存'}
                    </button>
                  </span>
                </span>
              ) : (
                <>
                  <span
                    className="session-tray__queue-text"
                    title={`${item.text}${pendingItem(item) ? '\n\n双击编辑' : ''}`}
                    onDoubleClick={() => startEdit(item)}
                  >
                    {item.text || '（无文字）'}
                  </span>
                  {item.attachments.length > 0 ? (
                    <span className="session-tray__queue-thumbs">
                      {item.attachments.map((file) =>
                        file.type.startsWith('image/') ? (
                          <QueueThumb key={file.path} root={workspaceRoot} file={file} />
                        ) : (
                          <span key={file.path} className="session-tray__queue-attach" title={file.name}>
                            <Icon name="file" size={16} />
                          </span>
                        )
                      )}
                    </span>
                  ) : null}
                  {pendingItem(item) ? <><button
                    type="button"
                    className="session-tray__queue-remove"
                    title="编辑"
                    aria-label={`编辑第 ${index + 1} 条排队消息`}
                    disabled={editingId !== null || !canChange}
                    style={{ minWidth: 24, minHeight: 24 }}
                    onClick={() => startEdit(item)}
                  >
                    <Icon name="pencil" size={16} />
                  </button>
                  <button
                    type="button"
                    className="session-tray__queue-remove"
                    title="从队列移除"
                    aria-label={`移除第 ${index + 1} 条排队消息`}
                    disabled={editingId !== null || !canChange}
                    style={{ minWidth: 24, minHeight: 24 }}
                    onClick={() => { void runAction(() => onRemoveQueued(item.id)) }}
                  >
                    <Icon name="close" size={16} />
                  </button><ActionMenu label={`调整第 ${index + 1} 条待发消息顺序`} disabled={editingId !== null || !canChange} items={[
                    { id: 'move-up', label: '上移', icon: 'chevron-up', disabled: pending.findIndex(row => row.id === item.id) <= 0,
                      onSelect: () => runAction(() => { const from = pending.findIndex(row => row.id === item.id); return onMoveQueued(from, from - 1) }) },
                    { id: 'move-down', label: '下移', icon: 'chevron-down', disabled: pending.findIndex(row => row.id === item.id) >= pending.length - 1,
                      onSelect: () => runAction(() => { const from = pending.findIndex(row => row.id === item.id); return onMoveQueued(from, from + 1) }) }
                  ]} /></> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      </MotionPresence>
    </div>
  )
}
