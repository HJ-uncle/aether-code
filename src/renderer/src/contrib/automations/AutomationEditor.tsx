import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import type { CronAutomationRun, CronCapabilities, CronPreviewResponse, CronThinkingMode } from '@shared/automation'
import { getEngineSource } from '@renderer/core/engine/source'
import { Dialog } from '@renderer/workbench/Dialog'
import { Select } from '@renderer/workbench/Select'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { getAutomationAgents, getAutomationSessionBinding, previewAutomation, saveAutomation, setAutomationEnabled,
  type AutomationAgent, type AutomationJob, type AutomationSession, type AutomationSessionBinding } from './automation-client'
import { AUTOMATION_TIMEOUT_OPTIONS, automationWriteBody, createAutomationDraft, draftErrors, scheduleFromDraft, type AutomationDraft } from './automation-draft'
import { AutomationRuns } from './AutomationRuns'

function toLocalInput(value: number): string {
  const date = new Date(value)
  const pad = (number: number): string => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function AutomationEditor({ job, capabilities, sessions, currentSessionId, currentAgentId, thinkingMode, initialTab = 'settings', onClose, onSaved, onOpenRun, onManageAgent }: {
  job?: AutomationJob
  capabilities: CronCapabilities | null
  sessions: AutomationSession[]
  currentSessionId?: string
  currentAgentId?: string
  thinkingMode?: CronThinkingMode
  initialTab?: 'settings' | 'runs'
  onClose: () => void
  onSaved: (job: AutomationJob) => void
  onOpenRun: (run: CronAutomationRun) => void | Promise<void>
  onManageAgent: () => void
}): JSX.Element {
  const [savedJob, setSavedJob] = useState(job)
  const [draft, setDraft] = useState(() => createAutomationDraft({ job, capabilities, sessionId: currentSessionId, agentId: currentAgentId, thinkingMode }))
  const [tab, setTab] = useState(initialTab)
  const [agents, setAgents] = useState<AutomationAgent[]>([])
  const [agentError, setAgentError] = useState('')
  const [binding, setBinding] = useState<AutomationSessionBinding | null>(null)
  const [bindingError, setBindingError] = useState(''), [bindingLoading, setBindingLoading] = useState(false)
  const [preview, setPreview] = useState<CronPreviewResponse | null>(null), [previewError, setPreviewError] = useState(''), [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false), [changingEnabled, setChangingEnabled] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false)
  const [confirmManage, setConfirmManage] = useState(false)
  const owned = useRef(true), savePending = useRef(false), nameRef = useRef<HTMLInputElement>(null), formRef = useRef<HTMLFormElement>(null)
  const id = useId()
  useEffect(() => {
    owned.current = true
    const source = getEngineSource()
    const frame = requestAnimationFrame(() => { if (initialTab === 'settings') nameRef.current?.focus() })
    void getAutomationAgents().then(value => { if (owned.current && source === getEngineSource()) setAgents(value) })
      .catch(cause => { if (owned.current && source === getEngineSource()) setAgentError(cause instanceof Error ? cause.message : '无法读取 Agent') })
    return () => { owned.current = false; cancelAnimationFrame(frame) }
  }, [initialTab])
  useEffect(() => {
    let alive = true
    const source = getEngineSource()
    setBinding(null); setBindingError('')
    if (draft.target !== 'session' || !draft.sessionId) { setBindingLoading(false); return }
    setBindingLoading(true)
    void getAutomationSessionBinding(draft.sessionId).then(value => {
      if (alive && source === getEngineSource()) { setBinding(value); setBindingLoading(false) }
    }).catch(cause => { if (alive && source === getEngineSource()) { setBindingError(cause instanceof Error ? cause.message : '无法确认聊天绑定'); setBindingLoading(false) } })
    return () => { alive = false }
  }, [draft.target, draft.sessionId])
  const update = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]): void => setDraft(previous => ({ ...previous, [key]: value }))
  const errors = useMemo(() => draftErrors(draft, capabilities), [draft, capabilities])
  const scheduleKey = JSON.stringify({ repeat: draft.repeat, everyMinutes: draft.everyMinutes, anchorAt: draft.anchorAt, localTime: draft.localTime, daysOfWeek: draft.daysOfWeek, timeZone: draft.timeZone, expression: draft.expression })
  useEffect(() => {
    let alive = true
    const source = getEngineSource()
    setPreview(null); setPreviewError('')
    if (!capabilities) { setPreviewLoading(false); return }
    let schedule: ReturnType<typeof scheduleFromDraft>
    try { schedule = scheduleFromDraft(draft) } catch (cause) { setPreviewLoading(false); setPreviewError(cause instanceof Error ? cause.message : '执行规则无效'); return }
    setPreviewLoading(true)
    const timer = window.setTimeout(() => {
      void previewAutomation({ schedule, count: 3 }).then(value => {
        if (alive && source === getEngineSource()) { setPreview(value); setPreviewLoading(false) }
      }).catch(cause => { if (alive && source === getEngineSource()) { setPreviewError(cause instanceof Error ? cause.message : '无法预览执行时间'); setPreviewLoading(false) } })
    }, 350)
    return () => { alive = false; window.clearTimeout(timer) }
    // Only schedule fields affect the preview; editing the prompt must not rerun it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleKey, capabilities])
  const save = async (): Promise<void> => {
    setAttempted(true)
    if (savePending.current || Object.keys(errors).length) return
    if (draft.target === 'session' && (bindingLoading || bindingError)) { setError(bindingError || '请等待聊天绑定确认后保存。'); return }
    savePending.current = true; setSaving(true); setError('')
    const source = getEngineSource()
    try {
      const updated = await saveAutomation(savedJob?.id, automationWriteBody(draft, capabilities, savedJob))
      if (!owned.current || source !== getEngineSource()) return
      onSaved(updated); onClose()
    } catch (cause) { if (owned.current && source === getEngineSource()) setError(cause instanceof Error ? cause.message : '保存失败，草稿已保留。') }
    finally { savePending.current = false; if (owned.current && source === getEngineSource()) setSaving(false) }
  }
  const toggleEnabled = async (): Promise<void> => {
    if (!savedJob || changingEnabled || saving) return
    const source = getEngineSource()
    setChangingEnabled(true); setError('')
    try {
      const updated = await setAutomationEnabled(savedJob.id, !savedJob.enabled)
      if (!owned.current || source !== getEngineSource()) return
      // Pausing does not commit the unsaved name, prompt, or schedule.
      setSavedJob(updated); update('enabled', updated.enabled); onSaved(updated)
    } catch (cause) { if (owned.current && source === getEngineSource()) setError(cause instanceof Error ? cause.message : '无法更新计划状态') }
    finally { if (owned.current && source === getEngineSource()) setChangingEnabled(false) }
  }
  const selectedAgent = agents.find(agent => agent.id === (draft.target === 'session' ? binding?.agentId : draft.agentId))
  const knownSessions = draft.sessionId && !sessions.some(session => session.id === draft.sessionId)
    ? [{ id: draft.sessionId, title: `已绑定聊天 ${draft.sessionId}` }, ...sessions] : sessions
  const workspaceSessions = sessions.filter(session => session.workspacePath)
  if (draft.sourceSessionId && !workspaceSessions.some(session => session.id === draft.sourceSessionId)) workspaceSessions.unshift({ id: draft.sourceSessionId, title: `源聊天 ${draft.sourceSessionId}` })
  const repeatOptions = [
    ...(capabilities?.schedules.includes('interval') ? [{ value: 'interval', label: '按间隔' }] : []),
    ...(capabilities?.schedules.includes('calendar') ? [{ value: 'daily', label: '每天' }, { value: 'weekdays', label: '工作日' }, { value: 'weekly', label: '每周' }] : []),
    ...(!capabilities || capabilities.schedules.includes('legacy') ? [{ value: 'legacy', label: '自定义表达式' }] : [])
  ]
  const targetOptions = [
    ...(!capabilities || capabilities.targets.includes('session') ? [{ value: 'session', label: '复用已有聊天', description: '沿用聊天已固定的 Agent 与安全范围' }] : []),
    ...(capabilities?.targets.includes('standalone') ? [{ value: 'standalone', label: '每次新建独立聊天', description: '无需项目，在独立工作目录完成任务' }] : []),
    ...(capabilities?.targets.includes('workspace') ? [{ value: 'workspace', label: '每次新建项目聊天', description: '跟随源聊天已授权的工作目录' }] : [])
  ]
  const disabled = saving || changingEnabled
  return <Dialog title={savedJob ? '编辑自动化' : '新建自动化'} width={760} className="automation-editor" onClose={() => { if (!saving) onClose() }} footer={<>
    <div className="automation-editor__footer-status">{savedJob ? <button className="btn btn--sm" type="button" disabled={disabled || (!savedJob.enabled && capabilities?.executionSupported === false)} onClick={() => void toggleEnabled()}>{changingEnabled ? <Spinner size={13} /> : <Icon name={savedJob.enabled ? 'stop' : 'play'} size={13} />}{savedJob.enabled ? '暂停未来触发' : '恢复计划'}</button> : <label className="automation-toggle"><input type="checkbox" checked={draft.enabled} disabled={disabled || capabilities?.executionSupported === false} onChange={event => update('enabled', event.target.checked)} />保存后启用</label>}</div>
    <button className="btn" type="button" disabled={saving} onClick={onClose}>取消</button>
    {tab === 'settings' ? <button className="btn btn--primary" type="button" disabled={disabled || Boolean(errors.timeout)} onClick={() => formRef.current?.requestSubmit()}>{saving ? <Spinner size={14} /> : <Icon name="check" size={14} />}{saving ? '正在保存…' : '保存自动化'}</button> : <button className="btn btn--primary" type="button" onClick={onClose}>完成</button>}
  </>}>
    {savedJob && capabilities?.runHistory ? <div className="automation-editor__tabs" role="tablist" aria-label="自动化详情"><button type="button" role="tab" aria-selected={tab === 'settings'} disabled={saving} onClick={() => setTab('settings')}>设置</button><button type="button" role="tab" aria-selected={tab === 'runs'} disabled={saving} onClick={() => setTab('runs')}>运行记录</button></div> : null}
    {error ? <p className="automation-error" role="alert">{error}</p> : null}
    {capabilities?.executionSupported === false ? <p className="automation-note" role="status">当前引擎的认证模式暂不支持自动派发。可以编辑并保存为已暂停，已有运行记录仍可查看。</p> : !capabilities ? <p className="automation-note">当前引擎使用旧版规则；保留已有聊天与时间表达式。</p> : null}
    {tab === 'runs' && savedJob && capabilities?.runHistory ? <AutomationRuns key={savedJob.id} jobId={savedJob.id} capabilities={capabilities} onOpenRun={onOpenRun} /> : <form ref={formRef} className="automation-editor__form" onSubmit={event => { event.preventDefault(); void save() }} onKeyDown={event => {
      // Some IMEs report their commit Enter as keyCode 229 even after isComposing clears.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void save() }
    }}>
      <section className="automation-editor__section">
        <label className="automation-field"><span>名称</span><input ref={nameRef} value={draft.name} disabled={disabled} placeholder="工作日简报" onChange={event => update('name', event.target.value)} aria-invalid={attempted && Boolean(errors.name)} aria-describedby={errors.name && attempted ? `${id}-name-error` : undefined} /></label>
        {attempted && errors.name ? <p id={`${id}-name-error`} className="automation-field-error">{errors.name}</p> : null}
        <label className="automation-field"><span>每次运行的目标</span><textarea rows={4} value={draft.message} disabled={disabled} placeholder="让 AI 完成什么工作？" onChange={event => update('message', event.target.value)} aria-invalid={attempted && Boolean(errors.message)} aria-describedby={errors.message && attempted ? `${id}-message-error` : undefined} /></label>
        {attempted && errors.message ? <p id={`${id}-message-error`} className="automation-field-error">{errors.message}</p> : null}
      </section>
      <section className="automation-editor__section" aria-label="执行计划">
        <div className="automation-section-heading"><h3>执行计划</h3></div>
        <div className="automation-field-grid"><div className="automation-field"><span>重复</span><Select panelClassName="automation-select-panel" ariaLabel="自动化重复类型" value={draft.repeat} options={repeatOptions} disabled={disabled} onChange={value => update('repeat', value as AutomationDraft['repeat'])} /></div>
          {draft.repeat === 'interval' ? <label className="automation-field"><span>间隔（分钟）</span><input type="number" min={1} step={1} value={draft.everyMinutes} disabled={disabled} onChange={event => update('everyMinutes', event.target.value)} /></label> : draft.repeat === 'legacy' ? <label className="automation-field"><span>时间表达式</span><input value={draft.expression} disabled={disabled} placeholder="分 时 日 月 周" onChange={event => update('expression', event.target.value)} /></label> : <label className="automation-field"><span>执行时间</span><input type="time" value={draft.localTime} disabled={disabled} onChange={event => update('localTime', event.target.value)} /></label>}
        </div>
        {draft.repeat === 'weekly' ? <div className="automation-weekdays" role="group" aria-label="每周执行日期">{days.map((day, index) => <button type="button" key={day} aria-pressed={draft.daysOfWeek.includes(index)} disabled={disabled} onClick={() => update('daysOfWeek', draft.daysOfWeek.includes(index) ? draft.daysOfWeek.filter(value => value !== index) : [...draft.daysOfWeek, index])}>{day}</button>)}</div> : null}
        {draft.repeat === 'interval' ? <label className="automation-field"><span>起始时间 · {draft.timeZone}</span><input type="datetime-local" value={toLocalInput(draft.anchorAt)} disabled={disabled} onChange={event => { const value = new Date(event.target.value).getTime(); if (Number.isFinite(value)) update('anchorAt', Math.floor(value / 60000) * 60000) }} /></label> : capabilities ? <label className="automation-field"><span>时区</span><input list={`${id}-timezones`} value={draft.timeZone} disabled={disabled} onChange={event => update('timeZone', event.target.value)} /><datalist id={`${id}-timezones`}>{[...new Set([draft.timeZone, 'Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles'])].map(zone => <option key={zone} value={zone} />)}</datalist></label> : null}
        <div className="automation-preview" aria-live="polite">{previewLoading ? <span><Spinner size={13} />正在预览执行时间…</span> : previewError ? <p className="automation-field-error">{previewError}</p> : preview ? <><strong>{preview.summary}</strong><span>下一次 {preview.nextRunAt ? new Date(preview.nextRunAt).toLocaleString('zh-CN', draft.repeat === 'interval' ? undefined : { timeZone: draft.timeZone }) : '没有可执行的时间'}</span><small>{draft.repeat === 'interval' ? '按起始时间连续间隔执行。' : `以上时间使用 ${draft.timeZone}。`} 错过的时间不会补跑，前一次未完成时跳过新一轮。</small></> : <span>{savedJob?.nextRunAt ? `下一次 ${new Date(savedJob.nextRunAt).toLocaleString()}` : '保存后由引擎确定执行时间。'}</span>}</div>
        {attempted && errors.schedule ? <p className="automation-field-error">{errors.schedule}</p> : null}
      </section>
      <section className="automation-editor__section" aria-label="运行目标">
        <div className="automation-section-heading"><h3>运行目标</h3></div>
        <div className="automation-field"><span>聊天方式</span><Select panelClassName="automation-select-panel" ariaLabel="自动化聊天方式" value={draft.target} disabled={disabled} options={targetOptions} onChange={value => update('target', value as AutomationDraft['target'])} /></div>
        {draft.target === 'session' ? <><div className="automation-field"><span>复用聊天</span><Select panelClassName="automation-select-panel" ariaLabel="自动化复用聊天" value={draft.sessionId} disabled={disabled} triggerLabel={!draft.sessionId ? '选择已有聊天' : undefined} options={knownSessions.map(session => ({ value: session.id, label: session.title, description: session.workspacePath || '独立任务' }))} onChange={value => update('sessionId', value)} /></div><p className={bindingError ? 'automation-field-error' : 'automation-note'}>{bindingLoading ? '正在确认聊天的 Agent 绑定…' : bindingError || `Agent：${binding?.agent?.name || selectedAgent?.name || binding?.agentId || '引擎默认'}。沿用聊天当前绑定，不在自动化中切换。`}</p></> : draft.target === 'workspace' ? <><div className="automation-field"><span>项目来源</span><Select panelClassName="automation-select-panel" ariaLabel="自动化项目来源" value={draft.sourceSessionId} disabled={disabled} triggerLabel={!draft.sourceSessionId ? '选择已绑定项目的聊天' : undefined} options={workspaceSessions.map(session => ({ value: session.id, label: session.title, description: session.workspacePath || '保存时验证服务端绑定' }))} onChange={value => update('sourceSessionId', value)} /></div><p className="automation-note">每次创建新聊天，跟随源聊天已授权的目录。源聊天改选项目后，后续运行跟随；来源失效时会报告失败。</p></> : <p className="automation-note">每次创建独立聊天，无需先打开项目。新聊天使用引擎默认安全范围。</p>}
        {draft.target !== 'session' ? <div className="automation-field"><span>Agent</span><Select panelClassName="automation-select-panel" ariaLabel="自动化使用的 Agent" value={draft.agentId} disabled={disabled} options={[{ value: '', label: '引擎默认 Agent' }, ...(draft.agentId && !agents.some(agent => agent.id === draft.agentId) ? [{ value: draft.agentId, label: draft.agentId, description: '当前配置，未在列表中找到' }] : []), ...agents.map(agent => ({ value: agent.id, label: agent.name, description: agent.model || '跟随引擎模型' }))]} onChange={value => update('agentId', value)} /><button className="automation-link" type="button" onClick={() => setConfirmManage(true)}>管理 Agent 配置</button>{confirmManage ? <p className="automation-note">打开管理会放弃当前未保存的草稿。<button type="button" className="btn btn--sm" onClick={onManageAgent}>放弃草稿并打开</button><button type="button" className="btn btn--sm" onClick={() => setConfirmManage(false)}>继续编辑</button></p> : null}{agentError ? <p className="automation-field-error">{agentError}</p> : null}</div> : null}
        <p className="automation-note">模型：{selectedAgent?.model ? `${selectedAgent.model} · Agent 配置` : '运行时由引擎解析'}。实际使用的模型在运行记录中显示。</p>
        {attempted && errors.target ? <p className="automation-field-error">{errors.target}</p> : null}
      </section>
      <details className="automation-advanced"><summary>高级选项</summary><div className="automation-advanced__body">
        {capabilities ? <div className="automation-field"><span>通知</span><Select panelClassName="automation-select-panel" ariaLabel="自动化通知策略" value={draft.notificationPolicy} disabled={disabled} options={capabilities.notificationPolicies.map(value => ({ value, label: value === 'all_runs' ? '记录运行结果与待回复通知' : '静默 · 只保留运行记录' }))} onChange={value => update('notificationPolicy', value as AutomationDraft['notificationPolicy'])} /></div> : null}
        <div className="automation-field-grid"><div className="automation-field"><span>思考档位</span><Select panelClassName="automation-select-panel" ariaLabel="自动化思考档位" value={draft.thinking} disabled={disabled} options={[{ value: 'auto', label: '自动 · 模型默认' }, { value: 'off', label: 'Off · 关闭思考' }, { value: 'low', label: 'Low · 轻量' }, { value: 'medium', label: 'Medium · 平衡' }, { value: 'high', label: 'High · 深度' }, ...(draft.thinking === 'on' ? [{ value: 'on', label: 'On · 开启思考' }] : [])]} onChange={value => update('thinking', value as AutomationDraft['thinking'])} /></div>
          <div className="automation-field"><span>单次最长运行时间</span><Select panelClassName="automation-select-panel" ariaLabel="自动化最长运行时间" value={draft.timeoutPreset} disabled={disabled} options={AUTOMATION_TIMEOUT_OPTIONS} onChange={value => setDraft(previous => ({ ...previous, timeoutPreset: value, timeoutChanged: true, customTimeout: value === 'custom' && previous.timeoutPreset !== 'custom' ? previous.timeoutPreset === 'unlimited' ? '0' : previous.timeoutPreset : previous.customTimeout }))} /></div></div>
        {draft.timeoutPreset === 'custom' ? <label className="automation-field"><span id={`${id}-timeout-label`}>自定义时长（秒）</span><input type="number" min={0} step={1} value={draft.customTimeout} disabled={disabled} aria-labelledby={`${id}-timeout-label`} aria-describedby={errors.timeout ? `${id}-timeout-error` : undefined} aria-invalid={Boolean(errors.timeout)} onChange={event => setDraft(previous => ({ ...previous, customTimeout: event.target.value, timeoutChanged: true }))} />{errors.timeout ? <small id={`${id}-timeout-error`} className="automation-field-error">{errors.timeout}</small> : null}</label> : null}
        <p className="automation-note">0 或“不限”表示没有单次时限。修改从下一次运行生效；暂停计划不会停止当前运行。</p>
        {capabilities ? <div className="automation-field"><span>工作工具</span><Select panelClassName="automation-select-panel" ariaLabel="自动化工具配置" value={draft.toolProfile} disabled={disabled} options={[{ value: 'general', label: 'Work · 办公与通用工具' }, { value: 'code', label: 'Code · 开发工具' }]} onChange={value => update('toolProfile', value as AutomationDraft['toolProfile'])} /></div> : null}
        <label className="automation-field"><span>说明（可选）</span><input value={draft.description} disabled={disabled} onChange={event => update('description', event.target.value)} /></label>
      </div></details>
      {attempted && errors.capabilities ? <p className="automation-field-error" role="alert">{errors.capabilities}</p> : null}
    </form>}
  </Dialog>
}
