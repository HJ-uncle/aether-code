import { useEffect, useRef, useState, type JSX } from 'react'
import { requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource, getExpectedEngine } from '@renderer/core/engine/source'
import type { PluginImport, PluginRecord } from '@renderer/core/engine/plugins'
import { Icon } from '@renderer/ui/icons'
import './plugin-archive-import.css'

type ImportRow = { key: number; fileName: string; job?: PluginImport; selected: boolean; error?: string }
type PreviewItem = { fileName: string; import?: PluginImport; error?: string }
const MAX_PLUGINS = 20
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const installable = (job?: PluginImport): boolean => Boolean(job?.manifest && (job.status === 'prepared' || (job.status === 'failed' && job.failureStage === 'install')))
const statusLabels: Record<string, string> = { preparing: '正在准备', prepared: '可导入', installing: '正在导入', installed: '已导入', failed: '失败', cancelled: '已取消', unknown: '待确认' }

function conflicts(rows: ImportRow[], plugins: PluginRecord[]): Map<number, string> {
  const existing = new Set(plugins.map(plugin => plugin.id)), seen = new Set<string>(), result = new Map<number, string>()
  for (const row of rows) {
    const id = row.job?.manifest?.id
    if (!id) continue
    if (row.job?.status === 'installed') { seen.add(id); continue }
    if (existing.has(id)) result.set(row.key, '已存在同名标识的插件，不会覆盖。')
    else if (seen.has(id)) result.set(row.key, '与本批另一插件的标识重复。')
    if (installable(row.job)) seen.add(id)
  }
  return result
}

function readArchive(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('读取压缩包失败，请重新选择文件。'))
    reader.onabort = () => reject(new Error('已取消读取压缩包。'))
    reader.readAsDataURL(file)
  })
}

