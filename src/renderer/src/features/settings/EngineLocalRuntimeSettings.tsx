import { useEffect, useState, type JSX } from 'react'
import type { EngineSnapshot } from '@shared/ipc'
import type { EngineImportProgress, EngineRuntimeCatalog } from '@shared/engine-import'
import { Select } from '@renderer/ui/Select'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { accountErrorMessage } from '../account/account-errors'
import { SettingsDisclosure, SettingsRow } from './SettingsGroup'

export function EngineLocalRuntimeSettings({ snapshot, embeddedApplied, locked, configChanged, busy, setBusy, onPendingChange }: {
  snapshot: EngineSnapshot; embeddedApplied: boolean; locked: boolean; configChanged: boolean; busy: boolean
  setBusy: (busy: boolean) => void; onPendingChange: (pending: boolean) => void
}): JSX.Element {
  const [catalog, setCatalog] = useState<EngineRuntimeCatalog | null>(null)
  const [selected, setSelected] = useState('')
  const [progress, setProgress] = useState<EngineImportProgress | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void window.aether.engine.getLocalRuntimes().then(result => {
      if (live) { setCatalog(result); setSelected(result.activeId ?? '') }
    }).catch(() => { if (live) setError('无法读取已安装版本，请重新打开高级设置。') })
    const off = window.aether.engine.onImportProgress(value => { if (live) setProgress(value) })
    return () => { live = false; off() }
  }, [])
  const runtime = catalog?.runtimes.find(item => item.id === selected)
  const active = catalog?.activeId ?? ''
  const pending = !!catalog && selected !== active
  const willRestart = embeddedApplied && snapshot.mode === 'embedded' && snapshot.phase === 'ready' && !snapshot.adopted
  const blocked = willRestart && configChanged
  const canImport = catalog?.canImport === true
  const usingSelected = !pending && willRestart && (runtime
    ? snapshot.runtimeSource === 'imported' && snapshot.buildId === runtime.buildId : snapshot.runtimeSource !== 'imported')
  useEffect(() => {
    onPendingChange(pending && !willRestart)
    return () => onPendingChange(false)
  }, [pending, willRestart, onPendingChange])
  const versionHint = pending ? blocked ? '请先应用连接设置，再切换正在运行的版本。'
    : willRestart ? '选用此版本将重启本机引擎。' : '请先选用这个版本，再启动本机引擎。'
    : usingSelected ? '此版本正在运行。' : willRestart ? '已选用。当前运行的版本见「连接详情」。'
    : '已选用，下次启动本机引擎时生效。'
  const change = async (action: 'import' | 'activate' | 'delete'): Promise<void> => {
    if (locked || busy || (action === 'import' && !canImport) || (action === 'activate' && (!pending || blocked))) return
    setBusy(true)
    setError('')
    try {
      if (action === 'activate' && willRestart && !(await confirmDialog({ title: '切换本机引擎并重启？', body: '正在运行的任务会中断。已有会话和模型配置会保留。', confirmText: '切换并重启' }))) return
      if (action === 'delete' && (!runtime || !(await confirmDialog({ title: '删除本地引擎包？', body: `将移除“${runtime.name} ${runtime.version}”，之后仍可重新导入。`, confirmText: '删除引擎包', danger: true })))) return
      setProgress(null)
      let nextSelection: string | undefined
      if (action === 'import') {
        const imported = await window.aether.engine.importLocalRuntime()
        if (!imported) return
        nextSelection = imported.id
      } else if (action === 'activate') await window.aether.engine.activateLocalRuntime(selected || null)
      else await window.aether.engine.deleteLocalRuntime(selected)
      const result = await window.aether.engine.getLocalRuntimes()
      setCatalog(result); setSelected(nextSelection ?? result.activeId ?? '')
    } catch (cause) {
      setError(accountErrorMessage(cause, '无法更新本机版本，请重试。'))
    } finally { setBusy(false) }
  }
  return <>
    {catalog && (canImport ? <SettingsRow label="本地引擎包" description="可导入配套的 .tgz 文件。导入不会改变当前连接。">
      <button className="btn" type="button" disabled={locked || busy} onClick={() => void change('import')}>导入引擎…</button>
    </SettingsRow> : <SettingsRow label="本机引擎安装" description="请使用适用于此电脑的完整 Aether 客户端，或在上方选择「连接其他引擎」。" />)}
    {progress && progress.phase !== 'idle' && progress.phase !== 'error' && <div className={`engine-runtime__progress is-${progress.phase}`} role="status">
      <span>{progress.phase === 'ready' ? '引擎包已导入。' : progress.message}</span>{progress.phase !== 'ready' && <small>{progress.files} 个文件</small>}
    </div>}
    {catalog && catalog.runtimes.length > 0 && <>
      <SettingsRow label="本机版本" description={versionHint}>
        <Select value={selected} options={[{ value: '', label: '默认引擎' }, ...catalog.runtimes.map(item => ({ value: item.id, label: item.name === item.fileName ? item.version : `${item.version} · ${item.name}` }))]}
          onChange={value => { setSelected(value); setProgress(null); setError('') }} disabled={locked || busy} ariaLabel="选择已导入的本地引擎" className="engine-runtime__select" width={260} />
      </SettingsRow>
      {runtime && <SettingsDisclosure title="版本信息"><dl className="kv engine-connection__kv">
        <dt>构建</dt><dd>{runtime.buildId}</dd><dt>文件</dt><dd>{runtime.fileName}</dd><dt>导入时间</dt><dd>{new Date(runtime.importedAt).toLocaleString()}</dd>
      </dl></SettingsDisclosure>}
      {pending && <div className="engine-runtime__actions">
        <button className="btn" type="button" disabled={locked || busy || blocked} onClick={() => void change('activate')}>{willRestart ? selected ? '使用此引擎并重启' : '恢复默认并重启' : selected ? '选用此版本' : '选用默认版本'}</button>
        {runtime && <button className="btn btn--danger-ghost" type="button" disabled={locked || busy} onClick={() => void change('delete')}>删除此版本</button>}
      </div>}
    </>}
    {error && <p className="engine-connection__error" role="alert">{error}</p>}
  </>
}
