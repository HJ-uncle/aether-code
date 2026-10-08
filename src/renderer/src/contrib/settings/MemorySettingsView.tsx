import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { SettingsContent, SettingsGroup } from './SettingsGroup'
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
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const requestSeq = useRef(0)
  const mounted = useRef(true)
  const activeSession = scope === 'session' ? sessionId.trim() : undefined
  const isCurrent = useCallback(() => mounted.current && source === getEngineSource(), [source])

  const refresh = useCallback(async (page = pagination.current): Promise<void> => {
    if (!isCurrent() || (scope === 'session' && !activeSession)) return
    const seq = ++requestSeq.current; const sourceAtStart = getEngineSource(); setLoading(true); setError('')
    try {
      const result = await listMemoryRecords({ scope, sessionId: activeSession, keyword, type, current: page, pageSize: pagination.pageSize })
      if (!isCurrent() || seq !== requestSeq.current || sourceAtStart !== getEngineSource()) return
      setRecords(result.data); setPagination(result.pagination)
    } catch (reason: unknown) { if (isCurrent() && seq === requestSeq.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (isCurrent() && seq === requestSeq.current) setLoading(false) }
  }, [activeSession, isCurrent, keyword, pagination.pageSize, scope, type])

  useEffect(() => { mounted.current = true; void listMemorySessions().then(value => { if (isCurrent()) setSessions(value) }).catch(() => undefined); return () => { mounted.current = false; requestSeq.current++ } }, [isCurrent])
  useEffect(() => { if (scope === 'global' || activeSession) void refresh(1) }, [activeSession, refresh, scope])

  const selectedSessionTitle = useMemo(() => sessions.find(item => item.sessionId === sessionId)?.title || sessionId, [sessionId, sessions])
  const resetContext = (): void => { requestSeq.current++; setRecords([]); setPagination(value => ({ ...value, current: 1, total: 0, totalPages: 1 })); setEditing(null); setDetail(null); setBusy(false); setError('') }
  const beginCreate = (): void => { setEditing({ id: '', scope, sessionId: activeSession, type: 'fact', summary: '' }); setDetail(null); setForm({ summary: '', type: 'fact', detail: '', importance: 0.5, tags: [] }); setTagsText(''); setError('') }
  const beginEdit = async (record: MemoryRecord): Promise<void> => {
    const scopeAtStart = scope; const sessionAtStart = activeSession
    setError(''); setBusy(true)
    try { const full = await getMemoryRecord(record.id, scopeAtStart, sessionAtStart); if (!isCurrent() || scope !== scopeAtStart || activeSession !== sessionAtStart) return; setDetail(full); setEditing(full); setForm({ summary: full.summary, type: full.type, detail: full.detail ?? '', importance: full.importance ?? 0.5, tags: full.tags ?? [] }); setTagsText((full.tags ?? []).join(', ')) }
    catch (reason: unknown) { if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setError(reason instanceof Error ? reason.message : String(reason)) } finally { if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setBusy(false) }
  }
  const showDetail = async (record: MemoryRecord): Promise<void> => { const scopeAtStart = scope; const sessionAtStart = activeSession; try { const full = await getMemoryRecord(record.id, scopeAtStart, sessionAtStart); if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setDetail(full) } catch (reason: unknown) { if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setError(reason instanceof Error ? reason.message : String(reason)) } }
  const save = async (): Promise<void> => {
    if (!form.summary.trim() || busy || !isCurrent()) return
    const scopeAtStart = scope; const sessionAtStart = activeSession
    setBusy(true); setError(''); setNotice('')
    const payload = { ...form, summary: form.summary.trim(), detail: form.detail?.trim() || null, tags: tagsText.split(',').map(tag => tag.trim()).filter(Boolean) }
    try { if (editing?.id) await updateMemoryRecord(editing.id, scopeAtStart, sessionAtStart, payload); else await createMemoryRecord(scopeAtStart, sessionAtStart, payload); if (!isCurrent() || scope !== scopeAtStart || activeSession !== sessionAtStart) return; setEditing(null); setDetail(null); setNotice(editing?.id ? '记忆已更新' : '记忆已创建'); await refresh(1) }
    catch (reason: unknown) { if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setError(reason instanceof Error ? reason.message : String(reason)) } finally { if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setBusy(false) }
  }
  const remove = async (record: MemoryRecord): Promise<void> => {
    const scopeAtStart = scope; const sessionAtStart = activeSession
    if (busy || !(await confirmDialog({ title: '删除记忆？', body: `将删除“${record.summary}”，此操作不可撤销。`, confirmText: '删除记忆', danger: true }))) return
    if (!isCurrent() || scope !== scopeAtStart || activeSession !== sessionAtStart) return
    setBusy(true); setError('')
    try { await deleteMemoryRecord(record.id, scopeAtStart, sessionAtStart); if (!isCurrent() || scope !== scopeAtStart || activeSession !== sessionAtStart) return; if (detail?.id === record.id) setDetail(null); setNotice('记忆已删除'); await refresh(pagination.current) }
    catch (reason: unknown) { if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setError(reason instanceof Error ? reason.message : String(reason)) } finally { if (isCurrent() && scope === scopeAtStart && activeSession === sessionAtStart) setBusy(false) }
  }

  return <div className="settings-view memory-settings">
    <SettingsGroup title="记忆范围" footer="全局记忆可被其他会话使用；会话记忆只属于所选会话。">
      <SettingsContent>
        <div className="memory-settings__scope" role="tablist" aria-label="记忆范围">
          <button type="button" className={scope === 'global' ? 'is-active' : ''} onClick={() => { resetContext(); setKeyword(''); setType(''); setScope('global'); setSessionId('') }}>全局记忆</button>
          <button type="button" className={scope === 'session' ? 'is-active' : ''} onClick={() => { resetContext(); setKeyword(''); setType(''); setScope('session') }}>会话记忆</button>
        </div>
        {scope === 'session' ? <div className="memory-settings__session">
            <select className="field__input" value={sessionId} onChange={event => { resetContext(); setKeyword(''); setType(''); setSessionId(event.target.value); setSessionInput(event.target.value) }} aria-label="选择会话">
            <option value="">选择已有会话…</option>{sessions.map(item => <option value={item.sessionId} key={item.sessionId}>{item.title || item.sessionId}</option>)}
          </select>
          <input className="field__input" value={sessionInput} onChange={event => { resetContext(); setKeyword(''); setType(''); setSessionInput(event.target.value); setSessionId(event.target.value) }} placeholder="或输入会话 ID" aria-label="会话 ID" />
          {selectedSessionTitle ? <small>当前：{selectedSessionTitle}</small> : null}
        </div> : null}
      </SettingsContent>
    </SettingsGroup>

    <SettingsGroup title="记忆条目" footer="可以搜索、查看详情、编辑或删除记忆。">
      <SettingsContent>
        <div className="memory-settings__toolbar"><input className="field__input" value={keyword} onChange={event => setKeyword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void refresh(1) }} placeholder="搜索记忆内容" aria-label="搜索记忆" /><select className="field__input" value={type} onChange={event => setType(event.target.value as MemoryRecordType | '')} aria-label="按类型筛选"><option value="">全部类型</option>{TYPES.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select><button type="button" className="btn btn--primary" disabled={busy || (scope === 'session' && !activeSession)} onClick={beginCreate}><Icon name="plus" size={14} /> 新建记忆</button><button type="button" className="btn" disabled={loading} onClick={() => void refresh(1)}><Icon name="sync" size={14} /> 刷新</button></div>
        {scope === 'session' && !activeSession ? <div className="memory-settings__empty">先选择或输入会话 ID，再管理会话记忆。</div> : loading ? <div className="memory-settings__empty">读取中…</div> : records.length === 0 ? <div className="memory-settings__empty">暂无记忆条目</div> : <div className="memory-settings__list">{records.map(record => <div className="memory-settings__item" key={record.id}><div><div className="memory-settings__summary">{record.summary}</div><div className="memory-settings__meta"><span>{TYPES.find(item => item.value === record.type)?.label ?? record.type}</span><span>重要度 {Math.round((record.importance ?? 0) * 100)}%</span><span>{dateLabel(record.updatedAt ?? record.timestamp)}</span>{record.tags?.length ? <span>#{record.tags.join(' #')}</span> : null}</div></div><div className="memory-settings__actions"><button type="button" className="btn" aria-label="查看记忆" onClick={() => void showDetail(record)}><Icon name="eye-outline" size={14} /></button><button type="button" className="btn" aria-label="编辑记忆" onClick={() => void beginEdit(record)}><Icon name="pencil" size={14} /></button><button type="button" className="btn" aria-label="删除记忆" onClick={() => void remove(record)}><Icon name="trash" size={14} /></button></div></div>)}</div>}
        {pagination.totalPages > 1 ? <div className="memory-settings__pager"><button type="button" className="btn" disabled={pagination.current <= 1 || loading} onClick={() => void refresh(pagination.current - 1)}>上一页</button><span>{pagination.current} / {pagination.totalPages} · 共 {pagination.total} 条</span><button type="button" className="btn" disabled={pagination.current >= pagination.totalPages || loading} onClick={() => void refresh(pagination.current + 1)}>下一页</button></div> : null}
      </SettingsContent>
    </SettingsGroup>

    {editing ? <SettingsGroup title={editing.id ? '编辑记忆' : '新建记忆'}><SettingsContent><div className="memory-settings__editor"><div className="memory-settings__editor-row"><input className="field__input" value={form.summary} onChange={event => setForm(value => ({ ...value, summary: event.target.value }))} placeholder="记忆摘要（必填）" aria-label="记忆摘要" autoFocus /><select className="field__input" value={form.type} onChange={event => setForm(value => ({ ...value, type: event.target.value as MemoryRecordType }))} aria-label="记忆类型">{TYPES.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></div><textarea className="field__input" rows={5} value={form.detail ?? ''} onChange={event => setForm(value => ({ ...value, detail: event.target.value }))} placeholder="详细内容（可选）" aria-label="记忆详情" /><div className="memory-settings__editor-row"><input className="field__input" type="number" min="0" max="1" step="0.05" value={form.importance ?? 0.5} onChange={event => setForm(value => ({ ...value, importance: Number(event.target.value) }))} aria-label="重要度" /><input className="field__input" value={tagsText} onChange={event => setTagsText(event.target.value)} placeholder="标签，用逗号分隔" aria-label="记忆标签" /></div><div className="memory-settings__editor-actions"><button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>取消</button><button type="button" className="btn btn--primary" disabled={busy || !form.summary.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></div></div></SettingsContent></SettingsGroup> : null}
    {detail && !editing ? <SettingsGroup title="记忆详情"><SettingsContent><div className="memory-settings__summary">{detail.summary}</div><div className="memory-settings__meta"><span>{TYPES.find(item => item.value === detail.type)?.label ?? detail.type}</span><span>创建于 {dateLabel(detail.createdAt)}</span><span>更新于 {dateLabel(detail.updatedAt)}</span><span>来源会话：{detail.sourceSessionId || detail.sessionId || '—'}</span></div><pre className="memory-settings__detail">{detail.detail || '暂无详细内容'}</pre>{detail.tags?.length ? <div className="memory-settings__meta">标签：{detail.tags.join('、')}</div> : null}<div className="memory-settings__editor-actions"><button type="button" className="btn" onClick={() => setDetail(null)}>关闭</button><button type="button" className="btn btn--primary" onClick={() => void beginEdit(detail)}>编辑</button></div></SettingsContent></SettingsGroup> : null}
    {error ? <div className="memory-settings__error" role="alert">{error}</div> : null}{notice ? <div className="memory-settings__notice" role="status">{notice}</div> : null}
  </div>
}
