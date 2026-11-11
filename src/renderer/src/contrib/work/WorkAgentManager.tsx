import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { isTaskPlanControl } from '@renderer/core/engine/task-plan'
import { toolDisplayName } from '@renderer/core/engine/tool-labels'
import { useModels } from '@renderer/core/engine/model-store'
import { listKnowledgeBases, type KnowledgeBase } from '@renderer/core/engine/knowledge'
import { subscribeResourceCatalogueChanges } from '@renderer/core/engine/resource-catalogue'
import { Dialog } from '@renderer/workbench/Dialog'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Select } from '@renderer/workbench/Select'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import type { WorkAgent } from './WorkAgentPicker'
import { notifyWorkAgentsChanged } from './work-agent-identity'
import {
  canonicalAgentToolName,
  subscribeAgentCatalogueChanges,
  visibleAgentToolCatalogue
} from '@renderer/core/engine/agent-catalogue'
import { WorkTaskMenu } from './WorkTaskMenu'
import { groupAgentTools, selectAgentToolGroup } from './work-agent-tool-groups'
import {
  WORK_AGENT_TEMPLATES,
  hasAgentTemplateEdits,
  type AgentTemplateContent
} from './work-agent-templates'
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
  defaultEnabled?: boolean
  summary?: string
  category?: string
  source?: string
  unavailable?: boolean
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
function defaultAgentTools(options: readonly ResourceChoice[]): string[] {
  return options.filter((option) => option.defaultEnabled !== false).map((option) => option.id)
}
function hasDraftChanges(draft: AgentDraft, initial: AgentDraft): boolean {
  return (
    (['name', 'description', 'systemPrompt', 'model', 'temperature'] as const).some(
      (key) => draft[key] !== initial[key]
    ) ||
    resourceKeys.some(
      (key) =>
        draft[key].length !== initial[key].length ||
        draft[key].some((id) => !initial[key].includes(id))
    )
  )
}
const toolSummaries: Record<string, string> = {
  read_file: '读取文件内容，支持文本与常见办公文档。',
  write_file: '创建或写入文件内容。',
  edit_file: '精确修改现有文件中的指定内容。',
  list_files: '浏览工作目录中的文件与文件夹。',
  search_files: '按名称或内容查找文件。',
  run_command: '在工作区运行命令。',
  exec_command: '在工作区运行命令。'
}

function resourceSummary(option: ResourceChoice): string {
  const text =
    option.summary || option.description?.split(/[\r\n。！？]/)[0] || '查看详情了解此资源'
  const characters = Array.from(text)
  return characters.length > 90 ? characters.slice(0, 90).join('') + '…' : text
}

function ToolGroupCheckbox({
  label,
  selected,
  total,
  disabled,
  onChange
}: {
  label: string
  selected: number
  total: number
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const mixed = selected > 0 && selected < total
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed
  }, [mixed])
  return (
    <input
      ref={input}
      type="checkbox"
      aria-label={label}
      aria-checked={mixed ? 'mixed' : selected === total}
      checked={selected === total}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}

