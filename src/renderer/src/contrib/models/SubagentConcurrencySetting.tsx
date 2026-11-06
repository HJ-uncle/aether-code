import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useApp } from '@renderer/core/app-context'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { Select } from '@renderer/workbench/Select'
import { SettingsContent, SettingsGroup, SettingsRow } from '../settings/SettingsGroup'

interface ConcurrencySettings {
  SUBAGENT_CONCURRENCY_LIMIT?: number
  managedKeys?: string[]
  subagentConcurrency?: { defaultLimit: number; min: number; max: number; effectiveLimit: number; scope: string; hotReload: boolean }
}
const SETTING = 'SUBAGENT_CONCURRENCY_LIMIT'

export function SubagentConcurrencySetting(): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <ConcurrencySetting key={source} source={source} />
}

function ConcurrencySetting({ source }: { source: number }): JSX.Element {
  const { ready, engine } = useApp()
  const [settings, setSettings] = useState<ConcurrencySettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const mounted = useRef(true)
  const busy = useRef(false)
  const current = (): boolean => mounted.current && source === getEngineSource()
  const capability = settings?.subagentConcurrency
  const supported = Boolean(capability?.hotReload && capability.scope === 'parent-session'
    && Number.isInteger(capability.min) && Number.isInteger(capability.max) && capability.min >= 1 && capability.max <= 16
    && capability.min <= capability.max && Number.isInteger(capability.effectiveLimit)
    && capability.effectiveLimit >= capability.min && capability.effectiveLimit <= capability.max)
  const managed = settings?.managedKeys?.includes(SETTING)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const expectedEngine = getExpectedEngine()
    setLoading(true); setError(''); setNotice('')
    void requestOrThrow<ConcurrencySettings>({ method: 'GET', path: '/settings', expectedEngine }).then(value => {
      if (!cancelled && current()) setSettings(value)
    }).catch(reason => {
      if (!cancelled && current()) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (!cancelled && current()) setLoading(false) })
    return () => { cancelled = true }
  }, [source, ready, revision])

  const change = async (value: string): Promise<void> => {
    const limit = Number(value)
    if (!current() || !ready || busy.current || loading || !supported || !capability || managed
      || !Number.isInteger(limit) || limit < capability.min || limit > capability.max) return
    const expectedEngine = getExpectedEngine()
    busy.current = true; setLoading(true); setError(''); setNotice('')
    try {
      await requestOrThrow({ method: 'PUT', path: '/settings', expectedEngine, body: { [SETTING]: limit } })
      if (!current()) return
      // Confirm the runtime's effective value rather than showing a successful
      // save when a server policy ignored or overrode the requested limit.
      const value = await requestOrThrow<ConcurrencySettings>({ method: 'GET', path: '/settings', expectedEngine })
      if (!current()) return
      setSettings(value)
      if (value.subagentConcurrency?.effectiveLimit !== limit) throw new Error('引擎尚未应用此数量，请刷新后重试。')
      setNotice(`已生效 · 每个主会话最多同时运行 ${limit} 个子代理`)
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busy.current = false
      if (current()) setLoading(false)
    }
  }

  const description = !ready ? '引擎就绪后可调整。'
    : loading && !settings ? '正在读取当前引擎设置…'
      : settings && !supported ? '当前引擎尚不支持调整，请先更新引擎。'
        : managed ? '此数量由引擎管理员统一管理。'
          : '每个主会话同时执行的数量，超出后依次排队。默认 5 个。'
  return <SettingsGroup title="子代理执行" footer={supported ? `${engine.snapshot.mode === 'remote' ? '适用于当前远程引擎' : '适用于当前引擎'}，Code 与 Work 共用。调整立即生效；降低数量不会中断正在执行的任务。` : undefined}>
    <SettingsRow label="子代理并发数量" description={description}>
      <Select title="子代理并发数量" className="sg__select-field" width={160}
        disabled={!ready || loading || !supported || managed} value={supported ? String(capability!.effectiveLimit) : ''}
        onChange={value => void change(value)}
        options={supported ? Array.from({ length: capability!.max - capability!.min + 1 }, (_, index) => {
          const count = capability!.min + index
          return { value: String(count), label: `${count} 个${count === capability!.defaultLimit ? '（默认）' : ''}` }
        }) : [{ value: '', label: loading ? '读取中…' : '暂不可用' }]} />
    </SettingsRow>
    {error ? <SettingsContent><p className="notice notice--error" role="alert">{error}</p><button type="button" className="btn btn--sm" disabled={!ready || loading} onClick={() => setRevision(value => value + 1)}>重新读取并发设置</button></SettingsContent> : null}
    {notice ? <SettingsContent><p className="sg__note" role="status">{notice}</p></SettingsContent> : null}
  </SettingsGroup>
}
