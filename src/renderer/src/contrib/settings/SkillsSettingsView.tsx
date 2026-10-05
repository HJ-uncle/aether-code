import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type JSX } from 'react'
import { request, requestOrThrow } from '@renderer/core/engine/client'
import { useApp } from '@renderer/core/app-context'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { assertEngineSource, getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { Select } from '@renderer/workbench/Select'
import { SettingsContent, SettingsGroup, SettingsRow, Toggle } from './SettingsGroup'
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
    return typeof candidate.name === 'string' && typeof candidate.description === 'string'
  }).map((item) => ({
    id: typeof item.id === 'string' ? item.id : undefined,
    name: item.name,
    description: item.description,
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
  const [record, setRecord] = useState<ImportRecord | null>(null)
  const [history, setHistory] = useState<ImportRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [createOverwrite, setCreateOverwrite] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const isCurrent = useCallback(() => mounted.current && source === getEngineSource(), [source])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const result = await request<{ list?: unknown }>({ method: 'GET', path: '/skills', query: { reload: 1, all: 1, path: projectRoot || undefined } })
      if (!isCurrent()) return
      if (!result.ok) throw new Error(result.message || `读取技能失败（${result.code}）`)
      setSkills(normalizeList(result.data))
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause))
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

  // Import status and an opened detail belong to the selected layer. Clear
  // them when the target changes so a completed project import is never shown
  // as the result of a subsequent global operation.
  useEffect(() => {
    setRecord(null)
    setDetail(null)
    setError('')
  }, [scope])

  const showDetail = async (skill: SkillListItem): Promise<void> => {
    setError('')
    try {
      setDetail(await requestOrThrow<SkillDetail>({ method: 'GET', path: `/skills/${encodeURIComponent(skillKey(skill))}`, query: { path: projectRoot || undefined, scope: skill.scope } }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const setEnabled = async (skill: SkillListItem, enabled: boolean): Promise<void> => {
    setError('')
    try {
      await requestOrThrow({ method: 'PATCH', path: `/skills/${encodeURIComponent(skillKey(skill))}`, query: { path: projectRoot || undefined, scope: skill.scope }, body: { enabled } })
      setSkills((current) => current.map((item) => skillIdentity(item) === skillIdentity(skill) ? { ...item, enabled } : item))
      if (detail && skillIdentity(detail) === skillIdentity(skill)) setDetail({ ...detail, enabled })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const remove = async (skill: SkillListItem): Promise<void> => {
    const confirmed = await confirmDialog({
      title: '删除技能？',
      body: `将删除“${skill.name}”及其已保存的版本，之后需要重新导入才能使用。`,
      confirmText: '删除技能',
      danger: true
    })
    if (!confirmed) return
    setError('')
    try {
      await requestOrThrow({ method: 'DELETE', path: `/skills/${encodeURIComponent(skillKey(skill))}`, query: { path: projectRoot || undefined, scope: skill.scope } })
      if (detail && skillIdentity(detail) === skillIdentity(skill)) setDetail(null)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const waitForImport = async (importId: string, expectedEngine: ReturnType<typeof getExpectedEngine>, sourceEpoch: number): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      assertEngineSource(sourceEpoch)
      const next = await requestOrThrow<ImportRecord>({ method: 'GET', path: `/skills/imports/${encodeURIComponent(importId)}`, expectedEngine })
      if (!isCurrent()) return
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
    try {
      if (!isSupportedFile(file)) throw new Error('仅支持 ZIP、TAR、TGZ、GZ 或 SKILL.md 文件')
      if (file.size === 0) throw new Error('不能导入空文件')
      if (file.size > MAX_FILE_SIZE) throw new Error(`文件超过 20 MB 上限（当前 ${formatBytes(file.size)}），请使用分片上传`)
      const data = new Uint8Array(await file.arrayBuffer())
      if (!isCurrent()) return
      assertEngineSource(sourceEpoch)
      const digest = await crypto.subtle.digest('SHA-256', data)
      const fileSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const multipartUpload = <T = unknown>(input: Omit<EngineUploadInput, 'expectedEngine'>) => {
        if (!isCurrent()) throw new Error('技能管理页面已关闭，请重新上传')
        assertEngineSource(sourceEpoch)
        return window.aether.engine.upload<T>({ ...input, expectedEngine })
      }
      let importId: string | undefined
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
          if (!isCurrent()) return
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
      if (!isCurrent()) return
      const message = errorMessage(cause)
      setError(message)
      setRecord((current) => current ? { ...current, status: 'failed', stage: '导入失败', errorMessage: message } : null)
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  const cancelImport = async (item: ImportRecord): Promise<void> => {
    if (!item.importId || ['imported', 'failed', 'cancelled'].includes(item.status)) return
    try {
      await requestOrThrow({ method: 'DELETE', path: `/skills/imports/${encodeURIComponent(item.importId)}` })
      await refreshHistory()
    } catch (cause) {
      setError(errorMessage(cause))
    }
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
    <div className="settings-view settings-view--skills">
      <div className="skills-page-header">
        <span className="skills-page-header__count" aria-live="polite">{skills.length} 个技能</span>
      </div>

      <SettingsGroup title="技能层级">
        <SettingsRow label="导入到" description="项目层仅对当前工作区生效，全局层可供其他工作区使用">
          <Select
            value={scope}
            options={[{ value: 'project', label: '项目层' }, { value: 'global', label: '全局层' }]}
            onChange={(value) => setScope(value as SkillScope)}
            disabled={busy}
            ariaLabel="技能导入层级"
            title="选择技能导入层级"
            width={160}
          />
        </SettingsRow>
        <SettingsRow label="冲突处理" description="导入同名技能时如何处理旧版本">
          <Select
            value={strategy}
            options={[
              { value: 'versioned', label: '保留版本' },
              { value: 'overwrite', label: '覆盖并备份' },
              { value: 'reject', label: '拒绝冲突' }
            ]}
            onChange={(value) => setStrategy(value as ConflictStrategy)}
            disabled={busy}
            ariaLabel="技能冲突处理策略"
            title="选择冲突处理策略"
            width={180}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="创建技能" footer="可以直接创建一个技能正文；名称会自动规范化为安全目录名，描述可留空。">
        <SettingsContent className="skills-create-content">
          <div className="skills-create-toolbar">
            <span className="skills-create-hint">不需要先准备压缩包，创建后会立即出现在技能列表。</span>
            <button type="button" className="btn btn--primary" disabled={busy || createBusy} onClick={() => setCreateOpen(value => !value)}>{createOpen ? '收起创建表单' : '直接创建技能'}</button>
          </div>
          {createOpen ? <div className="skills-create-form">
            <label className="skills-create-field"><span>名称</span><input className="field__input" value={createName} disabled={createBusy || busy} onChange={event => setCreateName(event.target.value)} placeholder="例如 release-notes" aria-label="新技能名称" /></label>
            <label className="skills-create-field"><span>描述 <em>可选</em></span><input className="field__input" value={createDescription} disabled={createBusy || busy} onChange={event => setCreateDescription(event.target.value)} placeholder="技能用途和适用场景" aria-label="新技能描述" /></label>
            <label className="skills-create-field skills-create-field--content"><span>技能正文</span><textarea className="field__input" value={createContent} disabled={createBusy || busy} onChange={event => setCreateContent(event.target.value)} placeholder="输入技能正文；可以是普通 Markdown，不要求 frontmatter" aria-label="新技能正文" rows={9} /></label>
            <label className="skills-create-overwrite"><input type="checkbox" checked={createOverwrite} disabled={createBusy || busy} onChange={event => setCreateOverwrite(event.target.checked)} /> 已存在时覆盖并备份旧版本</label>
            <div className="skills-create-actions"><button type="button" className="btn btn--primary" disabled={!createName.trim() || !createContent.trim() || createBusy || busy} onClick={() => void createSkill()}>{createBusy ? '创建中…' : '创建技能'}</button><button type="button" className="btn" disabled={createBusy || busy} onClick={() => setCreateOpen(false)}>取消</button></div>
          </div> : null}
        </SettingsContent>
      </SettingsGroup>

      <SettingsGroup title="导入技能" footer="支持 ZIP、TAR、TGZ、GZ 压缩包及单个 SKILL.md；正文可以没有完整 frontmatter，系统会从目录名或文件名推断技能名称。">
        <SettingsContent>
          <div
            className={`skills-import-drop${dragging ? ' is-dragging' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false) }}
            onDrop={onDrop}
          >
            <strong>拖拽文件到这里</strong>
            <span>或选择本地技能文件</span>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? '导入中…' : '选择文件…'}
            </button>
            <input ref={fileRef} type="file" hidden accept=".zip,.tar,.tgz,.tar.gz,.gz,.md" onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void importFile(file)
            }} />
          </div>
          {record ? <div className={`skills-import-status is-${record.status}`} role="status">{importStatusLabel(record)}</div> : null}
        </SettingsContent>
      </SettingsGroup>

      <SettingsGroup title="已安装技能">
        <SettingsContent>
          <div className="skills-list-head">
            <span>{skills.length ? `${skills.length} 个技能` : '暂无已安装技能'}</span>
            <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>刷新</button>
          </div>
          {skills.map((skill) => (
            <div className={`skills-card${skill.enabled ? '' : ' is-disabled'}`} key={`${skill.scope}:${skill.name}`}>
              <button type="button" className="skills-card__main" onClick={() => void showDetail(skill)}>
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
                <small><i className="skills-scope-badge">{skill.scope === 'global' ? '全局层' : '项目层'}</i>{skill.enabled ? '已启用' : '已停用'}</small>
              </button>
              <Toggle checked={skill.enabled} onChange={(enabled) => void setEnabled(skill, enabled)} label={`${skill.name} 启用`} disabled={busy} />
              <button type="button" className="btn btn--danger-ghost" disabled={busy} onClick={() => void remove(skill)}>删除</button>
            </div>
          ))}
        </SettingsContent>
      </SettingsGroup>

      <SettingsGroup title="导入历史">
        <SettingsContent>
          {history.length === 0 ? <span className="skills-history-empty">暂无导入记录</span> : history.map((item) => (
            <div className="skills-history-row" key={item.importId}>
              <div><strong>{item.filename}</strong><span>{importStatusLabel(item)}</span></div>
              {!['imported', 'failed', 'cancelled'].includes(item.status) ? <button type="button" className="btn" disabled={busy} onClick={() => void cancelImport(item)}>取消</button> : null}
            </div>
          ))}
        </SettingsContent>
      </SettingsGroup>

      {detail ? (
        <SettingsGroup title={`技能详情 · ${detail.name}`}>
          <SettingsContent>
            <div className="skills-detail">
              <div className="skills-detail__meta">{detail.scope === 'global' ? '全局层' : '项目层'} · {detail.enabled ? '已启用' : '已停用'} · {detail.files.length} 个文件</div>
              <pre>{detail.content}</pre>
              <button type="button" className="btn" onClick={() => setDetail(null)}>收起详情</button>
            </div>
          </SettingsContent>
        </SettingsGroup>
      ) : null}

      {error ? <div className="settings-view__error" role="alert">{error}</div> : null}
    </div>
  )
}

