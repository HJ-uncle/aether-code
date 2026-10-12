import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { useModels } from '@renderer/core/engine/model-store'
import { listKnowledgeBases, type KnowledgeBase } from '@renderer/core/engine/knowledge'
import { Dialog } from '@renderer/workbench/Dialog'
import { Select } from '@renderer/workbench/Select'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import type { WorkAgent } from './WorkAgentPicker'
import './work-agent-manager.css'

/** Mirrors the engine Agent contract so editing never silently drops settings. */
interface AgentDefinition extends WorkAgent {
  systemPrompt?: string
  model?: string
  temperature?: number
  skills?: string[]
  mcpServers?: string[]
  knowledgeBases?: string[]
  allowedTools?: string[]
}
interface AgentDraft {
  id?: string
  name: string
  description: string
  systemPrompt: string
  model: string
  temperature: string
  skills: string[]
  mcpServers: string[]
  knowledgeBases: string[]
  allowedTools: string[]
}
interface ResourceChoice { id: string; label: string; description?: string }
const newDraft = (): AgentDraft => ({ name: '', description: '', systemPrompt: '', model: '', temperature: '', skills: [], mcpServers: [], knowledgeBases: [], allowedTools: [] })
function listResult<T>(value: T[] | { list?: T[] }): T[] { return Array.isArray(value) ? value : value.list ?? [] }
function toggle(values: string[], value: string): string[] { return values.includes(value) ? values.filter(item => item !== value) : [...values, value] }

function BindingGroup({ title, hint, options, selected, onToggle, loading, disabled }: {
  title: string; hint: string; options: ResourceChoice[]; selected: string[]; onToggle: (id: string) => void; loading: boolean; disabled?: boolean
}): JSX.Element {
  // Keep missing/disabled identifiers visible so an old binding can be removed
  // even if its resource has since been deleted or its catalogue fails to load.
  const choices = [...options, ...selected.filter(id => !options.some(option => option.id === id)).map(id => ({ id, label: id, description: '已绑定资源，当前列表中不可用' }))]
  return <fieldset className="work-agent-manager__binding">
    <legend>{title}<small>{selected.length ? `已选 ${selected.length}` : '未绑定'}</small></legend>
    {loading ? <div className="work-agent-manager__binding-empty"><Spinner size={12} />正在加载…</div> : choices.length ? <div className="work-agent-manager__binding-list">
      {choices.map(option => <label key={option.id} className="work-agent-manager__binding-option">
        <input type="checkbox" checked={selected.includes(option.id)} disabled={disabled} onChange={() => onToggle(option.id)} />
        <span><strong>{option.label}</strong><small>{option.description || option.id}</small></span>
      </label>)}
    </div> : <div className="work-agent-manager__binding-empty">{hint}</div>}
  </fieldset>
}

interface Props {
  selectedId?: string
  locked?: boolean
  onSelect?: (agent: WorkAgent | null) => void
  onClose?: () => void
  standalone?: boolean
  workspacePath?: string | null
}

