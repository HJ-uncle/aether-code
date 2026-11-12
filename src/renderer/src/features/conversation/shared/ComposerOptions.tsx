import { useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useModels } from '@renderer/core/engine/model-store'
import { changeSecurityMode, useSecurityMode } from '@renderer/core/engine/security-store'
import { MODE_DESCRIPTORS, type SecurityMode } from '@renderer/core/engine/security'
import { changeSessionMemoryEnabled, useMemoryScope } from '@renderer/core/engine/memory-store'
import { Icon, type IconName } from '@renderer/ui/icons'
import { Popover } from '@renderer/ui/Popover'
import { Select } from '@renderer/ui/Select'
import type { SessionThinkingMode } from './session-thinking-store'
import type { ComposerThinkingMode } from './session-request-config'
import { ComposerCodegraphRow } from './ComposerCodegraphRow'
import './composer-options.css'

/**
 * 思考档位（对齐 wuzu-client 的 Low/High/Max，外加独立「关闭」档）。
 * 'off' 下发引擎 thinkingMode=false 强制关思考；'low' / 'max' 下发档位字符串
 * （强制开启并指定 effort）；'high' 不传该字段，由引擎按模型能力判断。
 */
const THINKING_OPTIONS: Array<{
  value: 'off' | 'low' | 'high' | 'max'
  label: string
  summary: string
}> = [
  { value: 'off', label: 'Off', summary: '请求关闭模型推理，下一次发送生效' },
  { value: 'low', label: 'Low', summary: '默认，使用较低的推理强度' },
  { value: 'high', label: 'High', summary: '由引擎按模型能力决定' },
  { value: 'max', label: 'Max', summary: '想到底，最慢最贵' }
]

const SECURITY_MENU: Record<SecurityMode, { icon: IconName; description: string }> = {
  safe: { icon: 'shield', description: '仅工作区内；拦截高危，询问未知命令。' },
  standard: { icon: 'terminal', description: '风险命令需确认；可读写工作区外文件。' },
  'full-access': { icon: 'lock-open', description: '命令免确认；可读写工作区外文件。' }
}

