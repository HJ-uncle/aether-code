import { useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useModels } from '@renderer/core/engine/model-store'
import { changeSecurityMode, useSecurityMode } from '@renderer/core/engine/security-store'
import { MODE_DESCRIPTORS, type SecurityMode } from '@renderer/core/engine/security'
import { changeSessionMemoryEnabled, useMemoryScope } from '@renderer/core/engine/memory-store'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'
import { Select } from '@renderer/workbench/Select'
import { useAppMode } from '@renderer/core/platform/app-mode'
import type { SessionThinkingMode } from './session-thinking-store'
import type { ComposerThinkingMode } from './session-request-config'

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

/** 菜单里的一个选项行：名称 + 说明 + 选中勾 */
function MenuOption({
  value,
  current,
  label,
  summary,
  disabled = false,
  onSelect
}: {
  value: string
  current: string
  label: string
  summary: string
  disabled?: boolean
  onSelect: (value: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={`composer-options__dd-item${value === current ? ' is-active' : ''}`}
      disabled={disabled}
      onClick={() => onSelect(value)}
    >
      <span className="composer-options__dd-text">
        <span className="composer-options__dd-label">{label}</span>
        <span className="composer-options__dd-hint">{summary}</span>
      </span>
      {value === current ? <Icon name="check" size={16} /> : null}
    </button>
  )
}

/**
 * 输入框左下角的「偏好收纳」入口（参考 Trae / wuzu-client 的行式弹层）
 *
 * 思考档位 / 安全模式都是低频设置，收进一个图标按钮后面的弹层里，
 * 两行同款 UI：图标 + 名称 + 摘要 + 右侧「值 + 弹出菜单」。
 * 弹层与菜单统一走 Popover（portal 挂 body、防裁切、防出界）。
 */
export function ComposerOptions({ sessionId, modelId, thinkingMode, onThinkingChange, owner = 'code' }: { sessionId: string; modelId: string; thinkingMode: ComposerThinkingMode; onThinkingChange: (mode: SessionThinkingMode) => void; owner?: 'code' | 'work' }): JSX.Element {
  const { ready } = useApp()
  const appMode = useAppMode()
  const { models } = useModels()
  const [openMenu, setOpenMenu] = useState<'memory' | 'thinking' | 'security' | null>(null)
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
  const active = appMode === owner
  const mode = ready && active ? storedMode : null

  // 引擎重启会把安全模式 store 清空：会话就绪后补拉一次（Popover 内部管理开关状态，
  // 这里拿不到 open，改为就绪即拉，代价很小）
  useEffect(() => {
    if (active && ready && sessionId && !loaded && !loading && !error) void refresh(sessionId)
  }, [active, ready, sessionId, loaded, loading, error, refresh])

  // Memory scope is persisted by the engine (tenant + session), so refresh it
  // after a connection/session switch instead of copying it to localStorage.
  useEffect(() => {
    if (active && ready && sessionId && !memoryLoaded && !memoryLoading && !memoryError) void refreshMemory(sessionId)
  }, [active, ready, sessionId, memoryLoaded, memoryLoading, memoryError, refreshMemory])

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
    : error ?? (secDescriptor ? [secDescriptor.summary, secDescriptor.warning].filter(Boolean).join(' ') : '尚未确认引擎当前权限')
  const memoryChoice = !memoryLoaded ? '' : memoryOverride === null ? 'default' : memoryOverride ? 'on' : 'off'
  const memoryLabel = !ready ? '引擎未连接' : memoryLoading ? '同步中…' : memoryEnabled === false ? '服务端已关闭'
    : !memoryLoaded ? '尚未确认' : memoryOverride === null ? `跟随默认 · ${sessionEnabled ? '开启' : '关闭'}`
      : `本会话${sessionEnabled ? '开启' : '关闭'}`
  const memoryOptions = [
    { value: 'on', label: '本会话开启', summary: '单独开启当前会话的记忆，覆盖设置中的默认值。' },
    { value: 'off', label: '本会话关闭', summary: '单独关闭当前会话的记忆，聊天历史仍会保留。' },
    { value: 'default', label: '恢复默认', summary: `取消本会话的单独设置，跟随默认${sessionDefaultEnabled ? '开启' : '关闭'}。` }
  ]
  const memorySummary = memoryLoading
    ? '正在同步本会话记忆设置…'
    : memoryError
      ? memoryEnabled === false ? '服务端已关闭长期记忆。聊天历史会继续保留。' : '记忆设置未能同步，请重新读取后再试。'
      : memoryEnabled === false
        ? '服务端已关闭长期记忆。聊天历史会继续保留。'
        : !memoryLoaded ? '尚未确认本会话的记忆设置。'
          : memoryOverride === null ? `跟随设置中的默认值，当前${sessionEnabled ? '开启' : '关闭'}。聊天历史会继续保留。`
            : `已为本会话单独${sessionEnabled ? '开启' : '关闭'}记忆，可随时恢复默认。聊天历史会继续保留。`

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
    if (next === memoryChoice || memoryLoading || !memoryLoaded || !ready || !active || !sessionId) return
    if (next !== 'on' && next !== 'off' && next !== 'default') return
    if (next === 'on' && memoryEnabled === false) return
    void changeSessionMemoryEnabled(sessionId, next === 'default' ? null : next === 'on').catch(() => undefined)
  }

  return (
    <>
    <Select
      className="composer-access-picker"
      ariaLabel={`切换本会话访问权限：${secDescriptor?.label ?? '尚未确认'}`}
      title={secSummary}
      triggerLabel={loading ? '读取权限…' : secDescriptor?.label ?? '访问权限'}
      value={mode ?? ''}
      options={MODE_DESCRIPTORS.map(item => ({ value: item.value, label: item.label,
        description: [item.summary, item.warning].filter(Boolean).join(' ') }))}
      onChange={pickSecurity}
      disabled={!ready || !active || loading || !sessionId}
      placement="up"
      width={340}
      hint={error ?? undefined}
      actions={error ? [{ id: 'retry-security', label: '重新读取访问权限', icon: 'restart',
        onSelect: () => { void refresh(sessionId).catch(() => undefined) } }] : []}
    />
    <Popover
      className="composer-options"
      label="对话偏好"
      placement="up"
      align="start"
      width={360}
      flush
      onOpenChange={(open) => { if (!open) setOpenMenu(null) }}
      trigger={({ open: isOpen }) => (
        <button
          type="button"
          className={`composer-options__trigger${isOpen ? ' is-open' : ''}`}
          disabled={!ready}
          title="对话偏好：本会话记忆 / 思考档位 / 安全模式"
          aria-label="对话偏好"
        >
          <Icon name="settings" size={16} />
        </button>
      )}
    >
      <div className="composer-options__popup">
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
            width={260}
            flush
            open={openMenu === 'memory'}
            onOpenChange={(open) => setOpenMenu(open ? 'memory' : null)}
            trigger={({ open: isOpen }) => (
              <button
                type="button"
                className={`composer-options__dd-btn${isOpen ? ' is-open' : ''}`}
                disabled={!ready || !active || !sessionId || memoryLoading || !memoryLoaded}
                title={!sessionId ? '建立会话后可设置本会话记忆' : memoryEnabled === false ? '服务端已关闭长期记忆，仍可关闭本会话记忆或恢复默认' : '选择本会话记忆，或恢复默认'}
                aria-label={`本会话记忆：${memoryLabel}`}
              >
                <span>{memoryLabel}</span>
                <span className="composer-options__dd-caret">⌄</span>
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
                  disabled={!ready || !active || !sessionId || memoryLoading || !memoryLoaded || (item.value === 'on' && memoryEnabled === false)}
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
            width={240}
            flush
            open={openMenu === 'thinking'}
            onOpenChange={(open) => setOpenMenu(open ? 'thinking' : null)}
            trigger={({ open: isOpen }) => (
              <button
                type="button"
                className={`composer-options__dd-btn${isOpen ? ' is-open' : ''}`}
                disabled={!ready}
                title="选择思考档位"
              >
                <span>{thinkDescriptor.label}</span>
                <span className="composer-options__dd-caret">⌄</span>
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
            width={240}
            flush
            open={openMenu === 'security'}
            onOpenChange={(open) => setOpenMenu(open ? 'security' : null)}
            trigger={({ open: isOpen }) => (
              <button
                type="button"
                className={`composer-options__dd-btn${isOpen ? ' is-open' : ''}`}
                disabled={!ready || !sessionId || loading}
                title={
                  !sessionId
                    ? '先发一条消息建立会话，之后才能设置安全模式'
                    : '选择安全模式'
                }
              >
                <span>{loading ? '读取中…' : (secDescriptor?.label ?? '状态未知')}</span>
                <span className="composer-options__dd-caret">⌄</span>
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
                  summary={[item.summary, item.warning].filter(Boolean).join(' ')}
                  disabled={!ready || !sessionId || loading}
                  onSelect={(next) => { pickSecurity(next); setOpenMenu(null) }}
                />
              ))}
            </div>
          </Popover>
        </div>
      </div>
    </Popover>
    </>
  )
}
