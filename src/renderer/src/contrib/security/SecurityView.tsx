import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useAppMode } from '@renderer/core/platform/app-mode'
import { getEngineSource, getEngineStorageKey, subscribeEngineSource } from '@renderer/core/engine/source'
import { useWorkState } from '@renderer/contrib/work/work-state'
import { ACTION_LABELS, MODE_DESCRIPTORS, deletePolicy, listPolicies, resetPolicies, updatePolicy,
  type PolicyAction, type PolicyRule, type SecurityMode } from '@renderer/core/engine/security'
import { changeSecurityMode, useSecurityMode } from '@renderer/core/engine/security-store'
import { Icon } from '@renderer/workbench/icons'
import { Dialog } from '@renderer/workbench/Dialog'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Select } from '@renderer/workbench/Select'
import { Toggle } from '../settings/SettingsGroup'
import { ResourceSettingsEmpty, ResourceSettingsHeader, ResourceSettingsMenu } from '../settings/ResourceSettings'
import '../settings/settings-pages.css'
import './security-settings.css'

const MODE_SUMMARIES: Record<SecurityMode, string> = {
  safe: '检查命令与工作区路径；高危命令拒绝，未知命令询问。',
  standard: '普通命令直接执行，命中拒绝规则或注入检测时询问。',
  'full-access': '所有命令直接执行，跳过策略与白名单，保留审计日志。'
}
const ACTION_OPTIONS = (Object.keys(ACTION_LABELS) as PolicyAction[]).map(value => ({ value, label: ACTION_LABELS[value] }))

export function SecurityView(): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  // A new engine must not inherit the previous engine's rules or pending dialogs.
  return <SecuritySettingsContent key={source} source={source} />
}

