import { useEffect, useRef, useState, type JSX } from 'react'
import { Icon, type IconName } from '@renderer/workbench/icons'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { toast } from '@renderer/core/toast'
import { userMessageText } from '../chat/mention-context'
import type { useWorkController, WorkUserMessageAction } from './work-runtime'

type WorkController = ReturnType<typeof useWorkController>

const actions: Array<{ id: WorkUserMessageAction; name: string; icon: IconName; detail: string }> = [
  { id: 'add', name: '添加到对话', icon: 'pencil', detail: '将原文、引用与附件放回输入框，保留已有草稿' },
  { id: 'retry', name: '重新发起', icon: 'restart', detail: '删除此条及后续对话，按原指令重新发送；文件保持原样' },
  { id: 'edit', name: '从此处重新编辑', icon: 'file-edit-outline', detail: '删除此条及后续对话，将原指令放回输入框；文件保持原样' },
  { id: 'revert', name: '回退文件', icon: 'undo', detail: '回退此条及后续 AI 文件改动，成功后删除对应对话' }
]

const confirmations = {
  retry: { title: '重新发起', body: '将删除这条消息及之后的对话，并重新发送原指令和附件。已生成的文件保持原样。', confirmText: '重新发起' },
  edit: { title: '从此处重新编辑', body: '将删除这条消息及之后的对话，并将原指令和附件放回输入框。已有草稿保留，文件保持原样，不会自动发送。', confirmText: '重新编辑' },
  revert: { title: '回退文件', body: '将回退这条消息及之后的 AI 文件改动（含已保留的修改）。仅全部文件安全回退后删除对应对话，并恢复原指令。遇到版本冲突或缺少快照时保留历史并报告。', confirmText: '回退文件' },
  delete: { title: '删除本轮', body: '删除这条用户消息和本轮 AI 回复？后续轮次和已生成的文件会保留。', confirmText: '删除' }
}

export function WorkUserMessageActions({ taskId, messageId, content, canMutate, busy, onAction }: {
  taskId: string; messageId: string; content: string; canMutate: boolean; busy: boolean
  onAction: WorkController['userMessageAction']
}): JSX.Element {
  const [working, setWorking] = useState(false)
  const [copied, setCopied] = useState(false)
  const flight = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  const run = async (action: WorkUserMessageAction): Promise<void> => {
    if (flight.current || busy || (action !== 'add' && !canMutate)) return
    flight.current = true
    setWorking(true)
    try {
      if (action !== 'add' && !await confirmDialog({ ...confirmations[action], danger: true })) return
      if (await onAction(taskId, messageId, action)) {
        if (action === 'add') toast.success('已添加到对话')
        else if (action === 'delete') toast.success('已删除本轮对话')
        else if (action === 'edit') toast.success('已恢复原指令，可以继续编辑')
        else if (action === 'revert') toast.success('文件已回退，原指令已恢复')
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { flight.current = false; setWorking(false) }
  }
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(userMessageText(content))
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch { toast.error('复制失败，请重试') }
  }
  return <div className="work-message__actions" role="group" aria-label="用户消息操作" aria-busy={working || busy}>
    {actions.map(action => <button key={action.id} type="button" className="message__action"
      title={action.detail} aria-label={action.name} disabled={working || busy || (action.id !== 'add' && !canMutate)}
      onClick={() => void run(action.id)}><Icon name={action.icon} size={15} aria-hidden="true" /></button>)}
    <button type="button" className="message__action" title={copied ? '已复制' : '复制正文'} aria-label="复制"
      onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={15} aria-hidden="true" /></button>
    <button type="button" className="message__action message__action--danger" title="删除本轮问答，保留后续轮次与文件"
      aria-label="删除本轮" disabled={working || busy || !canMutate} onClick={() => void run('delete')}>
      <Icon name="trash" size={15} aria-hidden="true" />
    </button>
  </div>
}
