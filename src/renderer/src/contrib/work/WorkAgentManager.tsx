import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { isTaskPlanControl } from '@renderer/core/engine/task-plan'
import { useModels } from '@renderer/core/engine/model-store'
import { listKnowledgeBases, type KnowledgeBase } from '@renderer/core/engine/knowledge'
import { Dialog } from '@renderer/workbench/Dialog'
import { Select } from '@renderer/workbench/Select'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import type { WorkAgent } from './WorkAgentPicker'
import { notifyWorkAgentsChanged } from './work-agent-identity'
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
  toolsInitialized: boolean
}
interface ResourceChoice {
  id: string
  label: string
  description?: string
}
type ResourceKey = 'skills' | 'mcpServers' | 'knowledgeBases' | 'allowedTools'
type EditorTab = 'basics' | 'resources' | 'tools'
interface ResourceState {
  options: ResourceChoice[]
  loading: boolean
  error: string
}
const resourceLabels: Record<ResourceKey, string> = {
  skills: '技能',
  mcpServers: 'MCP 服务',
  knowledgeBases: '知识库',
  allowedTools: '工具权限'
}
const resourceKeys: ResourceKey[] = ['skills', 'mcpServers', 'knowledgeBases', 'allowedTools']
const emptyResource = (): ResourceState => ({ options: [], loading: false, error: '' })
const resourceState = (): Record<ResourceKey, ResourceState> => ({
  skills: emptyResource(),
  mcpServers: emptyResource(),
  knowledgeBases: emptyResource(),
  allowedTools: emptyResource()
})
const newDraft = (): AgentDraft => ({
  name: '',
  description: '',
  systemPrompt: '',
  model: '',
  temperature: '',
  skills: [],
  mcpServers: [],
  knowledgeBases: [],
  allowedTools: [],
  toolsInitialized: false
})
function listResult<T>(value: T[] | { list?: T[] }): T[] {
  return Array.isArray(value) ? value : (value.list ?? [])
}
function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}
/** Give every agent a stable identity color derived from its name. */
function agentHue(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

function BindingGroup({
  title,
  options,
  selected,
  onToggle,
  state,
  onRetry,
  disabled,
  actions
}: {
  title: string
  options: ResourceChoice[]
  selected: string[]
  onToggle: (id: string) => void
  state: ResourceState
  onRetry: () => void
  disabled?: boolean
  actions?: JSX.Element
}): JSX.Element {
  const [query, setQuery] = useState('')
  // Keep missing/disabled identifiers visible so an old binding can be removed
  // even if its resource has since been deleted or its catalogue fails to load.
  const choices = [
    ...options,
    ...selected
      .filter((id) => !options.some((option) => option.id === id))
      .map((id) => ({ id, label: id, description: '已绑定资源，当前列表中不可用' }))
  ]
  const filtered = choices.filter((option) =>
    `${option.label} ${option.id} ${option.description || ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  )
  return (
    <fieldset className="work-agent-manager__binding">
      <legend>
        {title}
        <small>已选 {selected.length}</small>
      </legend>
      {state.error ? (
        <div className="work-agent-manager__resource-error" role="alert">
          <strong>
            {/权限|permission|forbidden|403/i.test(state.error)
              ? `当前账号无法浏览${title}`
              : `${title}加载失败`}
          </strong>
          <p>{state.error}</p>
          <div>
            <span>已保存的绑定会保留；可以继续配置其他项目。</span>
            <button
              type="button"
              className="btn btn--sm"
              disabled={disabled || state.loading}
              onClick={onRetry}
            >
              重试{title}
            </button>
          </div>
        </div>
      ) : null}
      {state.loading ? (
        <div className="work-agent-manager__binding-empty" role="status">
          <Spinner size={14} />
          正在加载{title}…
        </div>
      ) : null}
      {choices.length ? (
        <>
          <div className="work-agent-manager__binding-toolbar">
            <input
              aria-label={`搜索${title}`}
              placeholder={`搜索${title}`}
              value={query}
              disabled={disabled}
              onChange={(event) => setQuery(event.target.value)}
            />
            {actions}
          </div>
          <div className="work-agent-manager__binding-list">
            {filtered.map((option) => (
              <label
                key={option.id}
                className={`work-agent-manager__binding-option${selected.includes(option.id) ? ' is-selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(option.id)}
                  disabled={disabled}
                  onChange={() => onToggle(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description || option.id}</small>
                </span>
                <Icon name="check" size={16} />
              </label>
            ))}
            {!filtered.length ? (
              <div className="work-agent-manager__binding-empty">
                没有匹配的{title}，试试其他关键词。
              </div>
            ) : null}
          </div>
        </>
      ) : !state.loading && !state.error ? (
        <div className="work-agent-manager__binding-empty">
          暂无可用{title}。可稍后绑定，不影响保存其他配置。
        </div>
      ) : null}
    </fieldset>
  )
}