/** 菜单里的一个选项行：名称 + 说明 + 选中勾 */
function MenuOption({
  value,
  current,
  label,
  summary,
  icon,
  disabled = false,
  onSelect
}: {
  value: string
  current: string
  label: string
  summary: string
  icon?: IconName
  disabled?: boolean
  onSelect: (value: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={value === current ? 'true' : undefined}
      className={`composer-options__dd-item${value === current ? ' is-active' : ''}`}
      disabled={disabled}
      onClick={() => onSelect(value)}
    >
      {icon ? <Icon name={icon} size={16} className="composer-options__dd-icon" /> : null}
      <span className="composer-options__dd-text">
        <span className="composer-options__dd-label">{label}</span>
        <span className="composer-options__dd-hint">{summary}</span>
      </span>
      <span className="composer-options__dd-check" aria-hidden="true">{value === current ? <Icon name="check" size={16} /> : null}</span>
    </button>
  )
}

/** Keep session preferences together; model selection stays in the composer.
 * Nested choices share the overlay stack so Escape dismisses only the active layer. */
export function ComposerOptions({ sessionId, modelId, thinkingMode, onThinkingChange, workspacePath }: { sessionId: string; modelId: string; thinkingMode: ComposerThinkingMode; onThinkingChange: (mode: SessionThinkingMode) => void; workspacePath?: string }): JSX.Element {
  const { ready } = useApp()
  const { models } = useModels()
  const [openMenu, setOpenMenu] = useState<'memory' | 'thinking' | 'security' | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const { mode: storedMode, loaded, loading, error, refresh } = useSecurityMode(sessionId)
  const {
    sessionOverride: memoryOverride,
    sessionEnabled,
    sessionDefaultEnabled,
    enabled: memoryEnabled,
    loaded: memoryLoaded,
    loading: memoryLoading,
    error: memoryError,
    refresh: refreshMemory
  } = useMemoryScope(sessionId)
  const mode = ready ? storedMode : null

  // 引擎重启会把安全模式 store 清空：会话就绪后补拉一次（Popover 内部管理开关状态，
  // 这里拿不到 open，改为就绪即拉，代价很小）
  useEffect(() => {
    if (ready && sessionId && !loaded && !loading && !error) void refresh(sessionId)
  }, [ready, sessionId, loaded, loading, error, refresh])

  // Memory scope is persisted by the engine (tenant + session), so refresh it
  // after a connection/session switch instead of copying it to localStorage.
  useEffect(() => {
    if (ready && sessionId && !memoryLoaded && !memoryLoading && !memoryError) void refreshMemory(sessionId)
  }, [ready, sessionId, memoryLoaded, memoryLoading, memoryError, refreshMemory])

  const currentModel = models.find((m) => m.id === modelId || m.modelId === modelId)
  const thinkDescriptor =
    THINKING_OPTIONS.find((item) => item.value === thinkingMode) ??
    (thinkingMode === 'medium' ? { label: 'Medium', summary: '本会话已请求中等推理强度' } :
      thinkingMode === 'on' ? { label: 'On', summary: '本会话已明确请求开启推理' } : THINKING_OPTIONS[1])
  const secDescriptor = MODE_DESCRIPTORS.find((item) => item.value === mode)
  const thinkSummary =
    thinkingMode === 'off'
      ? '下一次发送请求关闭推理；当前运行沿用原设置'
      : currentModel?.capabilities?.thinking
        ? thinkDescriptor.summary
        : '当前模型未声明支持推理；选 Max 会由引擎记录告警'
  const secSummary = loading
    ? '正在读取安全模式…'
    : error ?? (mode ? SECURITY_MENU[mode].description : '尚未确认引擎当前权限')
  const memoryChoice = !memoryLoaded ? '' : memoryOverride === null ? 'default' : memoryOverride ? 'on' : 'off'
  const memoryLabel = !ready ? '引擎未连接' : memoryLoading ? '同步中…' : memoryEnabled === false ? '服务端已关闭'
    : !memoryLoaded ? '尚未确认' : memoryOverride === null ? `跟随默认 · ${sessionEnabled ? '开启' : '关闭'}`
      : `本会话${sessionEnabled ? '开启' : '关闭'}`
  const memoryOptions = [
    { value: 'on', label: '本会话开启', summary: '仅本会话开启，覆盖默认设置。' },
    { value: 'off', label: '本会话关闭', summary: '仅本会话关闭，保留聊天历史。' },
    { value: 'default', label: '恢复默认', summary: `跟随默认${sessionDefaultEnabled ? '开启' : '关闭'}，可在设置中修改。` }
  ]
  const memorySummary = memoryLoading
    ? '正在同步本会话记忆设置…'
    : memoryError
      ? memoryEnabled === false ? '服务端已关闭长期记忆。聊天历史会继续保留。' : '记忆设置未能同步，请重新读取后再试。'
      : memoryEnabled === false
        ? '服务端已关闭长期记忆。聊天历史会继续保留。'
        : !memoryLoaded ? '尚未确认本会话的记忆设置。'
          : memoryOverride === null ? '使用设置中的默认值。聊天历史会继续保留。'
            : '仅本会话生效，可随时恢复默认。聊天历史会继续保留。'

  const pickThinking = (next: string): void => {
    if (!ready) return
    if (next === 'off' || next === 'low' || next === 'high' || next === 'max') onThinkingChange(next)
  }

  const pickSecurity = (next: string): void => {
    if (next === mode || loading || !ready || !sessionId) return
    if (!MODE_DESCRIPTORS.some(item => item.value === next)) return
    void changeSecurityMode(sessionId, next as SecurityMode).catch(() => undefined)
  }

  const pickMemory = (next: string): void => {
    if (next === memoryChoice || memoryLoading || !memoryLoaded || !ready || !sessionId) return
    if (next !== 'on' && next !== 'off' && next !== 'default') return
    if (next === 'on' && memoryEnabled === false) return
    void changeSessionMemoryEnabled(sessionId, next === 'default' ? null : next === 'on').catch(() => undefined)
  }

  return (
    <>
    <Select
      className="composer-access-picker"
      panelClassName="composer-access-menu"
      ariaLabel={`切换本会话访问权限：${secDescriptor?.label ?? '尚未确认'}`}
      title={secSummary}
      triggerLabel={loading ? '读取权限…' : secDescriptor?.label ?? '访问权限'}
      value={mode ?? ''}
      options={MODE_DESCRIPTORS.map(item => ({ value: item.value, label: item.label, ...SECURITY_MENU[item.value] }))}
      onChange={pickSecurity}
      disabled={!ready || loading || !sessionId}
      placement="up"
      width={340}
      hint={error ?? undefined}
      actions={error ? [{ id: 'retry-security', label: '重新读取访问权限', icon: 'restart',
        onSelect: () => { void refresh(sessionId).catch(() => undefined) } }] : []}
    />
    <Popover
      className="composer-options"
      panelClassName="composer-options-panel"
      label="对话偏好"
      placement="up"
      align="start"
      width={360}
      flush
      open={optionsOpen}
      onOpenChange={(open) => { setOptionsOpen(open); if (!open) setOpenMenu(null) }}
      trigger={({ open: isOpen }) => (
        <button
          type="button"
          className={`composer-options__trigger${isOpen ? ' is-open' : ''}`}
          disabled={!ready}
          title={`对话偏好：${secDescriptor?.label ?? '访问权限尚未确认'} / 本会话记忆 / 思考档位`}
          aria-label="对话偏好"
          aria-expanded={isOpen}
          aria-haspopup="dialog"
        >
          <Icon name="settings" size={16} />
        </button>
      )}
    >
      <div className="composer-options__popup">
        <header className="composer-options__header">
          <h3>对话偏好</h3>
          <button type="button" className="composer-options__close" aria-label="关闭对话偏好" title="关闭"
            onClick={() => { setOptionsOpen(false); setOpenMenu(null) }}><Icon name="close" size={16} /></button>
        </header>
        <div className="composer-options__settings">
        <div className="composer-options__row">
          <Icon name="graph" size={16} />
          <div className="composer-options__text">
            <div className="composer-options__title">本会话记忆</div>
            <div className="composer-options__summary">
              {memorySummary}
              {memoryEnabled === false && !memoryError ? (
                <button type="button" disabled={memoryLoading} onClick={() => void refreshMemory(sessionId)}>重新读取记忆设置</button>
              ) : null}
            </div>
          </div>
          <Popover
            className="composer-options__dd"
            label="本会话记忆"
            placement="up"
            align="end"
            width={320}
            flush
            open={openMenu === 'memory'}
            onOpenChange={(open) => setOpenMenu(open ? 'memory' : null)}
            trigger={({ open: isOpen }) => (
              <button
                type="button"
                className={`composer-options__dd-btn${isOpen ? ' is-open' : ''}`}
                disabled={!ready || !sessionId || memoryLoading || !memoryLoaded}
                title={!sessionId ? '建立会话后可设置本会话记忆' : memoryEnabled === false ? '服务端已关闭长期记忆，仍可关闭本会话记忆或恢复默认' : '选择本会话记忆，或恢复默认'}
                aria-label={`本会话记忆：${memoryLabel}`}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
              >
                <span>{memoryLabel}</span>
                <Icon className="composer-options__dd-caret" name="chevron-down" size={16} />
              </button>
            )}
          >
            <div className="composer-options__dd-menu">
              {memoryOptions.map((item) => (
                <MenuOption
                  key={item.value}
                  value={item.value}
                  current={memoryChoice}
                  label={item.label}
                  summary={item.summary}
                  icon="graph"
                  disabled={!ready || !sessionId || memoryLoading || !memoryLoaded || (item.value === 'on' && memoryEnabled === false)}
                  onSelect={(next) => { pickMemory(next); setOpenMenu(null) }}
                />
              ))}
            </div>
          </Popover>
        </div>

        {memoryError ? (
          <div className="composer-options__error">
            记忆设置未能同步。
            <button type="button" onClick={() => void refreshMemory(sessionId)}>重新读取记忆设置</button>
            <details className="composer-options__diagnostics"><summary>查看诊断信息</summary><div>{memoryError}</div></details>
          </div>
        ) : null}

        <div className="composer-options__row">
          <Icon name="brain" size={16} />
          <div className="composer-options__text">
            <div className="composer-options__title">思考档位</div>
            <div className="composer-options__summary">{thinkSummary}</div>
          </div>
          <Popover
            className="composer-options__dd"
            label="思考档位"
            placement="up"
            align="end"
            width={320}
            flush
            open={openMenu === 'thinking'}
            onOpenChange={(open) => setOpenMenu(open ? 'thinking' : null)}
            trigger={({ open: isOpen }) => (
              <button
                type="button"
                className={`composer-options__dd-btn${isOpen ? ' is-open' : ''}`}
                disabled={!ready}
                title="选择思考档位"
                aria-label={`思考档位：${thinkDescriptor.label}`}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
              >
                <span>{thinkDescriptor.label}</span>
                <Icon className="composer-options__dd-caret" name="chevron-down" size={16} />
              </button>
            )}
          >
            <div className="composer-options__dd-menu">
              {THINKING_OPTIONS.map((item) => (
                <MenuOption
                  key={item.value}
                  value={item.value}
                  current={thinkingMode}
                  label={item.label}
                  summary={item.summary}
                  icon="brain"
                  disabled={!ready}
                  onSelect={(next) => { pickThinking(next); setOpenMenu(null) }}
                />
              ))}
            </div>
          </Popover>
        </div>

        <div className="composer-options__row">
          <Icon name="shield" size={16} />
          <div className="composer-options__text">
            <div className="composer-options__title">安全模式</div>
            <div className="composer-options__summary">
              {secSummary}
              {error ? <button type="button" onClick={() => void refresh(sessionId)}>重新读取安全模式</button> : null}
            </div>
          </div>
          <Popover
            className="composer-options__dd"
            label="安全模式"
            placement="up"
            align="end"
            width={320}
            flush
            open={openMenu === 'security'}
            onOpenChange={(open) => setOpenMenu(open ? 'security' : null)}
            trigger={({ open: isOpen }) => (
              <button
                type="button"
                className={`composer-options__dd-btn${isOpen ? ' is-open' : ''}`}
                disabled={!ready || !sessionId || loading}
                aria-label={`安全模式：${secDescriptor?.label ?? '尚未确认'}`}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                title={
                  !sessionId
                    ? '先发一条消息建立会话，之后才能设置安全模式'
                    : '选择安全模式'
                }
              >
                <span>{loading ? '读取中…' : (secDescriptor?.label ?? '状态未知')}</span>
                <Icon className="composer-options__dd-caret" name="chevron-down" size={16} />
              </button>
            )}
          >
            <div className="composer-options__dd-menu">
              {MODE_DESCRIPTORS.map((item) => (
                <MenuOption
                  key={item.value}
                  value={item.value}
                  current={mode ?? ''}
                  label={item.label}
                  summary={SECURITY_MENU[item.value].description}
                  icon={SECURITY_MENU[item.value].icon}
                  disabled={!ready || !sessionId || loading}
                  onSelect={(next) => { pickSecurity(next); setOpenMenu(null) }}
                />
              ))}
            </div>
          </Popover>
        </div>
        </div>
        <div className="composer-options__workspace">
          <ComposerCodegraphRow sessionId={sessionId} path={workspacePath} active={optionsOpen} />
        </div>
      </div>
    </Popover>
    </>
  )
}