function BindingGroup({
  title,
  options,
  selected,
  onToggle,
  state,
  onRetry,
  disabled,
  actions,
  onSelectGroup
}: {
  title: string
  options: ResourceChoice[]
  selected: string[]
  onToggle: (id: string) => void
  state: ResourceState
  onRetry: () => void
  disabled?: boolean
  actions?: JSX.Element
  onSelectGroup?: (ids: string[], checked: boolean) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [category, setCategory] = useState('')
  const categoryButtons = useRef(new Map<string, HTMLButtonElement>())
  const groupId = useId()
  // Keep missing/disabled identifiers visible so an old binding can be removed
  // even if its resource has since been deleted or its catalogue fails to load.
  const choices: ResourceChoice[] = [
    ...options,
    ...selected
      .filter((id) => !options.some((option) => option.id === id))
      .map((id) => ({
        id,
        label: id,
        description: '已绑定资源，当前列表中不可用',
        unavailable: true
      }))
  ]
  const filtered = choices.filter(
    (option) =>
      (!onlySelected || selected.includes(option.id)) &&
      `${option.label} ${option.id} ${option.description || ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
  )
  const filtering = Boolean(query.trim()) || onlySelected
  const groups = onSelectGroup ? groupAgentTools(choices) : []
  const filteredIds = new Set(filtered.map((option) => option.id))
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      matches: group.options.filter((option) => filteredIds.has(option.id))
    }))
    .filter((group) => group.matches.length)
  // Filtering may hide the current category; show a matching one without
  // changing permissions or losing the category chosen before the search.
  const activeGroup = visibleGroups.find((group) => group.id === category) ?? visibleGroups[0]
  const panelId = `${groupId}-tools`
  const renderOption = (option: ResourceChoice): JSX.Element => (
    <div
      key={option.id}
      className={`work-agent-manager__binding-row${selected.includes(option.id) ? ' is-selected' : ''}`}
    >
      <label className="work-agent-manager__binding-option">
        <input
          type="checkbox"
          aria-label={option.label}
          checked={selected.includes(option.id)}
          disabled={disabled}
          onChange={() => onToggle(option.id)}
        />
        <span>
          <strong title={onSelectGroup ? option.id : undefined}>{option.label}</strong>
          {onSelectGroup ? (
            option.unavailable ? (
              <small>当前不可用</small>
            ) : null
          ) : (
            <small>
              {option.category && <em>{option.category} · </em>}
              {resourceSummary(option)}
            </small>
          )}
        </span>
      </label>
      <button
        type="button"
        className="work-agent-manager__binding-info"
        aria-label={`查看 ${option.label} 详情`}
        aria-expanded={expanded === option.id}
        aria-controls={`${groupId}-detail-${encodeURIComponent(option.id)}`}
        onClick={() => setExpanded((current) => (current === option.id ? null : option.id))}
      >
        <Icon name={expanded === option.id ? 'chevron-up' : 'info'} size={16} />
      </button>
      {expanded === option.id && (
        <div
          id={`${groupId}-detail-${encodeURIComponent(option.id)}`}
          className="work-agent-manager__binding-description"
        >
          <span>{option.id}</span>
          <p>{option.description || '暂无更多说明'}</p>
        </div>
      )}
    </div>
  )
  return (
    <section
      className={`work-agent-manager__binding${onSelectGroup ? ' work-agent-manager__binding--tools' : ''}`}
      role="group"
      aria-label={title}
    >
      <div className="work-agent-manager__binding-heading">
        <div className="work-agent-manager__binding-title">
          <h3>{title}</h3>
          <span>
            已选 {selected.length} / {choices.length}
          </span>
        </div>
        {actions}
      </div>
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
            <div className="work-agent-manager__binding-search">
              <Icon name="search" size={15} />
              <input
                className="ui-input"
                aria-label={`搜索${title}`}
                placeholder={`搜索${title}`}
                value={query}
                disabled={disabled}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setExpanded(null)
                }}
              />
            </div>
            <label className="work-agent-manager__selected-filter">
              <input
                type="checkbox"
                aria-label={`仅看已选${title}`}
                checked={onlySelected}
                disabled={disabled}
                onChange={(event) => {
                  setOnlySelected(event.target.checked)
                  setExpanded(null)
                }}
              />
              仅看已选
            </label>
          </div>
          {onSelectGroup ? (
            <div className="work-agent-manager__tool-browser">
              <nav className="work-agent-manager__tool-categories" aria-label="工具分类">
                {visibleGroups.map((group, index) => {
                  const selectedTotal = group.options.filter((option) =>
                    selected.includes(option.id)
                  ).length
                  const selectedMatches = group.matches.filter((option) =>
                    selected.includes(option.id)
                  ).length
                  return (
                    <div
                      key={group.id}
                      className={`work-agent-manager__tool-category${activeGroup?.id === group.id ? ' is-current' : ''}`}
                      data-tool-category={group.id}
                      role="group"
                      aria-label={group.label}
                    >
                      <label className="work-agent-manager__tool-group-check">
                        <ToolGroupCheckbox
                          label={`${filtering ? '选择本组匹配工具' : '选择本组全部工具'}：${group.label}`}
                          selected={selectedMatches}
                          total={group.matches.length}
                          disabled={disabled}
                          onChange={(checked) =>
                            onSelectGroup(
                              group.matches.map((option) => option.id),
                              checked
                            )
                          }
                        />
                      </label>
                      <button
                        ref={(element) => {
                          if (element) categoryButtons.current.set(group.id, element)
                          else categoryButtons.current.delete(group.id)
                        }}
                        type="button"
                        className="work-agent-manager__tool-category-button"
                        aria-label={`${group.label}工具分类`}
                        aria-pressed={activeGroup?.id === group.id}
                        aria-controls={panelId}
                        onClick={() => {
                          setCategory(group.id)
                          setExpanded(null)
                        }}
                        onKeyDown={(event) => {
                          const direction = ['ArrowDown', 'ArrowRight'].includes(event.key)
                            ? 1
                            : ['ArrowUp', 'ArrowLeft'].includes(event.key)
                              ? -1
                              : 0
                          if (!direction && event.key !== 'Home' && event.key !== 'End') return
                          event.preventDefault()
                          const next =
                            visibleGroups[
                              event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? visibleGroups.length - 1
                                  : (index + direction + visibleGroups.length) %
                                    visibleGroups.length
                            ]
                          setCategory(next.id)
                          setExpanded(null)
                          categoryButtons.current.get(next.id)?.focus()
                        }}
                      >
                        <span className="work-agent-manager__tool-group-title">{group.label}</span>
                        <span
                          className="work-agent-manager__tool-group-count"
                          title={`已选 ${selectedTotal} / ${group.options.length}${filtering ? ` · 匹配 ${group.matches.length}` : ''}`}
                        >
                          {selectedTotal}/{group.options.length}
                        </span>
                      </button>
                    </div>
                  )
                })}
              </nav>
              <section
                className="work-agent-manager__tool-panel"
                id={panelId}
                aria-label={activeGroup ? `${activeGroup.label}工具列表` : '工具列表'}
              >
                {activeGroup ? (
                  <>
                    <div className="work-agent-manager__tool-panel-heading">
                      <h4>{activeGroup.label}</h4>
                      <span>
                        {filtering
                          ? `匹配 ${activeGroup.matches.length} 项`
                          : `${activeGroup.options.length} 项工具`}
                      </span>
                    </div>
                    <div key={activeGroup.id} className="work-agent-manager__binding-list">
                      {activeGroup.matches.map(renderOption)}
                    </div>
                  </>
                ) : (
                  <div className="work-agent-manager__binding-empty">
                    没有匹配的工具，试试其他关键词。
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="work-agent-manager__binding-list">
              {filtered.map(renderOption)}
              {!filtered.length ? (
                <div className="work-agent-manager__binding-empty">
                  没有匹配的{title}，试试其他关键词。
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : !state.loading && !state.error ? (
        <div className="work-agent-manager__binding-empty">
          暂无可用{title}。可稍后绑定，不影响保存其他配置。
        </div>
      ) : null}
    </section>
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
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const [resourceReload, setResourceReload] = useState(0)
  const [resources, setResources] = useState(resourceState)
  const [tab, setTab] = useState<EditorTab>('basics')
  const [binding, setBinding] = useState<ResourceKey>('skills')
  const [templateId, setTemplateId] = useState('blank')
  const templateBaseline = useRef<AgentTemplateContent>(WORK_AGENT_TEMPLATES[0])
  const templateChanging = useRef(false)
  const editorGeneration = useRef(0)
  const initialDraft = useRef<AgentDraft | null>(null)
  const dismissing = useRef(false)
  const editorId = useId()
  const alive = useRef(true)
  const epoch = useRef(getEngineSource())
  const current = (): boolean => alive.current && epoch.current === getEngineSource()
  const nameInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const dismissEditor = (destination: 'close' | 'list'): void => {
    if (busy || dismissing.current) return
    dismissing.current = true
    void (async () => {
      if (
        draft &&
        initialDraft.current &&
        hasDraftChanges(draft, initialDraft.current) &&
        !(await confirmDialog({
          title: '放弃修改？',
          body: '尚未保存的 Agent 配置将丢失。',
          confirmText: '放弃修改',
          danger: true
        }))
      )
        return
      if (!current()) return
      editorGeneration.current++
      setDraft(null)
      setError(null)
      initialDraft.current = null
      if (destination === 'close') onClose()
    })().finally(() => {
      dismissing.current = false
    })
  }
  const close = (): void => dismissEditor('close')
  const returnToList = (): void => dismissEditor('list')
  const beginDraft = (): void => {
    const next = newDraft()
    editorGeneration.current++
    setTemplateId('blank')
    templateBaseline.current = WORK_AGENT_TEMPLATES[0]
    initialDraft.current = next
    setDraft(next)
    setTab('basics')
    setBinding('skills')
    setError(null)
  }
  const chooseTemplate = (id: string): void => {
    const template = WORK_AGENT_TEMPLATES.find((item) => item.id === id)
    if (!template || !draft || draft.id || busy || templateChanging.current || id === templateId)
      return
    const generation = editorGeneration.current
    templateChanging.current = true
    void (async () => {
      if (
        hasAgentTemplateEdits(draft, templateBaseline.current) &&
        !(await confirmDialog({
          title: '替换模板内容？',
          body: `应用「${template.label}」将替换名称、用途、工作指令和温度中的当前修改。模型、资源绑定与工具权限会保留。`,
          confirmText: '替换内容'
        }))
      )
        return
      if (!current() || editorGeneration.current !== generation) return
      const content: AgentTemplateContent = {
        name: template.name,
        description: template.description,
        systemPrompt: template.systemPrompt,
        temperature: template.temperature
      }
      // Async catalogue completion may update permissions while confirmation is
      // open. Merge only template fields into the latest draft.
      setDraft((previous) => (previous && !previous.id ? { ...previous, ...content } : previous))
      templateBaseline.current = content
      setTemplateId(template.id)
      setError(null)
    })().finally(() => {
      templateChanging.current = false
    })
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
  useEffect(() => subscribeAgentCatalogueChanges(() => setReload((value) => value + 1)), [])
  useEffect(() => subscribeResourceCatalogueChanges(['skill', 'knowledge'], () => setResourceReload(value => value + 1)), [])
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
          // with the engine's defaults; existing or explicitly edited limits stay intact.
          if (key === 'allowedTools') {
            const defaultTools = defaultAgentTools(options)
            // Loading engine defaults is not a user edit; restoring them should
            // also let an untouched new form close without a discard prompt.
            if (
              initialDraft.current &&
              !initialDraft.current.id &&
              !initialDraft.current.toolsInitialized
            )
              initialDraft.current = {
                ...initialDraft.current,
                allowedTools: defaultTools,
                toolsInitialized: true
              }
            setDraft((previous) =>
              previous && !previous.id && !previous.toolsInitialized
                ? {
                    ...previous,
                    allowedTools: defaultTools,
                    toolsInitialized: true
                  }
                : previous
            )
          }
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
        | Array<{
            name: string
            displayName?: string
            description?: string
            source?: string
            defaultEnabled?: boolean
          }>
        | {
            list?: Array<{
              name: string
              displayName?: string
              description?: string
              source?: string
              defaultEnabled?: boolean
            }>
          }
      >({
        method: 'GET',
        path: '/tools',
        toolProfile: 'general',
        query: workspacePath ? { path: workspacePath } : undefined
      }).then((result) =>
        visibleAgentToolCatalogue(listResult(result))
          .filter((item) => !isTaskPlanControl(item.name))
          .map((item) => ({
            id: item.name,
            label: item.displayName || toolDisplayName(item.name),
            description: item.description,
            summary: toolSummaries[item.name],
            source: item.source,
            category: `${item.name.startsWith('mcp_') ? 'MCP' : item.source === 'skill' ? '技能' : '内置'}${item.defaultEnabled === false ? ' · 按需启用' : ''}`,
            defaultEnabled: item.defaultEnabled
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
      if (current()) {
        const next: AgentDraft = {
          id: result.id,
          name: result.name,
          description: result.description ?? '',
          systemPrompt: result.systemPrompt ?? '',
          model: result.model ?? '',
          temperature: result.temperature == null ? '' : String(result.temperature),
          skills: result.skills ?? [],
          mcpServers: result.mcpServers ?? [],
          knowledgeBases: result.knowledgeBases ?? [],
          allowedTools: [
            ...new Set((result.allowedTools ?? []).map(canonicalAgentToolName))
          ].filter((name) => !isTaskPlanControl(name)),
          toolsInitialized: true
        }
        initialDraft.current = next
        editorGeneration.current++
        setDraft(next)
        setTab('basics')
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '无法读取 Agent 配置')
    } finally {
      if (current()) setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!draft || busy) return
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
      editorGeneration.current++
      setDraft(null)
      initialDraft.current = null
      notifyWorkAgentsChanged()
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '保存失败，请重试')
    } finally {
      if (current()) setBusy(false)
    }
  }

  const remove = async (agent: AgentDefinition): Promise<void> => {
    if (busy || (locked && agent.id === selectedId)) return
    if (
      !(await confirmDialog({
        title: '删除 Agent',
        body: `删除「${agent.name}」？已有任务历史会保留。`,
        confirmText: '删除',
        danger: true
      })) ||
      !current()
    )
      return
    setBusy(true)
    setError(null)
    try {
      await requestOrThrow({ method: 'DELETE', path: `/agents/${encodeURIComponent(agent.id)}` })
      if (!current()) return
      setAgents((previous) => previous.filter((item) => item.id !== agent.id))
      if (agent.id === selectedId) onSelect(null)
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
  const updateDraft = (patch: Partial<AgentDraft>): void => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous))
  }

  const editor = draft ? (
    <form
      className="work-agent-manager__form"
      aria-busy={busy}
      noValidate
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
              <span
                className="work-agent-manager__tab-warning"
                title="部分资源加载失败"
                aria-label="部分资源加载失败"
              >
                <Icon name="alert-circle" size={12} />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        className={`work-agent-manager__editor-scroll work-agent-manager__editor-scroll--${tab === 'basics' ? 'basics' : 'catalogue'}`}
        role="tabpanel"
        id={`${editorId}-panel`}
        aria-labelledby={`${editorId}-${tab}-tab`}
        key={tab}
      >
        {tab === 'basics' ? (
          <div className="work-agent-manager__basics">
            {!draft.id ? (
              <div className="work-agent-manager__template">
                <div className="work-agent-manager__section-title">
                  <h2>从模板开始</h2>
                  <p>选择工作场景后，可继续调整内容。</p>
                </div>
                <Select
                  ariaLabel="Agent 模板"
                  className="work-agent-manager__template-select"
                  panelClassName="work-agent-manager__template-panel"
                  width={280}
                  value={templateId}
                  onChange={chooseTemplate}
                  disabled={busy}
                  options={WORK_AGENT_TEMPLATES.map((template) => ({
                    value: template.id,
                    label: template.label,
                    description: template.description || '自行填写身份与工作指令'
                  }))}
                />
              </div>
            ) : null}
            <section className="work-agent-manager__form-section">
              <div className="work-agent-manager__section-title">
                <h2>身份与职责</h2>
              </div>
              <div className="work-agent-manager__field-row">
                <label>
                  名称
                  <input
                    className="ui-input"
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
                    className="ui-input"
                    value={draft.description}
                    disabled={busy}
                    maxLength={500}
                    onChange={(event) => updateDraft({ description: event.target.value })}
                    placeholder="简要说明适合交给它的任务"
                  />
                </label>
              </div>
              <label>
                工作指令
                <textarea
                  className="ui-input"
                  value={draft.systemPrompt}
                  disabled={busy}
                  rows={14}
                  onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
                  placeholder="定义职责、工作方式和交付标准…"
                />
              </label>
            </section>
            <section className="work-agent-manager__form-section">
              <div className="work-agent-manager__section-title">
                <h2>模型与生成</h2>
              </div>
              <div className="work-agent-manager__form-grid">
                <div className="work-agent-manager__model">
                  <span>模型</span>
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
                    className="ui-input"
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    inputMode="decimal"
                    value={draft.temperature}
                    disabled={busy}
                    onChange={(event) => updateDraft({ temperature: event.target.value })}
                    placeholder="默认 · 0–2"
                  />
                </label>
              </div>
              <p className="work-agent-manager__hint">
                温度越高，表达越多样；留空沿用已有值或引擎默认值。
              </p>
            </section>
          </div>
        ) : tab === 'resources' ? (
          <>
            <div className="work-agent-manager__section-title">
              <h2>工作资源</h2>
              <p>为 Agent 绑定技能、服务和知识。</p>
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
          <BindingGroup
            title="工具权限"
            actions={
              <div className="work-agent-manager__tool-actions" aria-label="工具批量操作">
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-label="使用默认助手工具"
                  title="恢复默认助手的工具选择"
                  disabled={
                    busy ||
                    resources.allowedTools.loading ||
                    Boolean(resources.allowedTools.error) ||
                    !resources.allowedTools.options.length
                  }
                  onClick={() =>
                    updateDraft({
                      allowedTools: defaultAgentTools(resources.allowedTools.options),
                      toolsInitialized: true
                    })
                  }
                >
                  默认助手
                </button>
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
            }
            options={resources.allowedTools.options}
            selected={draft.allowedTools}
            onToggle={(id) =>
              updateDraft({
                allowedTools: toggle(draft.allowedTools, id),
                toolsInitialized: true
              })
            }
            onSelectGroup={(ids, checked) =>
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      allowedTools: selectAgentToolGroup(current.allowedTools, ids, checked),
                      toolsInitialized: true
                    }
                  : current
              )
            }
            state={resources.allowedTools}
            onRetry={() => setResourceReload((value) => value + 1)}
            disabled={busy}
          />
        )}
      </div>
    </form>
  ) : (
    <>
      {locked && (
        <p className="work-agent-manager__hint">
          当前任务已固定 Agent，仍可编辑配置供后续任务使用。
        </p>
      )}
      <div className="work-agent-manager__toolbar">
        <div className="work-agent-manager__search">
          <Icon name="search" size={15} />
          <input
            ref={searchInput}
            className="ui-input ui-input--compact"
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
                    <span className="work-agent-manager__agent-copy">
                      <strong className="work-agent-manager__agent-name">默认助手</strong>
                      <small className="work-agent-manager__agent-description">
                        使用任务的模型与资源设置
                      </small>
                    </span>
                    {!selectedId ? (
                      <span className="work-agent-manager__picked" aria-label="当前选中">
                        <Icon name="check" size={14} />
                      </span>
                    ) : null}
                  </button>
                </li>
              </ul>
            </section>
          ) : null}
          <section className="work-agent-manager__group" aria-label="我的 Agent">
            <h3 className="work-agent-manager__group-title">
              {query ? '搜索结果' : '我的 Agent'}
              <span>{filtered.length}</span>
            </h3>
            {filtered.length ? (
              <ul className="work-agent-manager__list" aria-label="可用 Agent">
                {filtered.map((agent) => (
                  <li key={agent.id} className={selectedId === agent.id ? 'is-selected' : ''}>
                    <button
                      type="button"
                      className="work-agent-manager__choose"
                      disabled={busy}
                      onClick={() => (standalone || locked ? void edit(agent) : onSelect(agent))}
                      aria-label={`${standalone || locked ? '编辑' : '使用'} Agent ${agent.name}`}
                    >
                      <span className="work-agent-manager__avatar">
                        <Icon name="account-outline" size={18} />
                      </span>
                      <span className="work-agent-manager__agent-copy">
                        <strong className="work-agent-manager__agent-name">{agent.name}</strong>
                        <small
                          className="work-agent-manager__agent-description"
                          title={agent.description}
                        >
                          {agent.description || '自定义工作助手'}
                        </small>
                        <span className="work-agent-manager__agent-meta">
                          <span>
                            {agent.model
                              ? models.find((model) => model.id === agent.model)?.displayName ||
                                agent.model
                              : '使用任务模型'}
                          </span>
                          <span>
                            {agent.allowedTools?.length
                              ? `${agent.allowedTools.length} 项工具`
                              : '仅对话'}
                          </span>
                        </span>
                      </span>
                      {selectedId === agent.id ? (
                        <span className="work-agent-manager__picked" aria-label="当前选中">
                          <Icon name="check" size={14} />
                        </span>
                      ) : null}
                    </button>
                    <div className="work-agent-manager__actions">
                      {standalone ? (
                        <button
                          type="button"
                          className="btn btn--sm"
                          aria-label={`使用 Agent ${agent.name}`}
                          disabled={busy || locked}
                          onClick={() => onSelect(agent)}
                        >
                          使用
                        </button>
                      ) : !locked ? (
                        <button
                          type="button"
                          className="btn btn--sm"
                          aria-label={`编辑 Agent ${agent.name}`}
                          disabled={busy}
                          onClick={() => void edit(agent)}
                        >
                          编辑
                        </button>
                      ) : null}
                      <WorkTaskMenu
                        label={`${agent.name}的操作`}
                        disabled={busy}
                        items={[
                          { id: 'edit', label: '编辑 Agent', onSelect: () => void edit(agent) },
                          {
                            id: 'delete',
                            label: '删除 Agent',
                            danger: true,
                            separatorBefore: true,
                            disabled: locked && selectedId === agent.id,
                            onSelect: () => void remove(agent)
                          }
                        ]}
                      />
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
    <>
      <span className="work-agent-manager__footer-note">
        {busy ? '正在保存…' : 'Ctrl / ⌘ S 保存'}
      </span>
      <button type="button" className="btn" disabled={busy} onClick={returnToList}>
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
  ) : (
    <button type="button" className="btn" disabled={busy} onClick={close}>
      完成
    </button>
  )
  const content = (
    <div
      className="work-agent-manager__content"
      onKeyDown={(event) => {
        if (!draft && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          event.stopPropagation()
          searchInput.current?.focus()
          searchInput.current?.select()
        }
      }}
    >
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
              <h1>{draft ? (draft.id ? '编辑 Agent' : '新建 Agent') : 'Agent'}</h1>
              <p>
                {draft ? draft.name || '设置职责、资源与工具' : `${agents.length} 个自定义助手`}
              </p>
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
      // Keep the editor underneath the discard sheet until a choice is made.
      open={draft ? true : undefined}
      closeDisabled={busy}
      onClose={close}
      footer={footer}
    >
      {content}
    </Dialog>
  )
}