interface Props {
  selectedId?: string
  locked?: boolean
  onSelect?: (agent: WorkAgent | null) => void
  onClose?: () => void
  standalone?: boolean
  returnToTask?: boolean
  workspacePath?: string | null
}

/** Composer picker and Work's full-page Agent administration share one implementation. */
export function WorkAgentManager({
  selectedId = '',
  locked = false,
  onSelect = () => undefined,
  onClose = () => undefined,
  standalone = false,
  returnToTask = false,
  workspacePath
}: Props): JSX.Element {
  const { models } = useModels()
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [deleting, setDeleting] = useState<AgentDefinition | null>(null)
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const [resourceReload, setResourceReload] = useState(0)
  const [resources, setResources] = useState(resourceState)
  const [tab, setTab] = useState<EditorTab>('basics')
  const [binding, setBinding] = useState<ResourceKey>('skills')
  const [discarding, setDiscarding] = useState<'close' | 'list' | null>(null)
  const editorId = useId()
  const alive = useRef(true)
  const epoch = useRef(getEngineSource())
  const current = (): boolean => alive.current && epoch.current === getEngineSource()
  const nameInput = useRef<HTMLInputElement>(null)
  const close = (): void => {
    if (!busy) {
      if (draft) setDiscarding('close')
      else onClose()
    }
  }
  const returnToList = (): void => {
    if (!busy && draft) setDiscarding('list')
  }
  const beginDraft = (): void => {
    setDraft(newDraft())
    setTab('basics')
    setBinding('skills')
    setError(null)
    setDiscarding(null)
    setDeleting(null)
  }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (draft) nameInput.current?.focus()
  }, [Boolean(draft)])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void requestOrThrow<AgentDefinition[] | { list?: AgentDefinition[] }>({
      method: 'GET',
      path: '/agents'
    })
      .then((result) => {
        if (!cancelled && current())
          setAgents(listResult(result).filter((item) => item.id && item.name))
      })
      .catch((cause) => {
        if (!cancelled && current())
          setError(cause instanceof Error ? cause.message : '无法读取 Agent')
      })
      .finally(() => {
        if (!cancelled && current()) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reload])

  useEffect(() => {
    if (!draft) return
    let cancelled = false
    setResources(
      (previous) =>
        Object.fromEntries(
          resourceKeys.map((key) => [key, { ...previous[key], loading: true, error: '' }])
        ) as Record<ResourceKey, ResourceState>
    )
    // Independent completion keeps a slow catalogue from blocking all other bindings.
    const load = (key: ResourceKey, request: Promise<ResourceChoice[]>): void => {
      void request
        .then((options) => {
          if (cancelled || !current()) return
          setResources((previous) => ({
            ...previous,
            [key]: { options, loading: false, error: '' }
          }))
          // Empty allowedTools disables execution in the engine. A new assistant starts
          // with the current Work catalogue; existing or explicitly edited limits stay intact.
          if (key === 'allowedTools')
            setDraft((previous) =>
              previous && !previous.id && !previous.toolsInitialized
                ? {
                    ...previous,
                    allowedTools: options.map((option) => option.id),
                    toolsInitialized: true
                  }
                : previous
            )
        })
        .catch((cause) => {
          if (!cancelled && current())
            setResources((previous) => ({
              ...previous,
              [key]: {
                ...previous[key],
                loading: false,
                error: cause instanceof Error ? cause.message : '加载失败，请重试'
              }
            }))
        })
    }
    // Management IDs are path hashes; execution resolves a skill by its name.
    load(
      'skills',
      requestOrThrow<{
        list?: Array<{ id?: string; name: string; description?: string; enabled?: boolean }>
      }>({
        method: 'GET',
        path: '/skills',
        query: workspacePath ? { path: workspacePath } : undefined
      }).then((result) =>
        (result.list ?? [])
          .filter((item) => item.enabled !== false)
          .map((item) => ({ id: item.name, label: item.name, description: item.description }))
      )
    )
    load(
      'mcpServers',
      requestOrThrow<
        | Array<{ id: string; name?: string; description?: string; enabled?: boolean }>
        | { list?: Array<{ id: string; name?: string; description?: string; enabled?: boolean }> }
      >({
        method: 'GET',
        path: '/mcp/servers',
        query: workspacePath ? { path: workspacePath } : undefined
      }).then((result) =>
        listResult(result)
          .filter((item) => item.enabled !== false)
          .map((item) => ({
            id: item.id,
            label: item.name || item.id,
            description: item.description
          }))
      )
    )
    load(
      'knowledgeBases',
      listKnowledgeBases().then((result) =>
        result.map((item: KnowledgeBase) => ({
          id: item.id,
          label: item.name,
          description: item.description || `${item.documentCount ?? 0} 篇文档`
        }))
      )
    )
    load(
      'allowedTools',
      requestOrThrow<
        | Array<{ name: string; displayName?: string; description?: string; source?: string }>
        | {
            list?: Array<{
              name: string
              displayName?: string
              description?: string
              source?: string
            }>
          }
      >({
        method: 'GET',
        path: '/tools',
        toolProfile: 'general',
        query: workspacePath ? { path: workspacePath } : undefined
      }).then((result) =>
        listResult(result).filter(item => !isTaskPlanControl(item.name)).map((item) => ({
          id: item.name,
          label: item.displayName || item.name,
          description: `${item.name.startsWith('mcp_') ? 'MCP' : item.source === 'skill' ? '技能' : '内置'} · ${item.description || item.name}`
        }))
      )
    )
    return () => {
      cancelled = true
    }
  }, [Boolean(draft), resourceReload, workspacePath])

  const edit = async (agent: AgentDefinition): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await requestOrThrow<AgentDefinition>({
        method: 'GET',
        path: `/agents/${encodeURIComponent(agent.id)}`
      })
      if (current())
        setDraft({
          id: result.id,
          name: result.name,
          description: result.description ?? '',
          systemPrompt: result.systemPrompt ?? '',
          model: result.model ?? '',
          temperature: result.temperature == null ? '' : String(result.temperature),
          skills: result.skills ?? [],
          mcpServers: result.mcpServers ?? [],
          knowledgeBases: result.knowledgeBases ?? [],
          allowedTools: (result.allowedTools ?? []).filter(name => !isTaskPlanControl(name)),
          toolsInitialized: true
        })
      if (current()) {
        setTab('basics')
        setDiscarding(null)
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '无法读取 Agent 配置')
    } finally {
      if (current()) setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!draft || busy) return
    setDiscarding(null)
    if (!draft.name.trim()) {
      setError('请输入 Agent 名称')
      setTab('basics')
      requestAnimationFrame(() => nameInput.current?.focus())
      return
    }
    const temperature = draft.temperature.trim() ? Number(draft.temperature) : undefined
    if (
      temperature !== undefined &&
      (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    ) {
      setError('温度必须是 0 到 2 之间的数字')
      setTab('basics')
      return
    }
    if (!draft.toolsInitialized) {
      setError('工具列表尚未就绪。请重试加载，或在工具权限中明确选择仅对话。')
      setTab('tools')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await requestOrThrow<AgentDefinition>({
        method: draft.id ? 'PUT' : 'POST',
        path: draft.id ? `/agents/${encodeURIComponent(draft.id)}` : '/agents',
        body: {
          name: draft.name.trim(),
          description: draft.description.trim(),
          systemPrompt: draft.systemPrompt,
          model: draft.model,
          temperature,
          skills: draft.skills,
          mcpServers: draft.mcpServers,
          knowledgeBases: draft.knowledgeBases,
          allowedTools: draft.allowedTools
        }
      })
      if (!current()) return
      setAgents((previous) => [...previous.filter((item) => item.id !== result.id), result])
      setDraft(null)
      notifyWorkAgentsChanged()
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '保存失败，请重试')
    } finally {
      if (current()) setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleting || busy || (locked && deleting.id === selectedId)) return
    setBusy(true)
    setError(null)
    try {
      await requestOrThrow({ method: 'DELETE', path: `/agents/${encodeURIComponent(deleting.id)}` })
      if (!current()) return
      setAgents((previous) => previous.filter((item) => item.id !== deleting.id))
      if (deleting.id === selectedId) onSelect(null)
      setDeleting(null)
      notifyWorkAgentsChanged()
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '删除失败，请重试')
    } finally {
      if (current()) setBusy(false)
    }
  }

  const filtered = useMemo(
    () =>
      agents.filter((item) =>
        `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
      ),
    [agents, query]
  )
  const updateDraft = (patch: Partial<AgentDraft>): void =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous))

  const editor = draft ? (
    <form
      className="work-agent-manager__form"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          event.stopPropagation()
          void save()
        }
      }}
    >
      <div className="work-agent-manager__editor-heading">
        <Icon name="account-outline" size={24} />
        <div>
          <strong>{draft.id ? draft.name || '编辑 Agent' : '新建 Agent'}</strong>
          <span>定义工作方式，再按需绑定资源与工具。</span>
        </div>
      </div>
      <div
        className="work-agent-manager__tabs"
        role="tablist"
        aria-label="Agent 配置"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const tabs: EditorTab[] = ['basics', 'resources', 'tools']
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? 2
                : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3
          setTab(tabs[index])
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
        }}
      >
        {(
          [
            ['basics', '基础配置'],
            ['resources', '资源绑定'],
            ['tools', '工具权限']
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            id={`${editorId}-${key}-tab`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`${editorId}-panel`}
            tabIndex={tab === key ? 0 : -1}
            className={tab === key ? 'is-selected' : ''}
            onClick={() => setTab(key)}
          >
            {label}
            {key === 'resources' ? (
              <small>
                {draft.skills.length + draft.mcpServers.length + draft.knowledgeBases.length}
              </small>
            ) : key === 'tools' ? (
              <small>{draft.allowedTools.length}</small>
            ) : null}
            {(
              key === 'resources'
                ? resourceKeys.slice(0, 3).some((resource) => resources[resource].error)
                : key === 'tools' && resources.allowedTools.error
            ) ? (
              <span className="work-agent-manager__tab-warning" title="部分资源加载失败">
                !
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        className="work-agent-manager__editor-scroll"
        role="tabpanel"
        id={`${editorId}-panel`}
        aria-labelledby={`${editorId}-${tab}-tab`}
        key={tab}
      >
        {tab === 'basics' ? (
          <div className="work-agent-manager__basics">
            <div className="work-agent-manager__section-title">
              <h2>身份与职责</h2>
              <p>名称必填，其余配置可以稍后完善。</p>
            </div>
            <label>
              名称
              <input
                ref={nameInput}
                aria-required="true"
                aria-invalid={error === '请输入 Agent 名称'}
                value={draft.name}
                maxLength={100}
                disabled={busy}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder="例如：代码审查助手"
              />
            </label>
            <label>
              用途
              <input
                value={draft.description}
                disabled={busy}
                maxLength={500}
                onChange={(event) => updateDraft({ description: event.target.value })}
                placeholder="简要说明适合交给它的任务"
              />
            </label>
            <label>
              工作指令
              <textarea
                value={draft.systemPrompt}
                disabled={busy}
                rows={5}
                onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
                placeholder="定义职责、工作方式和交付标准…"
              />
            </label>
            <div className="work-agent-manager__section-title">
              <h2>模型与生成</h2>
              <p>模型和温度随 Agent 保存，在后续执行时读取。</p>
            </div>
            <div className="work-agent-manager__form-grid">
              <div className="work-agent-manager__model">
                <span>默认模型</span>
                <Select
                  ariaLabel="Agent 默认模型"
                  value={draft.model}
                  onChange={(model) => updateDraft({ model })}
                  disabled={busy}
                  panelClassName="work-agent-manager__model-panel"
                  options={[
                    { value: '', label: '使用任务模型' },
                    ...models.map((model) => ({
                      value: model.id,
                      label: model.displayName || model.modelId
                    })),
                    ...(draft.model && !models.some((model) => model.id === draft.model)
                      ? [{ value: draft.model, label: draft.model }]
                      : [])
                  ]}
                />
              </div>
              <label>
                温度
                <input
                  inputMode="decimal"
                  value={draft.temperature}
                  disabled={busy}
                  onChange={(event) => updateDraft({ temperature: event.target.value })}
                  placeholder="默认 · 0–2"
                />
              </label>
            </div>
            <p className="work-agent-manager__hint">
              温度控制输出随机性。新建时留空使用引擎默认值；编辑已有值时留空会保留当前配置。
            </p>
          </div>
        ) : tab === 'resources' ? (
          <>
            <div className="work-agent-manager__section-title">
              <h2>工作资源</h2>
              <p>选中的资源会在使用此 Agent 时加载。目录中的资源按当前账号权限展示。</p>
            </div>
            <div className="work-agent-manager__resource-nav" aria-label="资源类型">
              {(['skills', 'mcpServers', 'knowledgeBases'] as const).map((key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={binding === key}
                  className={binding === key ? 'is-selected' : ''}
                  onClick={() => setBinding(key)}
                >
                  {resourceLabels[key]}
                  <small>{draft[key].length}</small>
                  {resources[key].error ? <span title="加载失败">!</span> : null}
                </button>
              ))}
            </div>
            <BindingGroup
              key={binding}
              title={resourceLabels[binding]}
              options={resources[binding].options}
              selected={draft[binding]}
              onToggle={(id) => updateDraft({ [binding]: toggle(draft[binding], id) })}
              state={resources[binding]}
              onRetry={() => setResourceReload((value) => value + 1)}
              disabled={busy}
            />
          </>
        ) : (
          <>
            <div className="work-agent-manager__section-title">
              <h2>执行能力</h2>
              <p>
                新建 Agent 默认选择当前 Work
                可用工具。可缩小范围；实际执行仍受安全模式与引擎权限限制。
              </p>
            </div>
            <div className="work-agent-manager__tool-actions">
              <span>
                {draft.allowedTools.length
                  ? `已允许 ${draft.allowedTools.length} 项工具`
                  : '仅对话 · 未允许执行工具'}
              </span>
              <div>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={
                    busy || resources.allowedTools.loading || !resources.allowedTools.options.length
                  }
                  onClick={() =>
                    updateDraft({
                      allowedTools: [
                        ...new Set([
                          ...draft.allowedTools,
                          ...resources.allowedTools.options.map((option) => option.id)
                        ])
                      ],
                      toolsInitialized: true
                    })
                  }
                >
                  全选工具
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => updateDraft({ allowedTools: [], toolsInitialized: true })}
                >
                  仅对话
                </button>
              </div>
            </div>
            {!draft.allowedTools.length && draft.toolsInitialized ? (
              <p className="work-agent-manager__notice">
                <Icon name="info" size={16} />此 Agent
                只能回复文本，无法读写文件、运行命令或调用资源工具。
              </p>
            ) : null}
            <BindingGroup
              title="工具权限"
              options={resources.allowedTools.options}
              selected={draft.allowedTools}
              onToggle={(id) =>
                updateDraft({
                  allowedTools: toggle(draft.allowedTools, id),
                  toolsInitialized: true
                })
              }
              state={resources.allowedTools}
              onRetry={() => setResourceReload((value) => value + 1)}
              disabled={busy}
            />
          </>
        )}
      </div>
    </form>
  ) : (
    <>
      {/* list */}
      <p className="work-agent-manager__hint">
        {locked
          ? '当前任务的 Agent 已固定。可管理 Agent，并在新任务中选用；编辑指令将在后续执行时读取。'
          : '选择处理这项工作的 Agent，也可以为经常使用的工作方式创建专属助手。'}
      </p>
      <div className="work-agent-manager__toolbar">
        <div className="work-agent-manager__search">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索 Agent"
            placeholder="搜索 Agent"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={beginDraft}>
          <Icon name="plus" size={15} />
          新建 Agent
        </button>
      </div>
      {deleting ? (
        <div className="work-agent-manager__confirm" role="alert">
          <p>删除「{deleting.name}」？已有任务历史会保留，后续使用它的任务将回退到默认配置。</p>
          <div>
            <button type="button" className="btn" disabled={busy} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? <Spinner /> : null}确认删除
            </button>
          </div>
        </div>
      ) : null}
      {loading ? (
        <div className="work-agent-manager__skeleton" role="status" aria-label="正在加载 Agent">
          {[0, 1, 2].map((row) => (
            <div key={row} className="work-agent-manager__skeleton-row">
              <span className="work-agent-manager__skeleton-avatar" />
              <span className="work-agent-manager__skeleton-lines">
                <span />
                <span />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="work-agent-manager__groups">
          {!query ? (
            <section className="work-agent-manager__group" aria-label="系统">
              <h3 className="work-agent-manager__group-title">系统</h3>
              <ul className="work-agent-manager__list">
                <li className={!selectedId ? 'is-selected' : ''}>
                  <button
                    type="button"
                    className="work-agent-manager__choose"
                    disabled={locked || busy}
                    onClick={() => onSelect(null)}
                  >
                    <span className="work-agent-manager__avatar work-agent-manager__avatar--default">
                      <Icon name="sparkles" size={18} />
                    </span>
                    <span>
                      <strong>默认助手</strong>
                      <small>使用任务的模型与资源设置</small>
                    </span>
                    {!selectedId ? <Icon name="check" size={16} /> : null}
                  </button>
                </li>
              </ul>
            </section>
          ) : null}
          <section className="work-agent-manager__group" aria-label="我的 Agent">
            {!query ? <h3 className="work-agent-manager__group-title">我的 Agent</h3> : null}
            {filtered.length ? (
              <ul className="work-agent-manager__list work-agent-manager__list--cards" aria-label="可用 Agent">
                {filtered.map((agent) => (
                  <li key={agent.id} className={selectedId === agent.id ? 'is-selected' : ''}>
                    <button
                      type="button"
                      className="work-agent-manager__choose"
                      disabled={locked || busy}
                      onClick={() => onSelect(agent)}
                      aria-label={`使用 Agent ${agent.name}`}
                    >
                      <span
                        className="work-agent-manager__avatar"
                        style={{
                          '--agent-hue': agentHue(agent.name),
                          background: 'var(--agent-identity-bg)',
                          color: 'var(--agent-identity-fg)'
                        } as CSSProperties}
                      >
                        <Icon name="account-outline" size={20} />
                      </span>
                      <span>
                        <strong>{agent.name}</strong>
                        <small>{agent.description || '自定义工作助手'}</small>
                      </span>
                      {selectedId === agent.id ? (
                        <span className="work-agent-manager__picked" aria-label="当前选中">
                          <Icon name="check" size={14} />
                        </span>
                      ) : null}
                    </button>
                    <div className="work-agent-manager__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-label={`编辑 Agent ${agent.name}`}
                        disabled={busy}
                        onClick={() => void edit(agent)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        aria-label={`删除 Agent ${agent.name}`}
                        disabled={busy || (locked && selectedId === agent.id)}
                        onClick={() => {
                          setDeleting(agent)
                          setError(null)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="work-agent-manager__empty">
                <span className="work-agent-manager__empty-icon">
                  <Icon name="account-outline" size={28} />
                </span>
                <strong>{query ? '没有匹配的 Agent' : '还没有自定义 Agent'}</strong>
                <p>
                  {query
                    ? '换个关键词试试。'
                    : '为经常使用的工作方式创建专属助手，沉淀职责、模型与工具配置。'}
                </p>
                {!query ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={beginDraft}
                  >
                    <Icon name="plus" size={15} />
                    新建 Agent
                  </button>
                ) : null}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )

  const footer = draft ? (
    discarding ? (
      <>
        <span className="work-agent-manager__footer-note">放弃尚未保存的配置？</span>
        <button type="button" className="btn" disabled={busy} onClick={() => setDiscarding(null)}>
          继续编辑
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy}
          onClick={() => {
            setDraft(null)
            setError(null)
            setDiscarding(null)
            // Returning from the editor keeps the manager open; closing the
            // whole surface retains its original dismissal behavior.
            if (discarding === 'close') onClose()
          }}
        >
          放弃修改
        </button>
      </>
    ) : (
      <>
        <span className="work-agent-manager__footer-note">
          {busy ? '正在保存…' : 'Ctrl / ⌘ S 保存'}
        </span>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setDraft(null)
            setError(null)
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? <Spinner /> : null}保存 Agent
        </button>
      </>
    )
  ) : (
    <button type="button" className="btn" disabled={busy} onClick={close}>
      完成
    </button>
  )
  const content = (
    <div className="work-agent-manager__content">
      {error ? (
        <div className="work-agent-manager__error" role="alert">
          <span>{error}</span>
          {!draft ? (
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || loading}
              onClick={() => setReload((value) => value + 1)}
            >
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {editor}
    </div>
  )
  if (standalone)
    return (
      <div className="work-agent-manager-page">
        <header className="work-agent-manager-page__header">
          <div className="work-agent-manager-page__header-main">
            {draft ? (
              <button
                type="button"
                className="btn btn--sm work-agent-manager-page__back"
                disabled={busy}
                onClick={returnToList}
                aria-label="返回 Agent 列表"
              >
                <Icon name="chevron-left" size={15} />
                返回
              </button>
            ) : null}
            <div>
              <h1>Agent</h1>
              <p>{draft ? '配置你的工作助手' : '管理助手的职责、模型与执行能力'}</p>
            </div>
          </div>
          {!draft ? (
            <div className="work-agent-manager__header-actions">
              {returnToTask ? (
                <button type="button" className="btn" disabled={busy} onClick={onClose}>
                  返回任务
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={beginDraft}
              >
                <Icon name="plus" size={15} />
                新建 Agent
              </button>
            </div>
          ) : null}
        </header>
        <div className="work-agent-manager work-agent-manager--page">
          {content}
          {draft ? <footer className="work-agent-manager__page-footer">{footer}</footer> : null}
        </div>
      </div>
    )
  return (
    <Dialog
      title={draft ? (draft.id ? '编辑 Agent' : '新建 Agent') : '自定义 Agent'}
      width={720}
      className={`work-agent-manager${draft ? ' work-agent-manager--editing' : ''}`}
      onClose={close}
      footer={footer}
    >
      {content}
    </Dialog>
  )
}
