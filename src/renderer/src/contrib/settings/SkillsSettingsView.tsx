import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type DragEvent, type JSX } from 'react'
import { request, requestOrThrow } from '@renderer/core/engine/client'
import { subscribeResourceCatalogueChanges } from '@renderer/core/engine/resource-catalogue'
import { useApp } from '@renderer/core/app-context'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { assertEngineSource, getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Dialog } from '@renderer/workbench/Dialog'
import { Icon } from '@renderer/workbench/icons'
import { Spinner } from '@renderer/workbench/ui-primitives'
import { Select } from '@renderer/workbench/Select'
import { FileGlyph } from '@renderer/contrib/explorer/FileGlyph'
import { Toggle } from './SettingsGroup'
import { ResourceSettingsEmpty, ResourceSettingsField, ResourceSettingsHeader, ResourceSettingsMenu } from './ResourceSettings'
import type { EngineUploadInput } from '@shared/ipc'
import './skills-settings.css'
import './settings-pages.css'

type SkillScope = 'project' | 'global'
type ConflictStrategy = 'reject' | 'overwrite' | 'versioned'

interface SkillListItem {
  id?: string
  name: string
  description: string
  enabled: boolean
  order: number
  scope: SkillScope
}

interface SkillDetail extends SkillListItem {
  content: string
  dir: string
  files: { path: string; size: number }[]
}

function skillKey(skill: Pick<SkillListItem, 'id' | 'name'>): string {
  return skill.id || skill.name
}

/**
 * A name is not a stable identity when project and global layers contain a
 * skill with the same name. Keep scope in the client key so a refresh or an
 * edit never updates the wrong row.
 */
function skillIdentity(skill: Pick<SkillListItem, 'id' | 'name' | 'scope'>): string {
  return `${skill.scope}:${skill.id || skill.name}`
}

interface ImportRecord {
  importId: string
  filename: string
  status: string
  progress: number
  stage: string
  skillNames?: string[]
  errorCode?: string | null
  errorMessage?: string | null
  scope?: SkillScope
  projectRoot?: string
}

const MAX_FILE_SIZE = 20 * 1024 * 1024
const DIRECT_UPLOAD_LIMIT = 5 * 1024 * 1024
const CHUNK_SIZE = 2 * 1024 * 1024

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeList(value: unknown): SkillListItem[] {
  const raw = (value as { list?: unknown[] } | null)?.list
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is SkillListItem => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Partial<SkillListItem>
    // Built-in skills may ship without a description; they must stay visible.
    return typeof candidate.name === 'string'
  }).map((item) => ({
    id: typeof item.id === 'string' ? item.id : undefined,
    name: item.name,
    description: typeof item.description === 'string' ? item.description : '',
    enabled: item.enabled !== false,
    order: Number.isFinite(item.order) ? item.order : 0,
    scope: item.scope === 'global' ? 'global' : 'project'
  }))
}

function isSupportedFile(file: File): boolean {
  return /\.(?:zip|tar|tgz|tar\.gz|gz|md)$/i.test(file.name)
}

function importStatusLabel(record: ImportRecord): string {
  if (record.status === 'imported') return `已导入${record.skillNames?.length ? `：${record.skillNames.join('、')}` : ''}`
  if (record.status === 'failed') return record.errorMessage || '导入失败'
  if (record.status === 'cancelled') return '已取消'
  return `${record.stage || '处理中'}（${record.progress ?? 0}%）`
}

function importFinished(record: ImportRecord): boolean {
  return ['imported', 'failed', 'cancelled'].includes(record.status)
}

function ImportProgress({ record }: { record: ImportRecord }): JSX.Element {
  const progress = Math.max(0, Math.min(100, record.progress || 0))
  return <div className={`skills-import-progress is-${record.status}`}>
    <div className="skills-import-progress__heading"><strong title={record.filename}>{record.filename}</strong>
      {!importFinished(record) ? <span>{progress}%</span> : null}</div>
    {!importFinished(record) ? <progress max={100} value={progress} aria-label={`${record.filename} 导入进度`} /> : null}
    <p role="status">{importFinished(record) ? importStatusLabel(record) : record.stage || '处理中'}</p>
  </div>
}

