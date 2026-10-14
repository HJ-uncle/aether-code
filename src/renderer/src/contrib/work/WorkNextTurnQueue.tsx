import { useEffect, useRef, useState, type JSX } from 'react'
import { IconButton } from '@renderer/workbench/ui-primitives'
import { Icon } from '@renderer/workbench/icons'
import { ComposerInput } from '../chat/InputComposer'
import type { MentionInputHandle } from '../chat/MentionInput'
import type { Mention } from '../chat/mention-context'
import { queuedDraft, visibleQueueEntries, type WorkNextTurnQueue } from './work-next-turn-queue'
import './work-next-turn-queue.css'

export function WorkNextTurnQueuePanel({ queue, scopeKey }: { queue: WorkNextTurnQueue; scopeKey: string }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false), [editing, setEditing] = useState<string | null>(null), [text, setText] = useState(''), [mentions, setMentions] = useState<Mention[]>([])
  const [error, setError] = useState<string | null>(null), editor = useRef<MentionInputHandle>(null), errorRef = useRef<HTMLDivElement>(null), editTrigger = useRef<HTMLButtonElement | null>(null)
  const entries = visibleQueueEntries(queue.state), pending = entries.filter(entry => entry.phase === 'pending')
  const current = entries.find(entry => entry.id === editing)
  useEffect(() => { setEditing(null); setError(null); setExpanded(false) }, [scopeKey])
  useEffect(() => { if (current && current.phase === 'pending') { editor.current?.setDraft(current.envelope.draft.text, current.envelope.draft.mentions); editor.current?.focus() } }, [editing])
  const run = async (operation: () => Promise<unknown>) => { try { setError(null); await operation() } catch (cause) {
    setError(cause instanceof Error ? cause.message : '操作未保存'); requestAnimationFrame(() => errorRef.current?.focus())
  } }
  const closeEditor = () => {
    const trigger = editTrigger.current
    setEditing(null)
    requestAnimationFrame(() => {
      if (!trigger?.isConnected) return
      // Removing a focused editor must not leave keyboard users on the document body.
      trigger.focus({ preventScroll: true })
      const details = trigger.closest<HTMLElement>('.work-next-turn__details'), row = trigger.closest<HTMLElement>('.work-next-turn__row')
      if (!details || !row) return
      const viewport = details.getBoundingClientRect(), bounds = row.getBoundingClientRect()
      // Leave a CSS pixel of breathing room because fractional DPR rounds scroll offsets.
      if (bounds.top < viewport.top + 1) details.scrollTop = Math.max(0, Math.floor(details.scrollTop + bounds.top - viewport.top - 1))
      else if (bounds.bottom > viewport.bottom - 1) details.scrollTop = Math.ceil(details.scrollTop + bounds.bottom - viewport.bottom + 1)
    })
  }
  const save = () => { if (!current || current.phase !== 'pending') return
    void run(async () => { await queue.editDraft(current.id, current.revision, queuedDraft(text, mentions, current.envelope.draft.revision + 1)); closeEditor() }) }
  if (!entries.length && !queue.error) return null
  const unknown = entries.some(entry => entry.phase === 'admission-unknown' || entry.phase === 'dispatching')
  return <section className="work-next-turn" aria-label="下一轮消息队列">
    <div className="work-next-turn__header">
      <button type="button" className="work-next-turn__summary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
        <strong>下一轮</strong><span>{pending.length} 条待发</span>
        <span className="work-next-turn__preview">{queue.state?.paused ? '已暂停' : entries[0]?.envelope.draft.text || '队列状态'}</span>
      </button>
      {entries.length ? <button type="button" className="btn btn--sm" disabled={queue.saving || unknown} onClick={() => void run(() => queue.mutate(queue.state?.paused ? { kind: 'resume' } : { kind: 'pause', reason: '用户暂停待发队列' }))}>{queue.state?.paused ? '恢复待发' : '暂停待发'}</button> : null}
    </div>
    {(error || queue.error) ? <div ref={errorRef} tabIndex={-1} className="work-next-turn__error" role="alert">{error || queue.error}</div> : null}
    {unknown ? <div className="work-next-turn__notice"><span>正在核对接纳结果，剩余消息保留。重试会先查准确回执。</span>
      <button type="button" className="btn btn--sm" disabled={queue.saving} onClick={() => void run(() => queue.reconcile(true))}>核对并重试</button></div> : null}
    {expanded ? <div className="work-next-turn__details" tabIndex={0} aria-label="待发消息与队列操作">
      <ol className="work-next-turn__list">
        {entries.map(entry => { const index = pending.findIndex(item => item.id === entry.id), canEdit = entry.phase === 'pending', active = editing === entry.id
          return <li key={entry.id} className="work-next-turn__item">
            <div className="work-next-turn__row"><span className="work-next-turn__number">{canEdit ? index + 1 : '•'}</span><div className="work-next-turn__body">
              <p className="work-next-turn__text" title={entry.envelope.draft.text}>{entry.envelope.draft.text || '附件任务'}</p>
              <span className="work-next-turn__meta">{entry.phase === 'accepted' ? '已接纳，正在执行' : entry.phase === 'pending' ? '本地已保存，等待上一轮成功' : '接纳结果待核对'}{entry.envelope.attachments.length ? ` · ${entry.envelope.attachments.length} 个附件` : ''}</span>
            </div>
            {canEdit ? <div className="work-next-turn__actions">
              <IconButton icon="chevron-up" label="上移待发消息" disabled={queue.saving || index === 0} onClick={() => void run(() => queue.mutate({ kind: 'move', id: entry.id, beforeId: pending[index - 1].id }))} />
              <IconButton icon="chevron-down" label="下移待发消息" disabled={queue.saving || index === pending.length - 1} onClick={() => void run(() => queue.mutate({ kind: 'move', id: entry.id, beforeId: pending[index + 2]?.id ?? null }))} />
              <IconButton icon="pencil" label="编辑待发正文" disabled={queue.saving} onClick={event => { editTrigger.current = event.currentTarget; if (active) closeEditor(); else { setText(entry.envelope.draft.text); setMentions(entry.envelope.draft.mentions); setEditing(entry.id) } }} />
              <IconButton icon="trash" label="取消这条待发消息" disabled={queue.saving} onClick={() => void run(() => queue.mutate({ kind: 'remove', id: entry.id, entryRevision: entry.revision, at: Date.now() }))} />
            </div> : null}</div>
            {active && canEdit ? <div className="work-next-turn__editor" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); closeEditor() } }}>
              <ComposerInput ref={editor} value={text} ariaLabel="编辑待发消息正文" disabled={queue.saving} onChange={(value, refs) => { setText(value); setMentions(refs) }} onSubmit={save} onPasteFiles={() => setError('文件请在主输入框添加；此处编辑正文，现有附件会保留')} />
              <div className="work-next-turn__editor-actions"><button className="btn btn--sm" type="button" disabled={queue.saving} onClick={closeEditor}>取消</button><button className="btn btn--primary btn--sm" type="button" disabled={queue.saving || !text.trim()} onClick={save}>{queue.saving ? '保存中…' : '保存正文'}</button></div>
            </div> : null}
          </li> })}
      </ol>
      {pending.length ? <div className="work-next-turn__footer"><span>逐条发送 · 暂停只影响后续消息</span><button type="button" className="btn btn--sm" disabled={queue.saving} onClick={() => { if (window.confirm(`取消 ${pending.length} 条待发消息？正在执行的任务会继续。`)) void run(() => queue.mutate({ kind: 'clear-pending', at: Date.now() })) }}>清空待发</button></div> : null}
    </div> : null}
  </section>
}
