import { useCallback, useEffect, useState, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import {
  ACTION_LABELS,
  MODE_DESCRIPTORS,
  deletePolicy,
  isRiskyMode,
  listPolicies,
  resetPolicies,
  updatePolicy,
  type PolicyAction,
  type PolicyRule,
  type SecurityMode
} from '@renderer/core/engine/security'
import { changeSecurityMode, useSecurityMode } from '@renderer/core/engine/security-store'
import { Icon } from '@renderer/workbench/icons'
import { Select } from '@renderer/workbench/Select'
import { SettingsContent, SettingsGroup, SettingsRow, Toggle } from '../settings/SettingsGroup'

/**
 * 安全视图
 *
 * 存在的理由：Agent 反复被安全策略打断（每次都要在对话里点一次「允许执行」），
 * 而在此之前用户没有任何地方能看到「为什么被拦」、也没地方主动放宽。
 * 这个页面提供两个层级的控制：
 *
 *   - 会话安全模式：马上止血。切到 standard / full-access 后本会话不再弹确认。
 *   - 策略规则表：精确调整。比如只想让某类命令别问，就改它对应的规则。
 *
 * 注意模式是**会话级**的（引擎按 tenant+sessionId 存在内存里），
 * 所以这里必须用当前对话的 sessionId；换会话要重新设置。
 * 模式状态来自 security-store —— 与对话底部的快捷选择器共用一份，
 * 两处互相切换不会出现一处显示旧模式的假象。
 */
export function SecurityView(): JSX.Element {
  const { ready, settings } = useApp()
  const sessionId = settings.lastSessionId
  const { mode, error: modeError, refresh: refreshMode } = useSecurityMode()

  const [rules, setRules] = useState<PolicyRule[]>([])
  const [rulesLoading, setRulesLoading] = useState(false)
  const [rulesError, setRulesError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const loadRules = useCallback(async (): Promise<void> => {
    setRulesLoading(true)
    setRulesError(null)
    try {
      setRules(await listPolicies())
    } catch (err) {
      setRulesError(err instanceof Error ? err.message : String(err))
    } finally {
      setRulesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    // 微任务触发拉取：避免 effect 同步 setState 造成级联渲染
    queueMicrotask(() => {
      void refreshMode(sessionId)
      void loadRules()
    })
  }, [ready, sessionId, refreshMode, loadRules])

  const changeMode = async (next: SecurityMode): Promise<void> => {
    if (!sessionId || next === mode) return
    try {
      await changeSecurityMode(sessionId, next)
    } catch {
      // 失败信息由 store 持有（error），这里不再重复提示
    }
  }

  const guardRule = async (id: number, action: () => Promise<void>): Promise<void> => {
    setBusyId(id)
    setRulesError(null)
    try {
      await action()
    } catch (err) {
      setRulesError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const patchRule = async (rule: PolicyRule, patch: Partial<PolicyRule>): Promise<void> => {
    const id = rule.id
    if (id === undefined) return
    // 乐观更新，让开关/下拉立刻响应；写失败时再以服务端为准重新拉取
    setRules((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
    setBusyId(id)
    setRulesError(null)
    try {
      await updatePolicy(id, patch)
    } catch (err) {
      setRulesError(err instanceof Error ? err.message : String(err))
      await loadRules()
    } finally {
      setBusyId(null)
    }
  }

  const activeDescriptor = MODE_DESCRIPTORS.find((item) => item.value === mode)

  return (
    <div className="settings-view">
      {!ready ? <div className="notice">引擎未就绪，无法读写安全策略。</div> : null}

      {/* ── 会话安全模式 ── */}
      <SettingsGroup
        title="本会话安全模式"
        footer={
          sessionId
            ? `当前会话 ${sessionId.slice(0, 8)}。模式是会话级的，且引擎重启后失效。`
            : '尚未建立会话：先在对话视图发一条消息，这里才能设置模式。'
        }
      >
        {MODE_DESCRIPTORS.map((descriptor) => (
          <SettingsRow
            key={descriptor.value}
            label={descriptor.label}
            description={descriptor.summary}
            onClick={() => void changeMode(descriptor.value)}
          >
            <span
              className={`sg-radio${mode === descriptor.value ? ' is-on' : ''}${
                isRiskyMode(descriptor.value) && mode === descriptor.value ? ' sg-radio--risky' : ''
              }`}
              role="radio"
              aria-checked={mode === descriptor.value}
            />
          </SettingsRow>
        ))}
        {activeDescriptor?.warning || modeError ? (
          <SettingsContent>
            {activeDescriptor?.warning ? (
              <div className="notice notice--warn">{activeDescriptor.warning}</div>
            ) : null}
            {modeError ? <div className="notice notice--error">{modeError}</div> : null}
          </SettingsContent>
        ) : null}
      </SettingsGroup>

      {/* ── 策略规则 ── */}
      <SettingsGroup
        title="策略规则"
        footer="按 priority 从小到大匹配，命中第一条生效；* 匹配所有命令。各模式下「询问」会被改写：safe 保持询问，standard 自动放行，full-access 全部放行。"
      >
        {rulesError ? (
          <SettingsContent>
            <div className="notice notice--error">{rulesError}</div>
          </SettingsContent>
        ) : null}

        {rulesLoading && rules.length === 0 ? (
          <div className="sg__empty">加载中…</div>
        ) : rules.length === 0 && ready ? (
          <div className="sg__empty">没有读取到策略规则。</div>
        ) : (
          rules.map((rule) => (
            <SettingsRow
              key={rule.id ?? `${rule.name}-${rule.command}`}
              label={
                <>
                  {rule.name}
                  <span className="policy-row__command" title="匹配的命令">
                    {rule.command}
                    {rule.argPattern ? ` /${rule.argPattern}/` : ''}
                  </span>
                  <span className="chip chip--static" title="优先级，越小越先匹配">
                    p{rule.priority}
                  </span>
                </>
              }
              description={rule.description || undefined}
            >
              <Select
                className="sg__select-field"
                value={rule.action}
                disabled={rule.id === undefined || busyId === rule.id}
                title="命中该规则时的动作"
                width={180}
                options={(Object.keys(ACTION_LABELS) as PolicyAction[]).map((action) => ({
                  value: action,
                  label: ACTION_LABELS[action]
                }))}
                onChange={(next) => void patchRule(rule, { action: next as PolicyAction })}
              />
              <Toggle
                checked={rule.enabled}
                disabled={rule.id === undefined || busyId === rule.id}
                label={rule.enabled ? '已启用' : '已停用'}
                onChange={(checked) => void patchRule(rule, { enabled: checked })}
              />
              <button
                type="button"
                className="exclude-row__remove"
                disabled={rule.id === undefined || busyId === rule.id}
                title="删除该规则"
                aria-label={`删除规则 ${rule.name}`}
                onClick={() => {
                  const id = rule.id
                  if (id === undefined) return
                  if (!window.confirm(`确定删除规则「${rule.name}」吗？`)) return
                  void guardRule(id, async () => {
                    await deletePolicy(id)
                    setRules((prev) => prev.filter((item) => item.id !== id))
                  })
                }}
              >
                ×
              </button>
            </SettingsRow>
          ))
        )}
      </SettingsGroup>

      <div className="settings-view__actions">
        <button
          type="button"
          className="btn"
          disabled={!ready || rulesLoading}
          onClick={() => void loadRules()}
        >
          刷新
        </button>
        <button
          type="button"
          className="btn btn--danger-ghost"
          disabled={!ready || rulesLoading}
          title="清空现有规则并重新写入引擎内置规则，你对规则的改动会丢失"
          onClick={() => {
            if (!window.confirm('确定恢复默认策略规则吗？现有规则的改动会全部丢失。')) return
            void (async () => {
              try {
                await resetPolicies()
                await loadRules()
              } catch (err) {
                setRulesError(err instanceof Error ? err.message : String(err))
              }
            })()
          }}
        >
          <Icon name="restart" size={12} />
          恢复默认
        </button>
      </div>

      <SettingsGroup title="还想少被打断？">
        <SettingsContent>
          <p className="sg__note">
            在对话里被拦截时，授权卡片上可以直接把本会话切走并放行当前这一步，不必回到这个页面。
            审批过的命令同时会进入会话白名单，同参数不再重复询问。
          </p>
        </SettingsContent>
      </SettingsGroup>
    </div>
  )
}