function SecuritySettingsContent({ source }: { source: number }): JSX.Element {
  const { ready, settings } = useApp()
  const appMode = useAppMode()
  const workState = useWorkState(getEngineStorageKey())
  const workTask = workState.tasks.find(task => task.id === workState.activeTaskId)
  const sessionId = appMode === 'work' ? (workTask?.id ?? workState.homeSessionId ?? '') : settings.lastSessionId
  const { mode: storedMode, loading: modeLoading, error: modeError, refresh: refreshMode } = useSecurityMode(sessionId)
  const mode = ready ? storedMode : null
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [rulesLoading, setRulesLoading] = useState(false)
  const [rulesError, setRulesError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [detail, setDetail] = useState<PolicyRule | null>(null)
  const alive = useRef(true), sequence = useRef(0), writing = useRef(false)
  const searchInput = useRef<HTMLInputElement>(null), focusAfterRemoval = useRef(false)
  const rulesSection = useRef<HTMLElement>(null)
  const current = useCallback(() => alive.current && source === getEngineSource(), [source])

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const loadRules = useCallback(async (clearError = true): Promise<void> => {
    if (!current()) return
    const request = ++sequence.current
    setRulesLoading(true)
    if (clearError) setRulesError('')
    try {
      const next = await listPolicies()
      if (current() && request === sequence.current) setRules(next)
    } catch (error) {
      if (current() && request === sequence.current) setRulesError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current() && request === sequence.current) setRulesLoading(false)
    }
  }, [current])
  useEffect(() => { if (ready) void loadRules() }, [ready, loadRules])
  useEffect(() => { if (ready) void refreshMode(sessionId) }, [ready, sessionId, refreshMode])
  useLayoutEffect(() => {
    if (!focusAfterRemoval.current) return
    focusAfterRemoval.current = false
    // A changed action can remove the focused row from the active filter.
    ;(searchInput.current ?? rulesSection.current)?.focus({ preventScroll: true })
  }, [rules])

  const changeMode = async (next: SecurityMode): Promise<void> => {
    if (!ready || !sessionId || modeLoading || next === mode) return
    try { await changeSecurityMode(sessionId, next) } catch { /* The shared mode store owns the error. */ }
  }
  const mutateRules = async (action: () => Promise<void>): Promise<void> => {
    if (!ready || !current() || writing.current) return
    writing.current = true
    setBusy(true)
    setRulesError('')
    try { await action() } catch (error) {
      if (current()) {
        setRulesError(error instanceof Error ? error.message : String(error))
        // Keep the failure visible while restoring authoritative values.
        await loadRules(false)
      }
    } finally {
      writing.current = false
      if (current()) setBusy(false)
    }
  }
  const patchRule = (rule: PolicyRule, patch: Partial<PolicyRule>): void => {
    const id = rule.id
    if (id === undefined) return
    void mutateRules(async () => {
      focusAfterRemoval.current = actionFilter !== 'all' && patch.action !== undefined && patch.action !== actionFilter
      setRules(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item))
      await updatePolicy(id, patch)
    })
  }
  const removeRule = async (rule: PolicyRule): Promise<void> => {
    const id = rule.id
    if (id === undefined) return
    const confirmed = await confirmDialog({ title: '删除规则', body: '确定删除规则「' + rule.name + '」吗？', confirmText: '删除', danger: true })
    if (confirmed) void mutateRules(async () => {
      await deletePolicy(id)
      if (current()) {
        focusAfterRemoval.current = true
        setRules(previous => previous.filter(item => item.id !== id))
      }
    })
  }
  const restoreRules = async (): Promise<void> => {
    const confirmed = await confirmDialog({ title: '恢复默认策略规则', body: '确定恢复默认策略规则吗？现有规则的改动会全部丢失。', confirmText: '恢复默认', danger: true })
    if (confirmed) void mutateRules(async () => { await resetPolicies(); await loadRules() })
  }
  const needle = query.trim().toLocaleLowerCase()
  const visibleRules = rules.filter(rule => (actionFilter === 'all' || rule.action === actionFilter) &&
    (!needle || [rule.name, rule.command, rule.argPattern, rule.description].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)))
    .sort((a, b) => a.priority - b.priority)
  const modeDisabled = !ready || !sessionId || modeLoading
  const rulesDisabled = !ready || rulesLoading || busy
  const selectedDetail = detail && (rules.find(rule => rule.id !== undefined && rule.id === detail.id) ?? detail)

  return <div className="settings-view resource-settings settings-view--security">
    {!ready ? <p className="resource-feedback" role="status">引擎未就绪，连接后可管理安全策略。</p> : null}
    <section className="security-section" aria-label="会话安全模式">
      <ResourceSettingsHeader title="会话安全模式" description={workTask?.title ? '当前会话 · ' + workTask.title : sessionId ? '仅应用于当前会话' : '建立会话后可选择模式'} />
      <div className="resource-list security-mode-list" role="radiogroup" aria-label="本会话安全模式" aria-busy={modeLoading}>
        {MODE_DESCRIPTORS.map((descriptor, index) => <button key={descriptor.value} type="button" role="radio"
          aria-label={descriptor.label} aria-checked={mode === descriptor.value} disabled={!ready || !sessionId} aria-disabled={modeDisabled}
          tabIndex={mode === descriptor.value || (mode === null && index === 0) ? 0 : -1}
          className="security-mode" onClick={() => void changeMode(descriptor.value)} onKeyDown={event => {
            if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            if (modeDisabled) return
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 :
              (index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + 3) % 3
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
            void changeMode(MODE_DESCRIPTORS[next].value)
          }}>
          <span className="security-mode__copy"><strong>{descriptor.label}</strong><span>{MODE_SUMMARIES[descriptor.value]}</span></span>
          <span className="security-mode__radio" aria-hidden="true">{mode === descriptor.value ? <Icon name="check" size={12} /> : null}</span>
        </button>)}
      </div>
      <div className="security-mode-status" role="status">
        {modeLoading ? <><Spinner size={14} /><span>正在同步安全模式…</span></> : mode ? <><Icon name={mode === 'safe' ? 'shield' : 'info'} size={14} /><span>{mode === 'safe' ? '文件访问限于工作区。' : '允许 Agent 读写工作区以外的文件。'} 模式按会话保存。</span></> : <span>{sessionId ? '尚未读取到当前模式。' : '尚未建立会话。'}</span>}
        {ready && sessionId && !modeLoading && mode === null ? <button type="button" className="btn" onClick={() => void refreshMode(sessionId)}>重新读取安全模式</button> : null}
      </div>
      {modeError ? <p className="resource-feedback is-error" role="alert">{modeError}</p> : null}
    </section>

    <section ref={rulesSection} tabIndex={-1} className="security-section" aria-label="策略规则">
      <ResourceSettingsHeader title="策略规则" count={rules.length} description="规则对所有会话生效，按优先级依次匹配。">
        <button type="button" className="resource-icon-button" aria-label="刷新安全策略" title="刷新" disabled={rulesDisabled}
          onClick={() => { void loadRules(); void refreshMode(sessionId) }}>{rulesLoading ? <Spinner size={16} /> : <Icon name="refresh" size={17} />}</button>
        <ResourceSettingsMenu label="策略规则" disabled={rulesDisabled} actions={[{ label: '恢复默认规则', icon: 'restart', danger: true, onSelect: () => void restoreRules() }]} />
      </ResourceSettingsHeader>
      {rules.length > 0 ? <div className="security-filters">
        <div className="security-search"><Icon name="search" size={15} /><input ref={searchInput} className="field__input" type="search" aria-label="搜索策略规则" placeholder="搜索名称、命令或说明" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <Select className="settings-menu-field" ariaLabel="筛选规则动作" value={actionFilter} onChange={setActionFilter} options={[{ value: 'all', label: '全部动作' }, ...ACTION_OPTIONS]} />
      </div> : null}
      {rulesError ? <p className="resource-feedback is-error" role="alert">{rulesError}</p> : null}
      <div className="resource-list" role="list" aria-label="安全策略规则">
        {visibleRules.length ? visibleRules.map(rule => <article key={rule.id ?? rule.name + '-' + rule.command} role="listitem" aria-label={rule.name}
          className={'resource-row security-rule' + (rule.enabled ? '' : ' is-disabled')}>
          <button type="button" className="resource-row__main" aria-label={'查看规则：' + rule.name} onClick={() => setDetail(rule)}>
            <span className="resource-row__copy"><strong>{rule.name}</strong><code className="security-rule__command" title={[rule.command, rule.argPattern].filter(Boolean).join(' ')}>{rule.command}{rule.argPattern ? ' /' + rule.argPattern + '/' : ''}</code>
              <span className="resource-row__meta"><span>优先级 {rule.priority}</span><span>{rule.enabled ? '已启用' : '已停用'}</span></span>
              {rule.description ? <span className="security-rule__description" title={rule.description}>{rule.description}</span> : null}</span>
          </button>
          <div className="resource-row__actions security-rule__actions">
            <Select className="settings-menu-field" ariaLabel={rule.name + ' 的动作'} value={rule.action} disabled={rule.id === undefined || rulesDisabled}
              width={152} options={ACTION_OPTIONS} onChange={next => patchRule(rule, { action: next as PolicyAction })} />
            <Toggle checked={rule.enabled} disabled={rule.id === undefined || rulesDisabled} label={rule.name + ' 启用'} onChange={enabled => patchRule(rule, { enabled })} />
            <ResourceSettingsMenu label={'规则 ' + rule.name} actions={[
              { label: '查看详情', icon: 'info', onSelect: () => setDetail(rule) },
              { label: '删除规则', icon: 'trash', danger: true, disabled: rule.id === undefined || rulesDisabled, onSelect: () => void removeRule(rule) }
            ]} />
          </div>
        </article>) : <ResourceSettingsEmpty icon="shield" loading={rulesLoading} title={rulesLoading ? '正在读取规则…' : rules.length ? '没有匹配的规则' : ready ? '暂无策略规则' : '等待引擎连接'} description={rules.length ? '试试其他关键词或动作。' : undefined} />}
      </div>
      <details className="resource-disclosure security-explanation"><summary>规则如何生效</summary><div>
        <p>优先级数值越小越先匹配，命中第一条规则后生效。「*」匹配所有命令，参数支持正则表达式。</p>
        <p>安全模式按规则执行；标准模式将「询问」转为放行、「拒绝」转为询问；完全访问跳过所有规则。</p>
        <p>对话中的授权卡片也可切换本会话模式。已批准的命令会加入会话白名单，相同参数不再重复询问。</p>
      </div></details>
    </section>
    {selectedDetail ? <Dialog title="规则详情" width={600} className="resource-editor security-rule-detail" onClose={() => setDetail(null)}
      footer={<button type="button" className="btn" onClick={() => setDetail(null)}>完成</button>}>
      <h3>{selectedDetail.name}</h3>
      {selectedDetail.description ? <p className="resource-description">{selectedDetail.description}</p> : null}
      <dl><div><dt>匹配命令</dt><dd><code>{selectedDetail.command}</code></dd></div>
        <div><dt>参数表达式</dt><dd><code>{selectedDetail.argPattern || '不限参数'}</code></dd></div>
        <div><dt>命中动作</dt><dd>{ACTION_LABELS[selectedDetail.action]}</dd></div>
        <div><dt>优先级</dt><dd>{selectedDetail.priority}</dd></div>
        <div><dt>状态</dt><dd>{selectedDetail.enabled ? '已启用' : '已停用'}</dd></div>
        <div><dt>作用范围</dt><dd>所有会话</dd></div></dl>
    </Dialog> : null}
  </div>
}
