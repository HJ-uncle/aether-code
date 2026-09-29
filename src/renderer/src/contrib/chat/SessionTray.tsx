import { useEffect, useRef, useState, type JSX } from 'react'
import type { EngineTodo } from '@shared/ipc'
import type { ChatAttachment, QueuedMessage, QueueSendMode } from '@renderer/core/engine/useChat'
import { readFile } from '@renderer/core/workspace/fs-client'
import { Icon } from '@renderer/workbench/icons'
import { ChangesPanel } from './ChangesPanel'
import { TodoTray } from './TodoTray'

type TrayTab = 'changes' | 'todos' | 'queue'

/** 队首消息预览：压空白、截断（对齐 wuzu queuePreview 的 38 字） */
function queuePreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  return compact.length > 38 ? `${compact.slice(0, 38)}…` : compact
}

/** 队列项里的图片缩略图：按工作区相对路径读 base64，失败则显示通用图标 */
function QueueThumb({ root, file }: { root: string | null; file: ChatAttachment }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
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
        <Icon name="image" size={12} />
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
 *   单条删除；操作区提供「合并发送」（把队列拼成一条立即发出）与「清空」。
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
  queueSendMode,
  onSetQueueSendMode,
  onUpdateQueued,
  onMoveQueued,
  onRemoveQueued,
  onClearQueue,
  onMergeQueue
}: {
  sessionId: string
  streaming: boolean
  todos: EngineTodo[]
  queue: QueuedMessage[]
  workspaceRoot: string | null
  queueSendMode: QueueSendMode
  onSetQueueSendMode: (mode: QueueSendMode) => void
  onUpdateQueued: (id: string, text: string, attachments: ChatAttachment[]) => void
  onMoveQueued: (fromIndex: number, toIndex: number) => void
  onRemoveQueued: (id: string) => void
  onClearQueue: () => void
  onMergeQueue: () => void
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(true)
  const [changeCount, setChangeCount] = useState(0)
  const [tab, setTab] = useState<TrayTab>('changes')
  /** 正在编辑的队列项；编辑中禁用拖拽/清空/其它编辑，保证状态互斥 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  /** 编辑时保留的附件（用户在编辑框里删掉的不再回写） */
  const [editAttachments, setEditAttachments] = useState<ChatAttachment[]>([])
  /** 拖拽中的队列项 id（HTML5 drag，不引第三方库） */
  const [dragId, setDragId] = useState<string | null>(null)
  /** 用户手动选过 tab 后，本轮不再自动切换 */
  const manualTabRef = useRef(false)
  const prevQueueLenRef = useRef(0)

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
  const visible = changeCount > 0 || todos.length > 0 || queue.length > 0

  /** 当前 tab 没有内容时回落到第一个有内容的 tab */
  const effectiveTab: TrayTab =
    tab === 'changes' && changeCount === 0
      ? queue.length > 0
        ? 'queue'
        : 'todos'
      : tab === 'queue' && queue.length === 0
        ? changeCount > 0
          ? 'changes'
          : 'todos'
        : tab === 'todos' && todos.length === 0
          ? changeCount > 0
            ? 'changes'
            : 'queue'
          : tab

  const summary = ((): string => {
    if (effectiveTab === 'changes') return changeCount > 0 ? `${changeCount} 个文件待确认` : ''
    if (effectiveTab === 'todos')
      return todoActive.length > 0 ? `进行中：${todoActive[0].title}` : '全部任务已完成'
    if (queue.length === 0) return ''
    if (queue.length > 1) return `${queue.length} 条消息排队中，下一条：${queuePreview(queue[0].text)}`
    return `下一条：${queuePreview(queue[0].text)}`
  })()

  if (!visible) return null

  const pick = (next: TrayTab): void => {
    manualTabRef.current = true
    setTab(next)
    setCollapsed(false)
  }

  const startEdit = (item: QueuedMessage): void => {
    if (editingId) return
    setEditingId(item.id)
    setEditText(item.text)
    setEditAttachments(item.attachments)
  }

  const commitEdit = (): void => {
    if (!editingId) return
    onUpdateQueued(editingId, editText, editAttachments)
    setEditingId(null)
  }

  const cancelEdit = (): void => setEditingId(null)

  return (
    <div className="session-tray">
      <div className="session-tray__bar">
        <button
          type="button"
          className={`session-tray__fold${collapsed ? '' : ' is-open'}`}
          title={collapsed ? '展开' : '收起'}
          aria-label={collapsed ? '展开托盘' : '收起托盘'}
          onClick={() => setCollapsed((v) => !v)}
        >
          <Icon name="chevron" size={11} />
        </button>

        {changeCount > 0 ? (
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
              {todos.length - todoActive.length}/{todos.length}
            </span>
          </button>
        ) : null}
        {queue.length > 0 ? (
          <button
            type="button"
            className={`session-tray__tab session-tray__tab--queue${
              effectiveTab === 'queue' ? ' is-active' : ''
            }`}
            onClick={() => pick('queue')}
          >
            队列 <span className="session-tray__count">{queue.length}</span>
          </button>
        ) : null}

        {/* 摘要区可点：展开托盘并切到对应 tab（对齐 wuzu 点击摘要跳转的行为） */}
        <button
          type="button"
          className="session-tray__summary"
          title={collapsed ? `展开查看：${summary}` : summary}
          onClick={() => {
            setCollapsed(false)
            setTab(effectiveTab)
          }}
        >
          {summary}
        </button>

        {effectiveTab === 'queue' && queue.length > 0 ? (
          <>
            {/* 发送模式切换：serial 按序逐条 / batch 合并成一条 */}
            <button
              type="button"
              className="session-tray__action"
              title={
                queueSendMode === 'batch'
                  ? '当前：回合结束后把队列合并成一条发出；点击切换为按序逐条'
                  : '当前：回合结束后按序逐条发出；点击切换为合并成一条'
              }
              onClick={() => onSetQueueSendMode(queueSendMode === 'batch' ? 'serial' : 'batch')}
            >
              <Icon name={queueSendMode === 'batch' ? 'copy' : 'send'} size={12} />
              {queueSendMode === 'batch' ? '合并' : '逐条'}
            </button>
            <button
              type="button"
              className="session-tray__action session-tray__action--primary"
              disabled={streaming || editingId !== null}
              title={
                streaming
                  ? '当前回合结束后会自动按模式发出；手动发送需等回合结束'
                  : queueSendMode === 'batch'
                    ? '把队列中的消息合并成一条立即发出'
                    : '立即发出队首，其余等下一轮结束继续'
              }
              onClick={onMergeQueue}
            >
              <Icon name="copy" size={12} />
              发送
            </button>
            <button
              type="button"
              className="session-tray__action session-tray__action--danger"
              disabled={editingId !== null}
              title="清空队列（不影响正在进行的回合）"
              onClick={onClearQueue}
            >
              <Icon name="trash" size={12} />
              清空
            </button>
          </>
        ) : null}
      </div>

      {/* 改动面板常挂（收起时仅隐藏）：计数上报与回合结束刷新依赖它的 effect */}
      <div className="session-tray__body" hidden={collapsed || effectiveTab !== 'changes'}>
        <ChangesPanel sessionId={sessionId} streaming={streaming} onCountChange={setChangeCount} bare />
      </div>
      {!collapsed && effectiveTab === 'todos' ? <TodoTray todos={todos} /> : null}
      {!collapsed && effectiveTab === 'queue' ? (
        <ul className="session-tray__queue">
          {queue.map((item, index) => (
            <li
              key={item.id}
              className={`session-tray__queue-item${dragId === item.id ? ' is-dragging' : ''}`}
              draggable={editingId === null}
              onDragStart={() => setDragId(item.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => {
                if (!dragId || dragId === item.id) return
                event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = queue.findIndex((q) => q.id === dragId)
                if (from >= 0) onMoveQueued(from, index)
                setDragId(null)
              }}
            >
              <span className="session-tray__queue-index">{index + 1}</span>
              {editingId === item.id ? (
                <span className="session-tray__queue-edit">
                  <textarea
                    className="session-tray__queue-textarea"
                    value={editText}
                    autoFocus
                    rows={2}
                    onChange={(event) => setEditText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') cancelEdit()
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commitEdit()
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
                            onClick={() =>
                              setEditAttachments((prev) => prev.filter((f) => f.path !== file.path))
                            }
                          >
                            <Icon name="close" size={9} />
                          </button>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="session-tray__queue-edit-actions">
                    <button type="button" className="session-tray__action" onClick={cancelEdit}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="session-tray__action session-tray__action--primary"
                      title="保存（Ctrl+Enter）"
                      onClick={commitEdit}
                    >
                      保存
                    </button>
                  </span>
                </span>
              ) : (
                <>
                  <span
                    className="session-tray__queue-text"
                    title={`${item.text}\n\n双击编辑`}
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
                            <Icon name="file" size={11} />
                          </span>
                        )
                      )}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="session-tray__queue-remove"
                    title="编辑"
                    aria-label={`编辑第 ${index + 1} 条排队消息`}
                    disabled={editingId !== null}
                    onClick={() => startEdit(item)}
                  >
                    <Icon name="pencil" size={11} />
                  </button>
                  <button
                    type="button"
                    className="session-tray__queue-remove"
                    title="从队列移除"
                    aria-label={`移除第 ${index + 1} 条排队消息`}
                    onClick={() => onRemoveQueued(item.id)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