/** ZIP previews are independent jobs: an invalid file never discards successful siblings. */
export function PluginArchiveImport({ format, plugins, onBusyChange, onInstalled, onDone }: {
  format: 'native' | 'remark'
  plugins: PluginRecord[]
  onBusyChange: (busy: boolean) => void
  onInstalled: (plugin: { id: string; name: string }) => void
  onDone: () => void
}): JSX.Element {
  const connection = useRef({ source: getEngineSource(), expectedEngine: getExpectedEngine() }).current
  const mounted = useRef(true), working = useRef(false), nextKey = useRef(0), input = useRef<HTMLInputElement>(null)
  const ownedJobs = useRef(new Set<string>()), installingJobs = useRef(new Set<string>())
  const [files, setFiles] = useState<File[]>([]), [rows, setRows] = useState<ImportRow[]>([])
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const current = (): boolean => mounted.current && connection.source === getEngineSource()
  const reportInstalled = (plugin: { id: string; name: string }): void => {
    if (connection.source === getEngineSource()) onInstalled(plugin)
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (connection.source === getEngineSource()) {
        onBusyChange(false)
        for (const jobId of ownedJobs.current) if (!installingJobs.current.has(jobId)) {
          void requestOrThrow({ method: 'DELETE', path: `/plugins/imports/${encodeURIComponent(jobId)}`, expectedEngine: connection.expectedEngine }).catch(() => { /* The engine retains a recoverable receipt if disconnected. */ })
        }
      }
    }
  }, [connection, onBusyChange])
  const blocked = conflicts(rows, plugins)
  const candidates = rows.filter(row => installable(row.job) && !blocked.has(row.key))
  const selected = candidates.filter(row => row.selected)
  const installed = rows.filter(row => row.job?.status === 'installed').length
  const failed = rows.filter(row => row.error || row.job?.status === 'failed' || row.job?.status === 'unknown').length
  const allSelected = candidates.length > 0 && selected.length === candidates.length
  const update = (key: number, patch: Partial<ImportRow>): void => { if (current()) setRows(previous => previous.map(row => row.key === key ? { ...row, ...patch } : row)) }
  const operate = async (action: () => Promise<void>): Promise<void> => {
    if (working.current || !current()) return
    working.current = true; setBusy(true); onBusyChange(true); setError('')
    try { await action() } catch (cause) { if (current()) setError(message(cause)) }
    finally { working.current = false; if (current()) { setBusy(false); onBusyChange(false) } }
  }
  const discardPreviews = async (): Promise<void> => {
    const failures: string[] = []
    for (const jobId of ownedJobs.current) {
      if (!current()) return
      const path = `/plugins/imports/${encodeURIComponent(jobId)}`
      try {
        await requestOrThrow({ method: 'DELETE', path, expectedEngine: connection.expectedEngine })
        ownedJobs.current.delete(jobId)
      } catch (cause) {
        if (!current()) return
        try {
          const { import: job } = await requestOrThrow<{ import: PluginImport }>({ method: 'GET', path, expectedEngine: connection.expectedEngine })
          if (connection.source !== getEngineSource()) return
          if (job.status !== 'installed' && job.status !== 'cancelled') throw cause
          ownedJobs.current.delete(jobId)
          if (job.status === 'installed' && job.manifest) reportInstalled({ id: job.manifest.id, name: job.manifest.name })
          if (!current()) return
        } catch (failure) { failures.push(message(failure)) }
      }
    }
    if (failures.length && current()) throw new Error(`还有 ${failures.length} 项预览未释放，请重试。${failures[0]}`)
  }
  const selectFiles = async (next: File[]): Promise<void> => {
    await discardPreviews()
    if (!current()) return
    setRows([]); setExpanded(new Set()); setProgress(''); setError(''); setFiles([])
    if (next.length > MAX_PLUGINS || next.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) {
      setError('一次最多选择 20 个 ZIP，总大小不能超过 50 MiB。')
      if (input.current) input.current.value = ''
      return
    }
    setFiles(next)
  }
  const preview = async (): Promise<void> => {
    await discardPreviews()
    if (!current()) return
    setRows([]); setExpanded(new Set())
    let count = 0
    for (let index = 0; index < files.length && current(); index++) {
      const file = files[index]
      setProgress(`正在读取 ${index + 1}/${files.length}：${file.name}`)
      try {
        if (count >= MAX_PLUGINS) throw new Error('本批最多预览 20 个插件，请分批导入。')
        if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('请选择 ZIP 文件。')
        if (file.size > 20 * 1024 * 1024) throw new Error('单个压缩包不能超过 20 MiB。')
        const base64 = await readArchive(file)
        if (!current()) return
        const response = await requestOrThrow<{ imports: PreviewItem[] }>({ method: 'POST', path: '/plugins/imports/preview-batch', expectedEngine: connection.expectedEngine,
          body: { type: 'zip', base64, format, maxPlugins: MAX_PLUGINS - count } })
        if (!current()) {
          // Navigation doesn't abort IPC. A late preview still owns staged
          // sources on the captured engine, even though its UI has gone away.
          for (const item of response.imports ?? []) {
            if (connection.source !== getEngineSource()) break
            if (item.import && item.import.status !== 'installed') await requestOrThrow({ method: 'DELETE', path: `/plugins/imports/${encodeURIComponent(item.import.jobId)}`, expectedEngine: connection.expectedEngine }).catch(() => {})
          }
          return
        }
        if (!Array.isArray(response?.imports) || !response.imports.length || response.imports.length > MAX_PLUGINS - count) throw new Error('批量预览结果无效，请更新引擎后重试。')
        count += response.imports.length
        for (const item of response.imports) if (item.import && item.import.status !== 'installed') ownedJobs.current.add(item.import.jobId)
        const added = response.imports.map(item => ({ key: nextKey.current++, fileName: response.imports.length === 1 ? file.name : `${file.name} / ${item.fileName}`,
          job: item.import, selected: installable(item.import), error: item.error ?? item.import?.error }))
        setRows(previous => [...previous, ...added])
      } catch (cause) {
        if (current()) setRows(previous => [...previous, { key: nextKey.current++, fileName: file.name, selected: false, error: message(cause) }])
      }
    }
    if (current()) setProgress('预览完成')
  }
  const refreshRow = async (row: ImportRow): Promise<PluginImport | undefined> => {
    if (!row.job || !current()) return
    const { import: job } = await requestOrThrow<{ import: PluginImport }>({ method: 'GET', path: `/plugins/imports/${encodeURIComponent(row.job.jobId)}`, expectedEngine: connection.expectedEngine })
    if (job.status === 'installed' && job.manifest) { ownedJobs.current.delete(job.jobId); reportInstalled({ id: job.manifest.id, name: job.manifest.name }) }
    if (!current()) return
    update(row.key, { job, error: job.error, selected: installable(job) })
    return job
  }
  const install = async (): Promise<void> => {
    let completed = 0, errors = 0
    for (const [index, row] of selected.entries()) {
      if (!current() || !row.job?.manifest) return
      setProgress(`正在导入 ${index + 1}/${selected.length}：${row.job.manifest.name}`)
      update(row.key, { job: { ...row.job, status: 'installing' }, error: undefined })
      installingJobs.current.add(row.job.jobId)
      try {
        const { plugin } = await requestOrThrow<{ plugin: PluginRecord }>({ method: 'POST', path: `/plugins/imports/${encodeURIComponent(row.job.jobId)}/install`, expectedEngine: connection.expectedEngine })
        ownedJobs.current.delete(row.job.jobId)
        reportInstalled(plugin)
        if (!current()) return
        update(row.key, { job: { ...row.job, status: 'installed', error: undefined }, selected: false, error: undefined })
        completed++
      } catch (cause) {
        if (!current()) {
          if (connection.source === getEngineSource()) await requestOrThrow({ method: 'DELETE', path: `/plugins/imports/${encodeURIComponent(row.job.jobId)}`, expectedEngine: connection.expectedEngine }).catch(() => {})
          return
        }
        // A lost response can arrive after the engine committed. Reconcile the
        // durable receipt before offering retry so completed jobs aren't replayed.
        try {
          const job = await refreshRow(row)
          if (!current()) return
          if (job?.status === 'installed') { completed++; continue }
          update(row.key, { error: job?.error || message(cause) })
        } catch {
          update(row.key, { job: { ...row.job, status: 'unknown' }, selected: false, error: `${message(cause)} 导入结果待确认，请刷新此项。` })
        }
        errors++
      } finally {
        installingJobs.current.delete(row.job.jobId)
        if (!current() && connection.source === getEngineSource() && ownedJobs.current.has(row.job.jobId)) {
          await requestOrThrow({ method: 'DELETE', path: `/plugins/imports/${encodeURIComponent(row.job.jobId)}`, expectedEngine: connection.expectedEngine }).catch(() => {})
          ownedJobs.current.delete(row.job.jobId)
        }
      }
    }
    if (current()) {
      setProgress(`本次已导入 ${completed} 个${errors ? `，失败 ${errors} 个` : ''}`)
      if (rows.length === 1 && completed === 1) onDone()
    }
  }
  const retryOnly = selected.length > 0 && selected.every(row => row.job?.status === 'failed')
  return <div className="plugin-archive-import">
    <div className="plugin-archive-import__picker">
      <label className="btn" htmlFor="plugin-archive-files"><Icon name="archive" size={16} />选择 ZIP</label>
      <input ref={input} id="plugin-archive-files" className="plugin-archive-import__file" type="file" multiple accept=".zip,application/zip" aria-label="插件压缩包" disabled={busy} onChange={event => { const next = Array.from(event.target.files ?? []); void operate(() => selectFiles(next)) }} />
      <span title={files.map(file => file.name).join('\n')}>{files.length === 1 ? files[0].name : files.length ? `已选择 ${files.length} 个文件` : '可多选，也可选择插件总包'}</span>
      <button type="button" className="btn" disabled={busy || !files.length || installed > 0} onClick={() => { void operate(preview) }}>预览插件</button>
    </div>
    <p className="work-plugins__note">{format === 'native' ? '支持单插件 ZIP 或包含 plugins/*.zip 的总包，每批最多 20 个插件。' : '每个 ZIP 对应一个 remark 插件，每批最多 20 个。'}</p>
    {error ? <p className="work-plugins__feedback is-error" role="alert">{error}</p> : null}
    {progress ? <p className="plugin-archive-import__progress" role="status" aria-live="polite">{progress}</p> : null}
    {rows.length > 0 ? <>
      <div className="plugin-archive-import__list-heading"><label><input type="checkbox" aria-label="全选可导入插件" disabled={busy || !candidates.length} checked={allSelected} ref={node => { if (node) node.indeterminate = selected.length > 0 && !allSelected }} onChange={event => { const checked = event.target.checked; setRows(previous => previous.map(row => ({ ...row, selected: !blocked.has(row.key) && installable(row.job) && checked }))) }} />全选</label><span>{selected.length} 个已选{installed ? ` · ${installed} 个已导入` : ''}{failed ? ` · ${failed} 个需处理` : ''}</span></div>
      <ul className="plugin-archive-import__list" aria-label="待导入插件">
        {rows.map(row => {
          const job = row.job, conflict = blocked.get(row.key), name = job?.manifest?.name ?? row.fileName
          const detail = conflict || row.error || job?.error
          const canSelect = installable(job) && !conflict
          return <li key={row.key} data-plugin-id={job?.manifest?.id}>
            <div className="plugin-archive-import__row">
              <input type="checkbox" aria-label={`选择 ${name}`} disabled={busy || !canSelect} checked={Boolean(canSelect && row.selected)} onChange={event => update(row.key, { selected: event.target.checked })} />
              <Icon name="puzzle" size={16} />
              <h3 title={name}>{name}</h3><span className="plugin-archive-import__version">{job?.manifest?.version}</span>
              <span className={`work-plugins__status work-plugins__status--${conflict ? 'conflict' : row.error ? 'failed' : job?.status ?? 'failed'}`}>{conflict ? '已跳过' : job ? statusLabels[job.status] ?? '待确认' : '无法读取'}</span>
              {job?.manifest ? <button type="button" className="btn btn--ghost btn--icon" aria-label={`查看 ${name} 详情`} aria-expanded={expanded.has(row.key)} aria-controls={`plugin-import-detail-${row.key}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next })}><Icon name={expanded.has(row.key) ? 'chevron-down' : 'chevron-right'} size={14} /></button> : null}
              {job && job.status !== 'installed' ? <button type="button" className="btn btn--ghost btn--icon" aria-label={`刷新 ${name} 导入状态`} title="刷新导入状态" disabled={busy} onClick={() => { void operate(async () => { await refreshRow(row) }) }}><Icon name="refresh" size={14} /></button> : null}
            </div>
            {detail ? <p className={`plugin-archive-import__detail${conflict ? '' : ' is-error'}`}>{detail}</p> : null}
            {job?.manifest && expanded.has(row.key) ? <div id={`plugin-import-detail-${row.key}`} className="plugin-archive-import__expanded"><p>{job.manifest.description}</p><p>标识：{job.manifest.id} · 工具：{job.manifest.tools.map(tool => tool.name).join('、')}</p><p>{row.fileName}</p>{job.requirements ? <pre>{JSON.stringify(job.requirements, null, 2)}</pre> : null}</div> : null}
          </li>
        })}
      </ul>
      <footer className="plugin-archive-import__footer"><span>导入为草稿，发布后即可使用。</span><div>{installed > 0 ? <button type="button" className="btn" disabled={busy} onClick={onDone}>完成</button> : null}<button type="button" className="btn btn--primary" disabled={busy || !selected.length} onClick={() => { void operate(install) }}>{busy ? '处理中…' : rows.length === 1 ? '安装插件' : `${retryOnly ? '重试导入' : '导入所选'}（${selected.length}）`}</button></div></footer>
    </> : null}
  </div>
}
