import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Icon } from '@renderer/ui/icons'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { Select } from '@renderer/ui/Select'
import { Dialog } from '@renderer/ui/Dialog'
import { Spinner } from '@renderer/ui/ui-primitives'
import { useApp } from '@renderer/core/app-context'
import { useMemoryPreferences } from '@renderer/core/engine/memory-store'
import { Toggle } from './SettingsGroup'
import { ResourceSettingsEmpty, ResourceSettingsField, ResourceSettingsHeader, ResourceSettingsMenu } from './ResourceSettings'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import {
  createMemoryRecord, deleteMemoryRecord, getMemoryRecord, listMemoryRecords, listMemorySessions, updateMemoryRecord,
  type MemoryRecord, type MemoryRecordInput, type MemoryRecordScope, type MemoryRecordType, type MemorySessionOption
} from '@renderer/core/engine/memory-records'
import './memory-settings.css'
import './settings-pages.css'

const TYPES: { value: MemoryRecordType; label: string }[] = [
  { value: 'fact', label: '事实' }, { value: 'preference', label: '偏好' }, { value: 'decision', label: '决策' },
  { value: 'lesson', label: '经验' }, { value: 'narrative', label: '叙事' }, { value: 'milestone', label: '里程碑' }
]

function dateLabel(value?: number): string { return value ? new Date(value > 10_000_000_000 ? value : value * 1000).toLocaleString() : '—' }

export function MemorySettingsView(): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <MemorySettingsContent key={source} source={source} />
}