/** Skill registry and importer. AppSettingsView can mount this as its own tab. */
export function SkillsSettingsView(): JSX.Element {
  const { engine, settings } = useApp()
  const workspace = useWorkspace()
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  const projectRoot = engine.snapshot.mode === 'remote' ? settings.remoteWorkspaceRoot.trim() : workspace.root
  return <SkillsSettingsContent key={JSON.stringify([source, projectRoot])} source={source} projectRoot={projectRoot} />
}

function SkillsSettingsContent({ source, projectRoot }: { source: number; projectRoot: string | null }): JSX.Element {
  const [scope, setScope] = useState<SkillScope>('project')
  const [strategy, setStrategy] = useState<ConflictStrategy>('versioned')
  const [skills, setSkills] = useState<SkillListItem[]>([])
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailTarget, setDetailTarget] = useState<SkillListItem | null>(null)
  const [detailError, setDetailError] = useState('')
  const [record, setRecord] = useState<ImportRecord | null>(null)
  const [history, setHistory] = useState<ImportRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [createOverwrite, setCreateOverwrite] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const createFormId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const activeUpload = useRef<Promise<unknown> | null>(null)
  const importStops = useRef(new Map<string, Promise<boolean>>())
  const detailRequest = useRef(0)
  const mounted = useRef(true)
  const isCurrent = useCallback(() => mounted.current && source === getEngineSource(), [source])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true); setLoadError('')
    try {
      const result = await request<{ list?: unknown }>({ method: 'GET', path: '/skills', query: { reload: 1, all: 1, path: projectRoot || undefined } })
      if (!isCurrent()) return
      if (!result.ok) throw new Error(result.message || `读取技能失败（${result.code}）`)
      setSkills(normalizeList(result.data))
    } catch (cause) {
      if (isCurrent()) setLoadError(errorMessage(cause))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [projectRoot, isCurrent])

  const refreshHistory = useCallback(async (expectedEngine?: ReturnType<typeof getExpectedEngine>): Promise<void> => {
    try {
      const result = await request<ImportRecord[]>({ method: 'GET', path: '/skills/imports', query: { limit: 20, scope, projectRoot: scope === 'global' ? undefined : projectRoot || undefined }, ...(expectedEngine ? { expectedEngine } : {}) })
      if (isCurrent() && result.ok && Array.isArray(result.data)) setHistory(result.data)
    } catch {
      // The list is secondary UI; active import errors remain visible above.
    }
  }, [projectRoot, scope, isCurrent])

  useEffect(() => { void refresh(); void refreshHistory() }, [refresh, refreshHistory])
  useEffect(() => subscribeResourceCatalogueChanges(['skill'], () => { void refresh(); void refreshHistory() }), [refresh, refreshHistory, source])

  // Import status and an opened detail belong to the selected layer. Clear
  // them when the target changes so a completed project import is never shown
  // as the result of a subsequent global operation.
  useEffect(() => {
    setRecord(null)
    setDetail(null)
    setDetailTarget(null)
    setDetailError('')
    detailRequest.current++
    setError('')
  }, [scope])

  const showDetail = async (skill: SkillListItem): Promise<void> => {
    const sequence = ++detailRequest.current
    setError('')
    setDetail(null); setDetailError(''); setDetailTarget(skill)
    try {
      const next = await requestOrThrow<SkillDetail>({ method: 'GET', path: `/skills/${encodeURIComponent(skillKey(skill))}`, query: { path: projectRoot || undefined, scope: skill.scope } })
      if (isCurrent() && sequence === detailRequest.current) setDetail(next)
    } catch (cause) {
      if (isCurrent() && sequence === detailRequest.current) setDetailError(errorMessage(cause))
    }
  }
  const closeDetail = (): void => { detailRequest.current++; setDetailTarget(null); setDetail(null); setDetailError('') }

  const setEnabled = async (skill: SkillListItem, enabled: boolean): Promise<void> => {
    setError('')
    try {
      await requestOrThrow({ method: 'PATCH', path: `/skills/${encodeURIComponent(skillKey(skill))}`, query: { path: projectRoot || undefined, scope: skill.scope }, body: { enabled } })
      if (!isCurrent()) return
      setSkills((current) => current.map((item) => skillIdentity(item) === skillIdentity(skill) ? { ...item, enabled } : item))
      if (detail && skillIdentity(detail) === skillIdentity(skill)) setDetail({ ...detail, enabled })
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause))
    }
  }

  const remove = async (skill: SkillListItem): Promise<void> => {
    const confirmed = await confirmDialog({
      title: '删除技能？',
      body: `将删除“${skill.name}”及其已保存的版本，之后需要重新导入才能使用。`,
      confirmText: '删除技能',
      danger: true
    })
    if (!confirmed || !isCurrent()) return
    setError('')
    try {
      await requestOrThrow({ method: 'DELETE', path: `/skills/${encodeURIComponent(skillKey(skill))}`, query: { path: projectRoot || undefined, scope: skill.scope } })
      if (!isCurrent()) return
      if (detailTarget && skillIdentity(detailTarget) === skillIdentity(skill)) closeDetail()
      await refresh()
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause))
    }
  }

  const waitForImport = async (importId: string, expectedEngine: ReturnType<typeof getExpectedEngine>, sourceEpoch: number): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await importStops.current.get(importId)) return
      assertEngineSource(sourceEpoch)
      const next = await requestOrThrow<ImportRecord>({ method: 'GET', path: `/skills/imports/${encodeURIComponent(importId)}`, expectedEngine })
      if (!isCurrent() || await importStops.current.get(importId)) return
      assertEngineSource(sourceEpoch)
      setRecord(next)
      setHistory((current) => [next, ...current.filter((item) => item.importId !== next.importId)])
      if (['imported', 'failed', 'cancelled'].includes(next.status)) {
        if (next.status === 'failed') throw new Error(next.errorMessage || '导入失败')
        return
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500))
    }
    throw new Error('导入状态等待超时，请稍后查看导入历史')
  }

  const importFile = async (file: File): Promise<void> => {
    if (busy || !isCurrent()) return
    const sourceEpoch = getEngineSource()
    const expectedEngine = getExpectedEngine()
    setBusy(true)
    setError('')
    setRecord({ importId: '', filename: file.name, status: 'uploading', progress: 0, stage: '正在上传' })
    let importId: string | undefined
    try {
      if (!isSupportedFile(file)) throw new Error('仅支持 ZIP、TAR、TGZ、GZ 或 SKILL.md 文件')
      if (file.size === 0) throw new Error('不能导入空文件')
      if (file.size > MAX_FILE_SIZE) throw new Error(`文件超过 20 MB 上限（当前 ${formatBytes(file.size)}），请使用分片上传`)
      const data = new Uint8Array(await file.arrayBuffer())
      if (!isCurrent()) return
      assertEngineSource(sourceEpoch)
      const digest = await crypto.subtle.digest('SHA-256', data)
      const fileSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const multipartUpload = async <T = unknown,>(input: Omit<EngineUploadInput, 'expectedEngine'>) => {
        if (!isCurrent()) throw new Error('技能管理页面已关闭，请重新上传')
        assertEngineSource(sourceEpoch)
        const upload = window.aether.engine.upload<T>({ ...input, expectedEngine })
        activeUpload.current = upload
        try { return await upload } finally { if (activeUpload.current === upload) activeUpload.current = null }
      }
      if (data.byteLength <= DIRECT_UPLOAD_LIMIT) {
        const result = await multipartUpload<{ importId?: string }>({
          path: '/skills/imports',
          fileName: file.name,
          type: file.type || 'application/octet-stream',
          data,
          fields: { filename: file.name, scope, conflictStrategy: strategy, fileSha256, ...(projectRoot && scope === 'project' ? { projectRoot } : {}) }
        })
        if (!isCurrent()) return
        if (!result.ok || !result.data?.importId) throw new Error(result.message || `上传失败（${result.code}）`)
        importId = result.data.importId
      } else {
        const totalChunks = Math.ceil(data.byteLength / CHUNK_SIZE)
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
          if (importId && await importStops.current.get(importId)) return
          const start = chunkIndex * CHUNK_SIZE
          const chunk = data.slice(start, Math.min(start + CHUNK_SIZE, data.byteLength))
          const result = await multipartUpload<{ importId?: string }>({
            path: '/skills/imports/chunks',
            fileName: `${file.name}.part-${chunkIndex + 1}`,
            type: 'application/octet-stream',
            data: chunk,
            fields: {
              filename: file.name,
              totalSize: String(data.byteLength),
              totalChunks: String(totalChunks),
              chunkIndex: String(chunkIndex),
              ...(importId ? { importId } : {}),
              scope,
              conflictStrategy: strategy,
              fileSha256,
              ...(projectRoot && scope === 'project' ? { projectRoot } : {})
            }
          })
          if (!isCurrent() || (importId && await importStops.current.get(importId))) return
          if (!result.ok || !result.data?.importId) throw new Error(result.message || `第 ${chunkIndex + 1} 个分片上传失败（${result.code}）`)
          importId = result.data.importId
          setRecord({ importId, filename: file.name, status: 'uploading', progress: Math.round(((chunkIndex + 1) / totalChunks) * 70), stage: `已上传分片 ${chunkIndex + 1}/${totalChunks}` })
        }
        if (!importId) throw new Error('分片上传未返回导入会话')
        assertEngineSource(sourceEpoch)
        await requestOrThrow({ method: 'POST', path: '/skills/imports/chunks/merge', body: { importId }, expectedEngine })
      }
      if (!importId) throw new Error('上传未返回导入会话')
      await waitForImport(importId, expectedEngine, sourceEpoch)
      if (!isCurrent()) return
      await refresh()
      await refreshHistory(expectedEngine)
    } catch (cause) {
      if (importId && await importStops.current.get(importId)) return
      if (!isCurrent()) return
      const message = errorMessage(cause)
      setError(message)
      setRecord((current) => current ? { ...current, status: 'failed', stage: '导入失败', errorMessage: message } : null)
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  const cancelImport = async (item: ImportRecord): Promise<void> => {
    if (!item.importId || importFinished(item) || cancelling || importStops.current.has(item.importId) || !isCurrent()) return
    setCancelling(item.importId)
    const expectedEngine = getExpectedEngine()
    const stop = (async (): Promise<boolean> => {
      try {
        // Finish the in-flight chunk before cancellation removes its storage.
        // The upload loop waits on this same result before sending another one.
        await activeUpload.current?.catch(() => undefined)
        if (!isCurrent()) return true
        const result = await requestOrThrow<{ status: string }>({ method: 'DELETE', path: `/skills/imports/${encodeURIComponent(item.importId)}`, expectedEngine })
        if (!isCurrent()) return true
        const status = result.status || 'cancelled'
        setRecord(current => current?.importId === item.importId ? { ...current, status, stage: status === 'cancelled' ? '已取消' : current.stage } : current)
        await refreshHistory(expectedEngine)
        if (status === 'imported') await refresh()
        return true
      } catch (cause) {
        if (isCurrent()) setError(errorMessage(cause))
        return false
      } finally {
        if (isCurrent()) setCancelling(null)
      }
    })()
    importStops.current.set(item.importId, stop)
    if (!await stop) importStops.current.delete(item.importId)
  }

  const createSkill = async (): Promise<void> => {
    // Keep the friendly form permissive while always producing a route-safe
    // directory name. Leading separators are trimmed because the API requires
    // a letter/number as the first character.
    const name = createName.trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '')
    const content = createContent.trim()
    if (!name) {
      setError('技能名称至少需要一个字母或数字')
      return
    }
    if (!content || createBusy || busy || !isCurrent()) return
    setCreateBusy(true)
    setError('')
    try {
      await requestOrThrow({
        method: 'POST',
        path: '/skills',
        body: {
          name,
          description: createDescription.trim() || name,
          content,
          scope,
          overwrite: createOverwrite,
          ...(projectRoot && scope === 'project' ? { projectRoot } : {})
        }
      })
      if (!isCurrent()) return
      setCreateName('')
      setCreateDescription('')
      setCreateContent('')
      setCreateOverwrite(false)
      setCreateOpen(false)
      await refresh()
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause))
    } finally {
      if (isCurrent()) setCreateBusy(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file && !busy) void importFile(file)
  }

  return (
    <div className="settings-view settings-view--skills resource-settings">
      <ResourceSettingsHeader title="已安装技能" count={skills.length}>
        <button type="button" className="resource-icon-button" disabled={busy || loading} aria-label="刷新技能" title="刷新技能" onClick={() => { void refresh(); void refreshHistory() }}>
          {loading ? <Spinner size={16} /> : <Icon name="refresh" size={16} />}
        </button>
        <button type="button" className="btn" disabled={createBusy} onClick={() => { setError(''); setImportOpen(true) }}><Icon name="package-up" size={15} />导入技能</button>
        <button type="button" className="btn btn--primary" disabled={busy || createBusy} onClick={() => { setError(''); setCreateOpen(true) }}><Icon name="plus" size={15} />创建技能</button>
      </ResourceSettingsHeader>

      {loadError ? <p className="resource-feedback is-error" role="alert">{loadError}</p> : null}
      <div className="resource-list skills-list" role="list" aria-label="已安装技能" aria-busy={loading}>
        {!skills.length ? <ResourceSettingsEmpty icon="package-variant-closed" loading={loading}
          title={loading ? '正在读取技能…' : loadError ? '技能暂未加载' : '暂无已安装技能'}
          description={loadError ? '请刷新重试。' : loading ? undefined : '导入技能文件，或直接创建一个技能。'} /> : skills.map(skill => (
          <div className={`resource-row skills-row${skill.enabled ? '' : ' is-disabled'}`} key={skillIdentity(skill)} role="listitem"
            data-skill-id={skillKey(skill)} data-skill-scope={skill.scope}>
            <button type="button" className="resource-row__main" aria-label={`查看技能：${skill.name}`} onClick={() => void showDetail(skill)}>
              <span className="resource-row__icon"><Icon name="package-variant-closed" size={18} /></span>
              <span className="resource-row__copy"><strong>{skill.name}</strong>
                {skill.description ? <span className="skills-row__description" title={skill.description}>{skill.description}</span> : null}
                <span className="resource-row__meta"><span>{skill.scope === 'global' ? '全局' : '项目'}</span><span>{skill.enabled ? '已启用' : '已停用'}</span></span>
              </span>
            </button>
            <div className="resource-row__actions">
              <Toggle checked={skill.enabled} onChange={enabled => void setEnabled(skill, enabled)} label={`${skill.name} 启用`} disabled={busy} />
              <ResourceSettingsMenu label={`技能 ${skill.name}`} disabled={busy} actions={[
                { label: '查看详情', icon: 'file', onSelect: () => void showDetail(skill) },
                { label: '删除技能', icon: 'trash', danger: true, onSelect: () => void remove(skill) }
              ]} />
            </div>
          </div>
        ))}
      </div>

      {record ? <button type="button" className="skills-import-summary" aria-label="查看导入进度" onClick={() => setImportOpen(true)}>
        {busy ? <Spinner size={15} /> : <Icon name={record.status === 'imported' ? 'check' : 'package-up'} size={16} />}
        <span><strong>{record.filename}</strong><span>{importStatusLabel(record)}</span></span><Icon name="chevron-right" size={14} />
      </button> : null}

      <details className="resource-disclosure skills-history">
        <summary>导入历史</summary>
        <div className="skills-history__toolbar"><span>保存层级</span><Select value={scope}
          options={[{ value: 'project', label: '项目层' }, { value: 'global', label: '全局层' }]}
          onChange={value => setScope(value as SkillScope)} disabled={busy || createBusy} ariaLabel="技能历史层级" width={150} /></div>
        {!history.length ? <p className="resource-description skills-history__empty">暂无导入记录</p> : <div role="list" aria-label="技能导入历史">
          {history.map(item => <div className="skills-history-row" key={item.importId} role="listitem">
            <Icon name={item.status === 'imported' ? 'check' : 'package-up'} size={16} />
            <div><strong title={item.filename}>{item.filename}</strong><span>{importStatusLabel(item)}</span></div>
            {!importFinished(item) ? <button type="button" className="btn btn--sm" disabled={cancelling !== null}
              aria-label={`取消导入 ${item.filename}`} onClick={() => void cancelImport(item)}>{cancelling === item.importId ? '取消中…' : '取消'}</button> : null}
          </div>)}
        </div>}
      </details>

      {error && !createOpen && !importOpen ? <p className="resource-feedback is-error" role="alert">{error}</p> : null}

      {createOpen ? <Dialog title="创建技能" width={640} className="resource-editor skills-create-dialog" closeDisabled={createBusy}
        onClose={() => setCreateOpen(false)} footer={<>
          <button type="button" className="btn" disabled={createBusy} onClick={() => setCreateOpen(false)}>取消</button>
          <button type="submit" form={createFormId} className="btn btn--primary" disabled={!createName.trim() || !createContent.trim() || createBusy || busy}>{createBusy ? '创建中…' : '创建技能'}</button>
        </>}>
        <form id={createFormId} className="resource-form skills-create-form" onSubmit={event => { event.preventDefault(); void createSkill() }}
          onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit() } }}>
          <ResourceSettingsField label="名称"><input className="field__input" value={createName} disabled={createBusy || busy} onChange={event => setCreateName(event.target.value)} placeholder="例如 release-notes" aria-label="新技能名称" autoFocus /></ResourceSettingsField>
          <ResourceSettingsField label="保存层级"><Select value={scope} options={[{ value: 'project', label: '项目层' }, { value: 'global', label: '全局层' }]}
            onChange={value => setScope(value as SkillScope)} disabled={createBusy || busy} ariaLabel="技能创建层级" /></ResourceSettingsField>
          <ResourceSettingsField label="描述 · 可选" wide><input className="field__input" value={createDescription} disabled={createBusy || busy} onChange={event => setCreateDescription(event.target.value)} placeholder="技能用途和适用场景" aria-label="新技能描述" /></ResourceSettingsField>
          <ResourceSettingsField label="技能正文" wide><textarea className="field__input skills-create-body" value={createContent} disabled={createBusy || busy} onChange={event => setCreateContent(event.target.value)} placeholder="输入 Markdown 正文" aria-label="新技能正文" rows={9} /></ResourceSettingsField>
          <p className="resource-description is-wide">名称会自动规范化为目录名；正文无需额外配置。</p>
          <div className="skills-create-overwrite is-wide"><span>已存在时覆盖并备份旧版本</span><Toggle checked={createOverwrite} disabled={createBusy || busy} onChange={setCreateOverwrite} label="已存在时覆盖并备份" /></div>
          {error ? <p className="resource-feedback is-error is-wide" role="alert">{error}</p> : null}
        </form>
      </Dialog> : null}

      {importOpen ? <Dialog title="导入技能" width={560} className="resource-editor skills-import-dialog" onClose={() => { setImportOpen(false); setDragging(false) }} footer={<>
        {record?.importId && !importFinished(record) ? <button type="button" className="btn" disabled={cancelling !== null} onClick={() => void cancelImport(record)}>{cancelling === record.importId ? '取消中…' : '取消导入'}</button> : null}
        <button type="button" className="btn" onClick={() => setImportOpen(false)}>完成</button>
      </>}>
        <div className="resource-form">
          <ResourceSettingsField label="保存层级"><Select value={scope} options={[{ value: 'project', label: '项目层' }, { value: 'global', label: '全局层' }]}
            onChange={value => setScope(value as SkillScope)} disabled={busy} ariaLabel="技能导入层级" /></ResourceSettingsField>
          <ResourceSettingsField label="同名技能"><Select value={strategy} options={[
            { value: 'versioned', label: '保留版本' }, { value: 'overwrite', label: '覆盖并备份' }, { value: 'reject', label: '拒绝冲突' }
          ]} onChange={value => setStrategy(value as ConflictStrategy)} disabled={busy} ariaLabel="技能冲突处理策略" /></ResourceSettingsField>
          <p className="resource-description is-wide">项目层仅用于当前工作区；全局层可供其他工作区使用。</p>
          <div className={`skills-import-drop is-wide${dragging ? ' is-dragging' : ''}`}
            onDragEnter={event => { event.preventDefault(); setDragging(true) }} onDragOver={event => event.preventDefault()}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDrop={onDrop}>
            <Icon name="package-up" size={26} /><strong>拖拽技能文件到这里</strong><span>ZIP、TAR、TGZ、GZ 或 SKILL.md</span>
            <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? '导入中…' : '选择文件…'}</button>
            <input ref={fileRef} type="file" hidden accept=".zip,.tar,.tgz,.tar.gz,.gz,.md" aria-label="技能文件" onChange={event => {
              const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file)
            }} />
          </div>
          {record ? <div className="is-wide"><ImportProgress record={record} /></div> : null}
          {error ? <p className="resource-feedback is-error is-wide" role="alert">{error}</p> : null}
        </div>
      </Dialog> : null}

      {detailTarget ? <Dialog title={`技能详情 · ${detailTarget.name}`} width={720} className="resource-editor skills-detail-dialog" onClose={closeDetail}
        footer={<button type="button" className="btn" onClick={closeDetail}>关闭详情</button>}>
        {detailError ? <div className="skills-detail-error"><p className="resource-feedback is-error" role="alert">{detailError}</p><button type="button" className="btn" onClick={() => void showDetail(detailTarget)}>重试</button></div>
          : !detail ? <ResourceSettingsEmpty loading title="正在读取技能…" /> : <div className="skills-detail">
            <div className="skills-detail__heading"><span className="resource-row__icon"><Icon name="package-variant-closed" size={20} /></span><div>
              <strong>{detail.name}</strong><span className="resource-row__meta">{detail.scope === 'global' ? '全局' : '项目'} · {detail.enabled ? '已启用' : '已停用'} · {detail.files.length} 个文件</span>
            </div></div>
            {detail.description ? <p className="resource-description">{detail.description}</p> : null}
            <pre className="skills-detail__content" tabIndex={0} aria-label="技能正文">{detail.content}</pre>
            <details className="resource-disclosure skills-detail__files"><summary>包含的文件 · {detail.files.length}</summary>
              <p className="resource-description">{detail.dir}</p><ul>{detail.files.map(file => <li key={file.path}><span><FileGlyph name={file.path} size={16} /><span>{file.path}</span></span><span>{formatBytes(file.size)}</span></li>)}</ul>
            </details>
          </div>}
      </Dialog> : null}
    </div>
  )
}