/** Composer picker and Work's full-page Agent administration share one implementation. */
export function WorkAgentManager({ selectedId = '', locked = false, onSelect = () => undefined, onClose = () => undefined, standalone = false, workspacePath }: Props): JSX.Element {
  const { models } = useModels()
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [deleting, setDeleting] = useState<AgentDefinition | null>(null)
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const [resourceLoading, setResourceLoading] = useState(false)
  const [resourceError, setResourceError] = useState('')
  const [resourceReload, setResourceReload] = useState(0)
  const [resourceChoices, setResourceChoices] = useState({ skills: [] as ResourceChoice[], mcpServers: [] as ResourceChoice[], knowledgeBases: [] as ResourceChoice[], allowedTools: [] as ResourceChoice[] })
  const alive = useRef(true)
  const epoch = useRef(getEngineSource())
  const current = (): boolean => alive.current && epoch.current === getEngineSource()
  const nameInput = useRef<HTMLInputElement>(null)
  const close = (): void => { if (!busy) onClose() }

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (draft) nameInput.current?.focus() }, [Boolean(draft)])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    void requestOrThrow<AgentDefinition[] | { list?: AgentDefinition[] }>({ method: 'GET', path: '/agents' })
      .then(result => { if (!cancelled && current()) setAgents(listResult(result).filter(item => item.id && item.name)) })
      .catch(cause => { if (!cancelled && current()) setError(cause instanceof Error ? cause.message : '无法读取 Agent') })
      .finally(() => { if (!cancelled && current()) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  useEffect(() => {
    if (!draft) return
    let cancelled = false
    setResourceLoading(true); setResourceError('')
    void Promise.allSettled([
      requestOrThrow<{ list?: Array<{ id?: string; name: string; description?: string; enabled?: boolean }> }>({ method: 'GET', path: '/skills', query: workspacePath ? { path: workspacePath } : undefined }),
      requestOrThrow<Array<{ id: string; name?: string; description?: string; enabled?: boolean }> | { list?: Array<{ id: string; name?: string; description?: string; enabled?: boolean }> }>({ method: 'GET', path: '/mcp/servers', query: workspacePath ? { path: workspacePath } : undefined }),
      listKnowledgeBases(),
      requestOrThrow<Array<{ name: string; displayName?: string; description?: string }> | { list?: Array<{ name: string; displayName?: string; description?: string }> }>({ method: 'GET', path: '/system-tools' })
    ]).then(([skills, mcps, knowledge, tools]) => {
      if (cancelled || !current()) return
      const failures = [skills, mcps, knowledge, tools].flatMap((result, index) => result.status === 'rejected' ? [`${['技能', 'MCP', '知识库', '工具'][index]}：${result.reason instanceof Error ? result.reason.message : '加载失败'}`] : [])
      setResourceError(failures.length ? failures.join('；') : '')
      const skillRows = skills.status === 'fulfilled' ? skills.value.list ?? [] : []
      const mcpRows = mcps.status === 'fulfilled' ? listResult(mcps.value) : []
      const kbRows = knowledge.status === 'fulfilled' ? knowledge.value : []
      const toolRows = tools.status === 'fulfilled' ? listResult(tools.value) : []
      setResourceChoices({
        skills: skillRows.filter(item => item.enabled !== false).map(item => ({ id: item.id || item.name, label: item.name, description: item.description })),
        mcpServers: mcpRows.filter(item => item.enabled !== false).map(item => ({ id: item.id, label: item.name || item.id, description: item.description })),
        knowledgeBases: kbRows.map((item: KnowledgeBase) => ({ id: item.id, label: item.name, description: item.description || `${item.documentCount ?? 0} 篇文档` })),
        allowedTools: toolRows.map(item => ({ id: item.name, label: item.displayName || item.name, description: item.description }))
      })
    }).finally(() => { if (!cancelled && current()) setResourceLoading(false) })
    return () => { cancelled = true }
  }, [Boolean(draft), resourceReload, workspacePath])

  const edit = async (agent: AgentDefinition): Promise<void> => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await requestOrThrow<AgentDefinition>({ method: 'GET', path: `/agents/${encodeURIComponent(agent.id)}` })
      if (current()) setDraft({
        id: result.id, name: result.name, description: result.description ?? '', systemPrompt: result.systemPrompt ?? '',
        model: result.model ?? '', temperature: result.temperature == null ? '' : String(result.temperature),
        skills: result.skills ?? [], mcpServers: result.mcpServers ?? [], knowledgeBases: result.knowledgeBases ?? [], allowedTools: result.allowedTools ?? []
      })
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '无法读取 Agent 配置') }
    finally { if (current()) setBusy(false) }
  }

  const save = async (): Promise<void> => {
    if (!draft || busy) return
    if (!draft.name.trim()) { setError('请输入 Agent 名称'); nameInput.current?.focus(); return }
    const temperature = draft.temperature.trim() ? Number(draft.temperature) : undefined
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) { setError('温度必须是 0 到 2 之间的数字'); return }
    setBusy(true); setError(null)
    try {
      const result = await requestOrThrow<AgentDefinition>({
        method: draft.id ? 'PUT' : 'POST', path: draft.id ? `/agents/${encodeURIComponent(draft.id)}` : '/agents',
        // Omit untouched empty bindings on first creation so older engines can
        // apply their own defaults. Existing Agents always send their arrays,
        // allowing an explicit uncheck to clear a persisted binding.
        body: {
          name: draft.name.trim(), description: draft.description.trim(), systemPrompt: draft.systemPrompt, model: draft.model, temperature,
          ...((draft.id || draft.skills.length || draft.mcpServers.length || draft.knowledgeBases.length || draft.allowedTools.length) ? {
            skills: draft.skills, mcpServers: draft.mcpServers, knowledgeBases: draft.knowledgeBases, allowedTools: draft.allowedTools
          } : {})
        }
      })
      if (!current()) return
      setAgents(previous => [...previous.filter(item => item.id !== result.id), result])
      setDraft(null)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '保存失败，请重试') }
    finally { if (current()) setBusy(false) }
  }

  const remove = async (): Promise<void> => {
    if (!deleting || busy || (locked && deleting.id === selectedId)) return
    setBusy(true); setError(null)
    try {
      await requestOrThrow({ method: 'DELETE', path: `/agents/${encodeURIComponent(deleting.id)}` })
      if (!current()) return
      setAgents(previous => previous.filter(item => item.id !== deleting.id))
      if (deleting.id === selectedId) onSelect(null)
      setDeleting(null)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '删除失败，请重试') }
    finally { if (current()) setBusy(false) }
  }

  const filtered = useMemo(() => agents.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [agents, query])
  const updateDraft = (patch: Partial<AgentDraft>): void => setDraft(previous => previous ? { ...previous, ...patch } : previous)

  const editor = draft ? <form className="work-agent-manager__form" onSubmit={event => { event.preventDefault(); void save() }}>
    <label>名称<input ref={nameInput} value={draft.name} maxLength={100} disabled={busy} onChange={event => updateDraft({ name: event.target.value })} placeholder="例如：代码审查助手" /></label>
    <label>用途<input value={draft.description} disabled={busy} maxLength={500} onChange={event => updateDraft({ description: event.target.value })} placeholder="简要说明适合交给它的任务" /></label>
    <label>工作指令<textarea value={draft.systemPrompt} disabled={busy} rows={7} onChange={event => updateDraft({ systemPrompt: event.target.value })} placeholder="定义职责、工作方式和交付标准…" /></label>
    <div className="work-agent-manager__form-grid">
      <div className="work-agent-manager__model"><span id="work-agent-model-label">默认模型</span><Select ariaLabel="Agent 默认模型" value={draft.model} onChange={model => updateDraft({ model })} disabled={busy} panelClassName="work-agent-manager__model-panel" options={[{ value: '', label: '使用任务模型' }, ...models.map(model => ({ value: model.id, label: model.displayName || model.modelId })), ...(draft.model && !models.some(model => model.id === draft.model) ? [{ value: draft.model, label: draft.model }] : [])]} /></div>
      <label className="work-agent-manager__temperature">温度<input inputMode="decimal" value={draft.temperature} disabled={busy} onChange={event => updateDraft({ temperature: event.target.value })} placeholder="默认" /></label>
    </div>
    <p className="work-agent-manager__hint">温度控制输出随机性；新建 Agent 留空使用引擎默认值，编辑已有值时留空会保留当前配置。绑定资源会随 Agent 一起保存。</p>
    <div className="work-agent-manager__bindings">
      <BindingGroup title="技能" hint="没有可用技能" options={resourceChoices.skills} selected={draft.skills} onToggle={id => updateDraft({ skills: toggle(draft.skills, id) })} loading={resourceLoading} disabled={busy} />
      <BindingGroup title="MCP 服务" hint="没有可用 MCP 服务" options={resourceChoices.mcpServers} selected={draft.mcpServers} onToggle={id => updateDraft({ mcpServers: toggle(draft.mcpServers, id) })} loading={resourceLoading} disabled={busy} />
      <BindingGroup title="知识库" hint="没有可用知识库" options={resourceChoices.knowledgeBases} selected={draft.knowledgeBases} onToggle={id => updateDraft({ knowledgeBases: toggle(draft.knowledgeBases, id) })} loading={resourceLoading} disabled={busy} />
      <BindingGroup title="工具权限" hint="没有可用工具" options={resourceChoices.allowedTools} selected={draft.allowedTools} onToggle={id => updateDraft({ allowedTools: toggle(draft.allowedTools, id) })} loading={resourceLoading} disabled={busy} />
    </div>
    {resourceError ? <div className="work-agent-manager__error" role="alert"><span>部分资源未能加载。{resourceError}</span><button type="button" className="btn btn--sm" disabled={busy || resourceLoading} onClick={() => setResourceReload(value => value + 1)}>重试资源</button></div> : null}
  </form> : <>{/* list */}
    <p className="work-agent-manager__hint">{locked ? '当前任务的 Agent 已固定。可管理 Agent，并在新任务中选用；编辑指令将在后续执行时读取。' : '选择处理这项工作的 Agent，也可以为经常使用的工作方式创建专属助手。'}</p>
    <div className="work-agent-manager__toolbar"><input aria-label="搜索 Agent" placeholder="搜索 Agent" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" className="btn btn--primary" disabled={busy} onClick={() => { setDraft(newDraft()); setError(null); setDeleting(null) }}><Icon name="plus" size={15} />新建 Agent</button></div>
    {deleting ? <div className="work-agent-manager__confirm" role="alert"><p>删除「{deleting.name}」？已有任务历史会保留，后续使用它的任务将回退到默认配置。</p><div><button type="button" className="btn" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button type="button" className="btn btn--danger" disabled={busy} onClick={() => void remove()}>{busy ? <Spinner /> : null}确认删除</button></div></div> : null}
    {loading ? <div className="work-agent-manager__empty" role="status"><Spinner />正在加载 Agent…</div> : <ul className="work-agent-manager__list" aria-label="可用 Agent">
      {!query ? <li className={!selectedId ? 'is-selected' : ''}><button type="button" className="work-agent-manager__choose" disabled={locked || busy} onClick={() => onSelect(null)}><Icon name="sparkles" size={20} /><span><strong>默认助手</strong><small>使用任务的模型与资源设置</small></span>{!selectedId ? <Icon name="check" size={16} /> : null}</button></li> : null}
      {filtered.map(agent => <li key={agent.id} className={selectedId === agent.id ? 'is-selected' : ''}><button type="button" className="work-agent-manager__choose" disabled={locked || busy} onClick={() => onSelect(agent)} aria-label={`使用 Agent ${agent.name}`}><Icon name="account-outline" size={20} /><span><strong>{agent.name}</strong><small>{agent.description || '自定义工作助手'}</small></span>{selectedId === agent.id ? <Icon name="check" size={16} /> : null}</button><div className="work-agent-manager__actions"><button type="button" className="btn btn--sm" aria-label={`编辑 Agent ${agent.name}`} disabled={busy} onClick={() => void edit(agent)}>编辑</button><button type="button" className="btn btn--sm" aria-label={`删除 Agent ${agent.name}`} disabled={busy || (locked && selectedId === agent.id)} onClick={() => { setDeleting(agent); setError(null) }}>删除</button></div></li>)}
      {!filtered.length ? <li className="work-agent-manager__empty">{query ? '没有匹配的 Agent' : '还没有自定义 Agent，点击「新建 Agent」开始。'}</li> : null}
    </ul>}
  </>

  const footer = draft ? <><button type="button" className="btn" disabled={busy} onClick={() => { setDraft(null); setError(null) }}>取消</button><button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : null}保存 Agent</button></> : <button type="button" className="btn" disabled={busy} onClick={close}>完成</button>
  if (standalone) return <div className="work-agent-manager-page"><header className="work-agent-manager-page__header"><div><span className="work-eyebrow">WORK · 配置</span><h1>Agent</h1><p>创建、编辑并管理任务使用的智能助手，以及它们可访问的模型、技能、MCP、知识库和工具。</p></div><button type="button" className="btn btn--primary" disabled={busy || Boolean(draft)} onClick={() => { setDraft(newDraft()); setError(null) }}><Icon name="plus" size={15} />新建 Agent</button></header><div className="work-agent-manager work-agent-manager--page"><div className="work-agent-manager__content">{error ? <div className="work-agent-manager__error" role="alert">{error}<button type="button" className="btn btn--sm" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>重试</button></div> : null}{editor}</div>{draft ? <footer className="work-agent-manager__page-footer">{footer}</footer> : null}</div></div>
  return <Dialog title={draft ? draft.id ? '编辑 Agent' : '新建 Agent' : '自定义 Agent'} width={680} className="work-agent-manager" onClose={close} footer={footer}><div className="work-agent-manager__content">{error ? <div className="work-agent-manager__error" role="alert">{error}{!draft ? <button type="button" className="btn btn--sm" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>重试</button> : null}</div> : null}{editor}</div></Dialog>
}
