import { useEffect, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { useModels } from '@renderer/core/engine/model-store'
import { changeSecurityMode, useSecurityMode } from '@renderer/core/engine/security-store'
import { MODE_DESCRIPTORS, type SecurityMode } from '@renderer/core/engine/security'
import { changeMemoryScope, useMemoryScope } from '@renderer/core/engine/memory-store'
import { MEMORY_SCOPE_DESCRIPTORS, type MemoryScope } from '@renderer/core/engine/memory'
import { Icon } from '@renderer/workbench/icons'
import { Popover } from '@renderer/workbench/Popover'

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
  { value: 'low', label: 'Low', summary: '几乎不思考，改小东西最快' },
  { value: 'high', label: 'High', summary: '默认，由引擎按模型能力决定' },
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
export function ComposerOptions({ sessionId }: { sessionId: string }): JSX.Element {
  const { ready, settings, updateSettings } = useApp()
  const { models } = useModels()
  const { mode: storedMode, loaded, loading, error, refresh } = useSecurityMode(sessionId)
  const {
    scope: storedMemoryScope,
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

  const currentModel = models.find((m) => m.modelId === settings.lastModelId)
  const thinkDescriptor =
    THINKING_OPTIONS.find((item) => item.value === settings.thinkingMode) ?? THINKING_OPTIONS[2]
  const secDescriptor = MODE_DESCRIPTORS.find((item) => item.value === mode)
  const thinkSummary =
    settings.thinkingMode === 'off'
      ? '下一次发送请求关闭推理；当前运行沿用原设置'
      : currentModel?.capabilities?.thinking
        ? thinkDescriptor.summary
        : '当前模型未声明支持推理；选 Max 会由引擎记录告警'
  const secSummary = loading
    ? '正在读取安全模式…'
    : error ?? (secDescriptor ? [secDescriptor.summary, secDescriptor.warning].filter(Boolean).join(' ') : '尚未确认引擎当前权限')
  const memoryDescriptor = MEMORY_SCOPE_DESCRIPTORS.find((item) => item.value === storedMemoryScope) ?? MEMORY_SCOPE_DESCRIPTORS[0]
  const memorySummary = memoryLoading
    ? '正在读取记忆设置…'
    : memoryError
      ? memoryError
      : memoryEnabled === false
        ? '引擎未启用长期记忆；切换时会提示错误'
        : memoryDescriptor.summary

  const pickThinking = (next: string): void => {
    if (!ready) return
    void updateSettings({ thinkingMode: next as 'off' | 'low' | 'high' | 'max' })
  }

  const pickSecurity = (next: string): void => {
    if (next === mode || loading || !ready || !sessionId) return
    void changeSecurityMode(sessionId, next as SecurityMode).catch(() => undefined)
  }

  const pickMemory = (next: string): void => {
    if (next === storedMemoryScope || memoryLoading || !ready || !sessionId) return
    void changeMemoryScope(sessionId, next as MemoryScope).catch(() => undefined)
  }

  return (
    <Popover
      className="composer-options"
      label="对话偏好"
      placement="up"
      align="start"
      width={360}
      flush
      trigger={({ open: isOpen }) => (
        <button
          type="button"
          className={`composer-options__trigger${isOpen ? ' is-open' : ''}`}
          disabled={!ready}
          title="对话偏好：长期记忆 / 思考档位 / 安全模式"
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
            <div className="composer-options__title">长期记忆</div>
            <div className="composer-options__summary">{memorySummary}</div>
          </div>
          <Popover
            className="composer-options__dd"
            label="长期记忆"
            placement="up"
            align="end"
            width={260}
            flush
            trigger={({ open: isOpen }) => (
              <button
                type="button"
                className={`composer-options__dd-btn${isOpen ? ' is-open' : ''}`}
                disabled={!ready || !sessionId || memoryLoading}
                title={!sessionId ? '先发一条消息建立会话，之后才能设置长期记忆' : '选择长期记忆范围'}
              >
                <span>{memoryLoading ? '读取中…' : memoryDescriptor.label}</span>
                <span className="composer-options__dd-caret">⌄</span>
              </button>
            )}
          >
            <div className="composer-options__dd-menu">
              {MEMORY_SCOPE_DESCRIPTORS.map((item) => (
                <MenuOption
                  key={item.value}
                  value={item.value}
                  current={storedMemoryScope ?? ''}
                  label={item.label}
                  summary={item.summary}
                  disabled={!ready || !sessionId || memoryLoading}
                  onSelect={pickMemory}
                />
              ))}
            </div>
          </Popover>
        </div>

        {memoryError ? (
          <div className="composer-options__error">
            {memoryError}
            <button type="button" onClick={() => void refreshMemory(sessionId)}>重新读取记忆设置</button>
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
                  current={settings.thinkingMode}
                  label={item.label}
                  summary={item.summary}
                  disabled={!ready}
                  onSelect={pickThinking}
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
                  onSelect={pickSecurity}
                />
              ))}
            </div>
          </Popover>
        </div>
      </div>
    </Popover>
  )
}