function MemorySettingsContent({ source }: { source: number }): JSX.Element {
  const { ready } = useApp()
  const {
    preferences,
    loaded: preferencesLoaded,
    loading: preferencesLoading,
    error: preferencesError,
    refresh: refreshPreferences,
    change: changePreferences
  } = useMemoryPreferences()
  const [scope, setScope] = useState<MemoryRecordScope>('global')
  const [sessionId, setSessionId] = useState('')
  const [sessionInput, setSessionInput] = useState('')
  const [sessions, setSessions] = useState<MemorySessionOption[]>([])
  const [records, setRecords] = useState<MemoryRecord[]>([])
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0, totalPages: 1 })
  const [keyword, setKeyword] = useState('')
  const [type, setType] = useState<MemoryRecordType | ''>('')
  const [editing, setEditing] = useState<MemoryRecord | null>(null)
  const [detail, setDetail] = useState<MemoryRecord | null>(null)
  const [form, setForm] = useState<MemoryRecordInput>({ summary: '', type: 'fact', detail: '', importance: 0.5, tags: [] })
  const [tagsText, setTagsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const requestSeq = useRef(0)
  const contextSeq = useRef(0)
  const detailSeq = useRef(0)
  const formId = useId()
  const mounted = useRef(true)
  const activeSession = scope === 'session' ? sessionId.trim() : undefined
  const isCurrent = useCallback(() => mounted.current && source === getEngineSource(), [source])

  useEffect(() => {
    if (ready && !preferencesLoaded && !preferencesLoading && !preferencesError) void refreshPreferences()
  }, [ready, preferencesLoaded, preferencesLoading, preferencesError, refreshPreferences])

  const preferencesDisabled = !ready || !preferencesLoaded || preferencesLoading
  const changePreference = (patch: { globalEnabled?: boolean; sessionDefaultEnabled?: boolean }): void => {
    if (!isCurrent() || preferencesDisabled) return
    if (patch.globalEnabled === true && preferences?.enabled === false) return
    void changePreferences(patch).catch(() => undefined)
  }

  const refresh = useCallback(async (page = pagination.current): Promise<void> => {
    if (!isCurrent() || (scope === 'session' && !activeSession)) return
    const seq = ++requestSeq.current; const sourceAtStart = getEngineSource(); setLoading(true); setError('')
    try {
      let result = await listMemoryRecords({ scope, sessionId: activeSession, keyword, type, current: page, pageSize: pagination.pageSize })
      if (!isCurrent() || seq !== requestSeq.current || sourceAtStart !== getEngineSource()) return
      // Deleting the final row on a page must not strand the remaining records off-screen.
      const lastPage = Math.max(1, result.pagination.totalPages)
      if (page > lastPage) result = await listMemoryRecords({ scope, sessionId: activeSession, keyword, type, current: lastPage, pageSize: pagination.pageSize })
      if (!isCurrent() || seq !== requestSeq.current || sourceAtStart !== getEngineSource()) return
      setRecords(result.data); setPagination(result.pagination)
    } catch (reason: unknown) { if (isCurrent() && seq === requestSeq.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (isCurrent() && seq === requestSeq.current) setLoading(false) }
  }, [activeSession, isCurrent, keyword, pagination.pageSize, scope, type])

  useEffect(() => { mounted.current = true; void listMemorySessions().then(value => { if (isCurrent()) setSessions(value) }).catch(() => undefined); return () => { mounted.current = false; requestSeq.current++ } }, [isCurrent])
  useEffect(() => { if (scope === 'global' || activeSession) void refresh(1) }, [activeSession, refresh, scope])

  const resetContext = (): void => { contextSeq.current++; detailSeq.current++; requestSeq.current++; setRecords([]); setPagination(value => ({ ...value, current: 1, total: 0, totalPages: 1 })); setEditing(null); setDetail(null); setBusy(false); setLoading(false); setReading(false); setError(''); setNotice('') }
  const closeEditor = (): void => { detailSeq.current++; setReading(false); setEditing(null); setDetail(null); setError('') }
  const changeScope = (next: MemoryRecordScope): void => { if (next === scope) return; resetContext(); setKeyword(''); setType(''); setScope(next); if (next === 'global') { setSessionId(''); setSessionInput('') } }
  const beginCreate = (): void => { detailSeq.current++; setReading(false); setEditing({ id: '', scope, sessionId: activeSession, type: 'fact', summary: '' }); setDetail(null); setForm({ summary: '', type: 'fact', detail: '', importance: 0.5, tags: [] }); setTagsText(''); setError('') }
  const beginEdit = async (record: MemoryRecord): Promise<void> => {
    const contextAtStart = contextSeq.current; const scopeAtStart = scope; const sessionAtStart = activeSession
    const sequence = ++detailSeq.current
    setError(''); setReading(true)
    try { const full = await getMemoryRecord(record.id, scopeAtStart, sessionAtStart); if (!isCurrent() || contextSeq.current !== contextAtStart || detailSeq.current !== sequence) return; setDetail(full); setEditing(full); setForm({ summary: full.summary, type: full.type, detail: full.detail ?? '', importance: full.importance ?? 0.5, tags: full.tags ?? [] }); setTagsText((full.tags ?? []).join(', ')) }
    catch (reason: unknown) { if (isCurrent() && detailSeq.current === sequence) setError(reason instanceof Error ? reason.message : String(reason)) } finally { if (isCurrent() && detailSeq.current === sequence) setReading(false) }
  }
  const showDetail = async (record: MemoryRecord): Promise<void> => {
    const sequence = ++detailSeq.current
    setError(''); setReading(true)
    try { const full = await getMemoryRecord(record.id, scope, activeSession); if (isCurrent() && detailSeq.current === sequence) setDetail(full) }
    catch (reason: unknown) { if (isCurrent() && detailSeq.current === sequence) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (isCurrent() && detailSeq.current === sequence) setReading(false) }
  }
  const save = async (): Promise<void> => {
    if (!form.summary.trim() || busy || !isCurrent()) return
    const contextAtStart = contextSeq.current; const scopeAtStart = scope; const sessionAtStart = activeSession
    setBusy(true); setError(''); setNotice('')
    const payload = { ...form, summary: form.summary.trim(), detail: form.detail?.trim() || null, tags: tagsText.split(',').map(tag => tag.trim()).filter(Boolean) }
    try { if (editing?.id) await updateMemoryRecord(editing.id, scopeAtStart, sessionAtStart, payload); else await createMemoryRecord(scopeAtStart, sessionAtStart, payload); if (!isCurrent() || contextSeq.current !== contextAtStart) return; setEditing(null); setDetail(null); setNotice(editing?.id ? '记忆已更新' : '记忆已创建'); await refresh(1) }
    catch (reason: unknown) { if (isCurrent() && contextSeq.current === contextAtStart) setError(reason instanceof Error ? reason.message : String(reason)) } finally { if (isCurrent() && contextSeq.current === contextAtStart) setBusy(false) }
  }
  const remove = async (record: MemoryRecord): Promise<void> => {
    const contextAtStart = contextSeq.current; const scopeAtStart = scope; const sessionAtStart = activeSession
    if (busy || !(await confirmDialog({ title: '删除记忆？', body: `将删除“${record.summary}”，此操作不可撤销。`, confirmText: '删除记忆', danger: true }))) return
    if (!isCurrent() || contextSeq.current !== contextAtStart) return
    setBusy(true); setError('')
    try { await deleteMemoryRecord(record.id, scopeAtStart, sessionAtStart); if (!isCurrent() || contextSeq.current !== contextAtStart) return; if (detail?.id === record.id) setDetail(null); setNotice('记忆已删除'); await refresh(pagination.current) }
    catch (reason: unknown) { if (isCurrent() && contextSeq.current === contextAtStart) setError(reason instanceof Error ? reason.message : String(reason)) } finally { if (isCurrent() && contextSeq.current === contextAtStart) setBusy(false) }
  }

  return <div className="settings-view resource-settings memory-settings">
    <section className="memory-preferences" aria-label="记忆偏好">
      <h2>使用偏好</h2>
      <div className="resource-list">
        <div className="memory-preferences__row">
          <div><strong>全局记忆</strong><p>在不同会话中参考已保存的信息。</p></div>
          <Toggle label="全局记忆" checked={preferences?.globalEnabled ?? false}
            disabled={preferencesDisabled || (preferences?.enabled === false && !preferences.globalEnabled)} onChange={globalEnabled => changePreference({ globalEnabled })} />
        </div>
        <div className="memory-preferences__row">
          <div><strong>默认开启会话记忆</strong><p>未单独设置的会话跟随此默认值。</p></div>
          <Toggle label="默认开启会话记忆" checked={preferences?.sessionDefaultEnabled ?? false} disabled={preferencesDisabled} onChange={sessionDefaultEnabled => changePreference({ sessionDefaultEnabled })} />
        </div>
      </div>
      {preferencesLoading || !ready || !preferencesLoaded || preferences?.enabled === false || preferencesError ? <div className="memory-preferences__status" aria-live="polite" aria-busy={preferencesLoading}>
        <p>{!ready ? '连接引擎后可设置记忆偏好。' : preferencesLoading ? '正在同步记忆偏好…' : preferences?.enabled === false ? '服务端已关闭长期记忆；聊天历史仍会保留。' : preferencesError ? '记忆偏好同步失败，请重新读取。' : '尚未读取记忆偏好。'}</p>
        {ready && !preferencesLoading ? <button type="button" className="btn" onClick={() => void refreshPreferences()}>重新读取记忆偏好</button> : null}
        {preferencesError ? <details className="resource-disclosure"><summary>诊断信息</summary><p>{preferencesError}</p></details> : null}
      </div> : null}
    </section>

    <section className="memory-records" aria-label="记忆条目">
      <ResourceSettingsHeader title="记忆条目" count={pagination.total}>
        <button type="button" className="resource-icon-button" aria-label="刷新记忆" title="刷新" disabled={loading || (scope === 'session' && !activeSession)} onClick={() => void refresh(1)}>
          {loading ? <Spinner size={15} /> : <Icon name="refresh" size={16} />}
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || (scope === 'session' && !activeSession)} onClick={beginCreate}><Icon name="plus" size={14} />新建记忆</button>
      </ResourceSettingsHeader>
      <div className="memory-scope-row">
        <div className="segmented" role="radiogroup" aria-label="记忆范围">
          {([{ value: 'global', label: '全局记忆' }, { value: 'session', label: '会话记忆' }] as const).map(option =>
            <button type="button" role="radio" aria-checked={scope === option.value} key={option.value}
              tabIndex={scope === option.value ? 0 : -1} className={'segmented__item' + (scope === option.value ? ' is-active' : '')}
              onClick={() => changeScope(option.value)} onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next = event.key === 'Home' ? 'global' : event.key === 'End' ? 'session' : scope === 'global' ? 'session' : 'global'
                changeScope(next)
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-memory-scope="${next}"]`)?.focus()
              }} data-memory-scope={option.value}>{option.label}</button>)}
        </div>
        <span>{scope === 'global' ? '可供不同会话参考' : '仅属于所选会话'}</span>
      </div>
      {scope === 'session' ? <div className="memory-settings__session">
        <Select className="settings-menu-field" value={sessionId} onChange={value => { if (value === sessionId) return; resetContext(); setKeyword(''); setType(''); setSessionId(value); setSessionInput('') }} ariaLabel="选择会话"
          options={[{ value: '', label: '选择已有会话…' }, ...sessions.map(item => ({ value: item.sessionId, label: item.title || item.sessionId }))]} />
        <input className="field__input" value={sessionInput} onChange={event => { resetContext(); setKeyword(''); setType(''); setSessionInput(event.target.value); setSessionId(event.target.value) }} placeholder="或输入会话 ID" aria-label="会话 ID" />
      </div> : null}
      <div className="memory-settings__toolbar">
        <div className="memory-search"><Icon name="search" size={15} /><input className="field__input" value={keyword} onChange={event => setKeyword(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void refresh(1) }} placeholder="搜索记忆" aria-label="搜索记忆" /></div>
        <Select value={type} onChange={value => { const match = TYPES.find(item => item.value === value); setType(match?.value ?? '') }} ariaLabel="按类型筛选" options={[{ value: '', label: '全部类型' }, ...TYPES]} />
      </div>
      {!editing && !detail && error ? <p className="resource-feedback is-error" role="alert">{error}</p> : null}
      {notice ? <p className="resource-feedback is-success" role="status">{notice}</p> : null}
      {reading ? <p className="resource-feedback" role="status">正在读取记忆详情…</p> : null}
      <div className="resource-list" role="list" aria-label="记忆列表" aria-busy={loading}>
        {scope === 'session' && !activeSession ? <ResourceSettingsEmpty icon="chat-outline" title="选择一个会话" description="从已有会话中选择，或输入会话 ID。" />
          : loading && records.length === 0 ? <ResourceSettingsEmpty loading title="正在读取记忆…" />
          : records.length === 0 ? <ResourceSettingsEmpty icon="brain" title={keyword || type ? '没有匹配的记忆' : '暂无记忆条目'} description={keyword || type ? '试试其他关键词或类型。' : '新建一条记忆，保存值得参考的信息。'} />
          : records.map(record => <article className="resource-row memory-record" role="listitem" aria-label={record.summary} key={record.id}>
            <button type="button" className="resource-row__main" aria-label={`查看记忆：${record.summary}`} disabled={busy} onClick={() => void showDetail(record)}>
              <span className="resource-row__icon"><Icon name={record.type === 'preference' ? 'star-outline' : record.type === 'decision' ? 'check' : 'brain'} size={18} /></span>
              <span className="resource-row__copy"><strong>{record.summary}</strong><span className="resource-row__meta">
                <span>{TYPES.find(item => item.value === record.type)?.label ?? record.type}</span><span>重要度 {Math.round((record.importance ?? 0) * 100)}%</span><span>{dateLabel(record.updatedAt ?? record.timestamp)}</span>
              </span>{record.tags?.length ? <span className="memory-record__tags">{record.tags.map(tag => `#${tag}`).join('  ')}</span> : null}</span>
            </button>
            <ResourceSettingsMenu label={record.summary} disabled={busy} actions={[
              { label: '查看详情', icon: 'eye-outline', onSelect: () => void showDetail(record) },
              { label: '编辑', icon: 'pencil', onSelect: () => void beginEdit(record) },
              { label: '删除', icon: 'trash', danger: true, onSelect: () => void remove(record) }
            ]} />
          </article>)}
      </div>
      {pagination.totalPages > 1 ? <nav className="memory-settings__pager" aria-label="记忆分页">
        <button type="button" className="resource-icon-button" aria-label="上一页" disabled={pagination.current <= 1 || loading} onClick={() => void refresh(pagination.current - 1)}><Icon name="chevron-left" size={16} /></button>
        <span>{pagination.current} / {pagination.totalPages} · 共 {pagination.total} 条</span>
        <button type="button" className="resource-icon-button" aria-label="下一页" disabled={pagination.current >= pagination.totalPages || loading} onClick={() => void refresh(pagination.current + 1)}><Icon name="chevron-right" size={16} /></button>
      </nav> : null}
    </section>

    {editing || detail ? <Dialog title={editing ? editing.id ? '编辑记忆' : '新建记忆' : '记忆详情'} width={620} className="resource-editor memory-editor" closeDisabled={busy} onClose={closeEditor}
      footer={editing ? <><button type="button" className="btn" disabled={busy} onClick={closeEditor}>取消</button><button type="submit" form={formId} className="btn btn--primary" disabled={busy || !form.summary.trim()}>{busy ? '保存中…' : '保存'}</button></>
        : <><button type="button" className="btn" onClick={closeEditor}>关闭</button><button type="button" className="btn btn--primary" disabled={busy} onClick={() => { if (detail) void beginEdit(detail) }}>编辑</button></>}>
      {editing ? <form id={formId} className="resource-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <ResourceSettingsField label="摘要" wide><input className="field__input" value={form.summary} disabled={busy} onChange={event => setForm(value => ({ ...value, summary: event.target.value }))} placeholder="需要记住的内容" aria-label="记忆摘要" autoFocus /></ResourceSettingsField>
        <ResourceSettingsField label="类型"><Select value={form.type ?? 'fact'} disabled={busy} onChange={next => { const picked = TYPES.find(item => item.value === next); if (picked) setForm(value => ({ ...value, type: picked.value })) }} ariaLabel="记忆类型" options={TYPES} /></ResourceSettingsField>
        <ResourceSettingsField label="重要度 · 0–1"><input className="field__input" type="number" min="0" max="1" step="any" value={form.importance ?? 0.5} disabled={busy} onChange={event => setForm(value => ({ ...value, importance: Number(event.target.value) }))} aria-label="重要度" /></ResourceSettingsField>
        <ResourceSettingsField label="详细内容 · 可选" wide><textarea className="field__input" rows={6} value={form.detail ?? ''} disabled={busy} onChange={event => setForm(value => ({ ...value, detail: event.target.value }))} aria-label="记忆详情" /></ResourceSettingsField>
        <ResourceSettingsField label="标签 · 可选" wide><input className="field__input" value={tagsText} disabled={busy} onChange={event => setTagsText(event.target.value)} placeholder="用逗号分隔多个标签" aria-label="记忆标签" /></ResourceSettingsField>
        {error ? <p className="resource-feedback is-error is-wide" role="alert">{error}</p> : null}
      </form> : detail ? <div className="memory-detail">
        <h3>{detail.summary}</h3>
        <div className="memory-detail__metadata"><span>{TYPES.find(item => item.value === detail.type)?.label ?? detail.type}</span><span>重要度 {Math.round((detail.importance ?? 0) * 100)}%</span></div>
        <p className="memory-detail__content">{detail.detail || '暂无详细内容'}</p>
        {detail.tags?.length ? <div className="memory-detail__tags">{detail.tags.map(tag => <span key={tag}>{tag}</span>)}</div> : null}
        <dl><div><dt>创建时间</dt><dd>{dateLabel(detail.createdAt)}</dd></div><div><dt>更新时间</dt><dd>{dateLabel(detail.updatedAt)}</dd></div><div><dt>来源会话</dt><dd>{detail.sourceSessionId || detail.sessionId || '—'}</dd></div></dl>
        {error ? <p className="resource-feedback is-error" role="alert">{error}</p> : null}
      </div> : null}
    </Dialog> : null}
  </div>
}
