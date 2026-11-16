import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { request, requestOrThrow } from '@renderer/core/engine/client'
import { getEngineSource } from '@renderer/core/engine/source'
import { getPluginTemplate, listPluginTemplates, listPlugins, parsePluginDraft, pluginExampleArgs, pluginPath, type PluginRecord, type PluginImport, type PluginTemplate, type PluginTemplateSummary } from '@renderer/core/engine/plugins'
import { notifyResourceCatalogueChanged, subscribeResourceCatalogueChanges } from '@renderer/core/engine/resource-catalogue'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { Icon } from '@renderer/ui/icons'
import { Select } from '@renderer/ui/Select'
import { SelectionCheckbox } from '@renderer/ui/SelectionCheckbox'
import { Toggle } from '../settings/SettingsGroup'
import { PluginRunner } from './PluginRunner'
import { PluginArchiveImport } from './PluginArchiveImport'
import { PluginDevelopmentMode } from './PluginDevelopmentMode'
import { PluginPermissions } from './PluginPermissions'
import './plugin-manager.css'

type Editor = { id?: string; revision?: number; template?: PluginTemplate; manifest: string; files: Record<string, string>; baseline: string; record?: PluginRecord }
type Tab = 'overview' | 'tools' | 'source' | 'test' | 'permissions' | 'versions'
type ImportSource = 'github' | 'directory' | 'archive'
const importStatus: Record<string, string> = { preparing: '正在准备', prepared: '可安装', installing: '正在安装', installed: '已安装', failed: '失败', cancelled: '已取消' }
const fingerprint = (manifest: string, files: Record<string, string>): string => JSON.stringify([manifest, files])
const firstSource = (files: Record<string, string>): string => Object.keys(files).find(path => path.endsWith('.mjs')) ?? Object.keys(files)[0] ?? ''
const ROOT_MANIFEST = 'aether-plugin.json'

/** Plugin content stays on the selected engine; the renderer only edits text and invokes explicit actions. */
export function PluginManager({ ready, onCreateWithAI }: { ready: boolean; onCreateWithAI: () => void }): JSX.Element {
  const source = getEngineSource(), mounted = useRef(true), generation = useRef(0)
  const [plugins, setPlugins] = useState<PluginRecord[]>([]), [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null), [tab, setTab] = useState<Tab>('overview'), [file, setFile] = useState('')
  const [application, setApplication] = useState<{ id: string; name: string; revision: number } | null>(null)
  const [development, setDevelopment] = useState(false)
  const [selectionMode, setSelectionMode] = useState<'delete' | 'permissions' | null>(null), [selection, setSelection] = useState<string[]>([])
  const deleting = useRef(false), catalogueDirty = useRef(false)
  const [templates, setTemplates] = useState<PluginTemplateSummary[]>([])
  const [testTool, setTestTool] = useState(''), [testArgs, setTestArgs] = useState('{}'), [testOutput, setTestOutput] = useState('')
  const [importing, setImporting] = useState(false), [importSource, setImportSource] = useState<ImportSource>('github')
  const [importUrl, setImportUrl] = useState(''), [importRef, setImportRef] = useState(''), [importSubdir, setImportSubdir] = useState('')
  const [importPreview, setImportPreview] = useState<PluginImport | null>(null)
  const [importFormat, setImportFormat] = useState<'native' | 'remark'>('native')
  const current = useCallback(() => mounted.current && source === getEngineSource(), [source])
  const updateBusy = useCallback((value: boolean): void => { if (current()) setBusy(value) }, [current])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  const refresh = useCallback(async (preserveFeedback = false): Promise<void> => {
    if (!ready) { setLoading(false); return }
    const epoch = ++generation.current
    setLoading(true); if (!preserveFeedback) setError('')
    try { const result = await listPlugins(); if (current() && epoch === generation.current) setPlugins(result) }
    catch (cause) { if (current() && epoch === generation.current) setError(previous => [preserveFeedback ? previous : '', cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join(' ')) }
    finally { if (current() && epoch === generation.current) setLoading(false) }
  }, [ready, current])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeResourceCatalogueChanges(['plugin'], () => { if (deleting.current) catalogueDirty.current = true; else void refresh() }), [refresh])
  useEffect(() => { setSelection(ids => ids.filter(id => plugins.some(plugin => plugin.id === id))) }, [plugins])
  const endSelection = (): void => { setSelectionMode(null); setSelection([]) }
  const toggleSelection = (id: string): void => setSelection(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id])
  const changed = editor && fingerprint(editor.manifest, editor.files) !== editor.baseline
  const leave = async (): Promise<boolean> => !changed || await confirmDialog({ title: '放弃修改？', body: '尚未保存的插件内容将丢失。', confirmText: '放弃修改', danger: true })
  const open = async (plugin?: PluginRecord): Promise<void> => {
    if (busy || !await leave() || !current()) return
    setBusy(true); setError(''); setNotice('')
    try {
      const record = plugin ? (await requestOrThrow<{ plugin: PluginRecord }>({ method: 'GET', path: pluginPath(plugin.id) })).plugin : undefined
      let template: PluginTemplate | undefined
      if (!record) {
        const options = await listPluginTemplates()
        template = await getPluginTemplate(options.find(item => item.id === 'json-tool')?.id ?? options[0].id)
        if (current()) setTemplates(options)
      }
      if (!current()) return
      const value = record ?? template!, manifest = JSON.stringify(value.manifest, null, 2), files = value.files ?? {}
      setEditor({ id: record?.id, revision: record?.revision, record, template, manifest, files, baseline: fingerprint(manifest, files) })
      endSelection()
      setApplication(null)
      const tool = value.manifest.tools[0]?.name ?? ''
      setFile(firstSource(files)); setTab('overview'); setTestTool(tool); setTestOutput(''); setTestArgs(pluginExampleArgs(files, tool)); setImporting(false)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) setBusy(false) }
  }
  // A completed engine mutation still changes global contributions after this page unmounts.
  const announce = (action: string, id: string): void => notifyResourceCatalogueChanged({ kind: 'plugin', action, id }, source)
  const refreshAll = (): void => { if (current()) announce('refresh', '*') }
  const permissionsUpdated = (plugin: PluginRecord): void => {
    announce('permissions', plugin.id)
    if (!current()) return
    setPlugins(values => values.map(value => value.id === plugin.id ? plugin : value))
    setEditor(value => value?.id === plugin.id ? { ...value, record: plugin } : value)
  }
  const launch = (plugin: PluginRecord): void => {
    if (busy || !current()) return
    if (!plugin.enabled || !plugin.publishedRevision) { void open(plugin); return }
    endSelection(); setApplication({ id: plugin.id, name: plugin.name, revision: plugin.publishedRevision }); setEditor(null); setError(''); setNotice('')
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy || !current()) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (current()) setBusy(false) }
  }
  const changeTemplate = async (id: string): Promise<void> => {
    if (busy || editor?.id || editor?.template?.id === id || !await leave() || !current()) return
    await run(async () => {
      const template = await getPluginTemplate(id)
      if (!current()) return
      const manifest = JSON.stringify(template.manifest, null, 2), files = template.files
      setEditor({ template, manifest, files, baseline: fingerprint(manifest, files) })
      const tool = template.manifest.tools[0]?.name ?? ''
      setFile(firstSource(files)); setTestTool(tool); setTestOutput(''); setTestArgs(pluginExampleArgs(files, tool))
    })
  }
  const exportArchive = async (): Promise<void> => {
    if (!editor?.id || changed) throw new Error('请先保存当前草稿，再导出。')
    const { archive } = await requestOrThrow<{ archive: { fileName: string; base64: string; sha256: string; revision: number } }>({ method: 'GET', path: `/plugins/project/exports/${encodeURIComponent(editor.id)}?revision=${editor.revision}` })
    if (!current()) return
    const bytes = Uint8Array.from(atob(archive.base64), character => character.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })), anchor = document.createElement('a')
    anchor.href = url; anchor.download = archive.fileName.replace(/[/\\]/g, '_'); anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`已导出 r${archive.revision} 插件 ZIP。`)
  }
  const save = async (): Promise<void> => {
    if (!editor) return
    const payload = parsePluginDraft(editor.manifest, editor.files)
    const response = await requestOrThrow<{ plugin: PluginRecord }>({ method: editor.id ? 'PUT' : 'POST', path: editor.id ? pluginPath(editor.id) : '/plugins',
      body: { ...payload, ...(editor.id ? { expectedRevision: editor.revision } : {}) } })
    announce(editor.id ? 'update' : 'create', response.plugin.id)
    if (!current()) return
    const record = response.plugin, manifest = JSON.stringify(record.manifest, null, 2), files = record.files ?? payload.files
    setEditor({ id: record.id, revision: record.revision, record, manifest, files, baseline: fingerprint(manifest, files) })
    setNotice('草稿已保存')
  }
  const publish = async (): Promise<void> => {
    if (!editor?.id || changed) throw new Error('请先保存当前草稿，再发布。')
    const { plugin } = await requestOrThrow<{ plugin: PluginRecord }>({ method: 'POST', path: `${pluginPath(editor.id)}/publish`, body: { expectedRevision: editor.revision } })
    announce('publish', plugin.id)
    if (!current()) return
    setEditor(value => value ? { ...value, record: plugin, revision: plugin.revision } : value)
    setNotice(`版本 ${plugin.manifest.version} 已发布并启用，可在 @ 中选择。`)
  }
  const toggle = (plugin: PluginRecord, enabled: boolean): void => { void run(async () => {
    await requestOrThrow({ method: 'PATCH', path: pluginPath(plugin.id), body: { enabled } })
    announce('set_enabled', plugin.id)
    if (current()) setNotice(enabled ? '插件已启用' : '插件已停用')
  }) }
  const remove = async (plugin: PluginRecord): Promise<void> => {
    if (!await confirmDialog({ title: '删除插件', body: `删除「${plugin.name}」及其本地版本？`, confirmText: '删除', danger: true }) || !current()) return
    await run(async () => { await requestOrThrow({ method: 'DELETE', path: pluginPath(plugin.id) }); announce('delete', plugin.id); if (current()) { if (editor?.id === plugin.id) setEditor(null); setNotice('插件已删除') } })
  }
  const removeSelected = async (): Promise<void> => {
    const targets = plugins.filter(plugin => selection.includes(plugin.id))
    if (busy || deleting.current || !targets.length || !current()) return
    deleting.current = true
    setBusy(true)
    try {
      const names = targets.slice(0, 5).map(plugin => `「${plugin.name}」`).join('、')
      if (!await confirmDialog({ title: `删除 ${targets.length} 个插件？`, body: `将删除${names}${targets.length > 5 ? `等 ${targets.length} 个插件` : ''}及其本地版本。此操作无法撤销。`, confirmText: '删除', danger: true }) || !current()) return
      setError(''); setNotice('')
      // Older catalogue responses must not put deleted rows back. Our own
      // receipts refresh other surfaces; this list reconciles once at the end.
      generation.current++
      setLoading(false)
      const failed: string[] = []
      let removed = 0
      for (const plugin of targets) {
        if (!current()) return
        try {
          await requestOrThrow({ method: 'DELETE', path: pluginPath(plugin.id), body: { expectedRevision: plugin.revision } })
          announce('delete', plugin.id)
          if (!current()) return
          removed++
          setPlugins(values => values.filter(value => value.id !== plugin.id))
          setSelection(ids => ids.filter(id => id !== plugin.id))
        } catch (cause) {
          if (!current()) return
          failed.push(`${plugin.name}：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      catalogueDirty.current = false
      await refresh()
      if (!current()) return
      if (failed.length) setError(previous => [`已删除 ${removed} 个插件，${failed.length} 个删除失败。${failed.join('；')}`, previous].filter(Boolean).join(' '))
      else { endSelection(); setNotice(`已删除 ${removed} 个插件`) }
    } finally {
      deleting.current = false
      if (current()) {
        setBusy(false)
        if (catalogueDirty.current) { catalogueDirty.current = false; void refresh(true) }
      }
    }
  }
  const patchManifest = (key: string, value: string): void => {
    setEditor(previous => {
      if (!previous) return previous
      try { const manifest = JSON.parse(previous.manifest) as Record<string, unknown>; return { ...previous, manifest: JSON.stringify({ ...manifest, [key]: value }, null, 2) } }
      catch { return previous }
    })
  }
  const previewImport = async (): Promise<void> => {
    if (!current()) return
    const response = await request<{ import: PluginImport }>({ method: 'POST', path: '/plugins/imports/preview', body: { source: importSource, format: importFormat,
      ...(importSource === 'github' ? { url: importUrl, ...(importRef ? { ref: importRef } : {}), ...(importSubdir ? { subdir: importSubdir } : {}) } : {}),
      ...(importSource === 'directory' ? { path: importUrl } : {}) } })
    if (current() && response.data?.import) setImportPreview(response.data.import)
    if (!response.ok) {
      // A failed import still has a durable job receipt. Keep it visible in the
      // preview card so the user can refresh or retry without a duplicate banner.
      if (response.data?.import) return
      throw new Error(response.message || '插件预览失败，请查看导入状态。')
    }
  }
  const install = async (): Promise<void> => {
    if (!importPreview) return
    const { plugin } = await requestOrThrow<{ plugin: PluginRecord }>({ method: 'POST', path: `/plugins/imports/${encodeURIComponent(importPreview.jobId)}/install` })
    announce('import_install', plugin.id)
    if (current()) { setImporting(false); setImportPreview(null); setNotice(`「${plugin.name}」已导入，可查看后发布。`) }
  }
  let manifest: Record<string, unknown> | null = null
  try { const parsed: unknown = editor ? JSON.parse(editor.manifest) : null; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown> } catch { /* Preserve invalid editor JSON. */ }
  const tools = Array.isArray(manifest?.tools) ? manifest.tools.filter((tool): tool is { name: string; entry?: string } => Boolean(tool && typeof tool === 'object' && typeof tool.name === 'string')) : []
  const filtered = plugins.filter(plugin => `${plugin.name} ${plugin.description} ${plugin.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const selectedPlugins = plugins.filter(plugin => selection.includes(plugin.id))
  const selectedVisible = filtered.filter(plugin => selection.includes(plugin.id)).length
  const toggleAll = (): void => setSelection(ids => selectedVisible === filtered.length ? ids.filter(id => !filtered.some(plugin => plugin.id === id)) : [...new Set([...ids, ...filtered.map(plugin => plugin.id)])])
  if (development) return <PluginDevelopmentMode ready={ready} onBack={() => setDevelopment(false)} />
  if (application) return <PluginRunner key={`${source}:${application.id}:${application.revision}`} {...application} onBack={() => setApplication(null)} onEdit={() => { const plugin = plugins.find(item => item.id === application.id); if (plugin) void open(plugin) }} />
  return <section className="work-plugins" aria-label="插件管理">
    <header className={`work-plugins__heading${editor || importing ? ' work-plugins__heading--detail' : ''}`}>
      <div className="work-plugins__title">{editor || importing ? <button type="button" className="btn btn--ghost" aria-label="返回插件列表" disabled={busy} onClick={() => { void (async () => { if (await leave() && current()) { setEditor(null); setImporting(false); setError(''); setNotice('') } })() }}><Icon name="chevron-left" size={18} /></button> : null}
        <div><h1>{importing ? '导入插件' : editor ? editor.id ? '编辑插件' : '新建插件' : '插件'}</h1><p>{importing ? '从仓库或本地文件添加能力。' : '创建自己的工具，按需用于对话。'}</p></div></div>
      {!editor && !importing ? <div className="work-plugins__actions"><button type="button" className="btn btn--ghost" disabled={!ready || busy} onClick={onCreateWithAI}><Icon name="model" size={16} />AI 创建</button><button type="button" className="btn btn--ghost" disabled={!ready || busy} onClick={() => setDevelopment(true)}><Icon name="file" size={16} />开发模式</button><button type="button" className="btn" disabled={!ready || busy} onClick={() => { setImporting(true); setImportPreview(null); setImportUrl(''); setImportRef(''); setImportSubdir(''); setError(''); setNotice('') }}>导入</button><button type="button" className="btn btn--primary" disabled={!ready || busy} onClick={() => { void open() }}><Icon name="plus" size={16} />新建插件</button></div> : null}
    </header>
    {error ? <div className="work-plugins__feedback is-error" role="alert">{error}</div> : null}
    {notice ? <div className="work-plugins__feedback" role="status">{notice}</div> : null}
    {!ready ? <p className="work-plugins__empty" role="status">连接引擎后管理插件。</p> : importing ? <div className="work-plugins__import work-plugins__surface">
      <div className="work-plugins__segments" role="tablist" aria-label="插件来源">{(['github', 'directory', 'archive'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={importSource === value} disabled={busy} onClick={() => { setImportSource(value); setImportPreview(null); setImportUrl(''); setImportRef(''); setImportSubdir('') }}>{({ github: 'GitHub', directory: '本地目录', archive: 'ZIP 文件' })[value]}</button>)}</div>
      <label className="work-plugins__field"><span>插件格式</span><Select ariaLabel="插件格式" value={importFormat} disabled={busy} options={[{ value: 'native', label: 'Aether 原生插件' }, { value: 'remark', label: 'remark · Markdown 处理插件' }]} onChange={value => { setImportFormat(value as 'native' | 'remark'); setImportPreview(null) }} /></label><p className="work-plugins__note">{importFormat === 'native' ? '目录中需要 aether-plugin.json 与自包含源码。' : '支持 ESM remark 插件；安装时下载依赖，禁用 npm 安装脚本。'}</p>
      {importSource === 'archive' ? <PluginArchiveImport key={importFormat} format={importFormat} plugins={plugins} onBusyChange={updateBusy} onInstalled={plugin => { announce('import_install', plugin.id); if (current()) setNotice(`「${plugin.name}」已导入为草稿。`) }} onDone={() => { if (current()) { setBusy(false); setImporting(false) } }} />
        : <label className="work-plugins__field"><span>{importSource === 'github' ? '仓库地址' : '引擎所在电脑的目录'}</span><input className="ui-input" value={importUrl} disabled={busy} placeholder={importSource === 'github' ? 'https://github.com/owner/repository' : 'D:\\plugins\\my-plugin'} onChange={event => { setImportUrl(event.target.value); setImportPreview(null) }} /></label>}
      {importSource === 'github' ? <div className="work-plugins__two"><label className="work-plugins__field"><span>分支或版本 <small>可选</small></span><input className="ui-input" value={importRef} disabled={busy} onChange={event => { setImportRef(event.target.value); setImportPreview(null) }} /></label><label className="work-plugins__field"><span>插件子目录 <small>可选</small></span><input className="ui-input" value={importSubdir} disabled={busy} onChange={event => { setImportSubdir(event.target.value); setImportPreview(null) }} /></label></div> : null}
      {importSource !== 'archive' ? <button type="button" className="btn" disabled={busy || !importUrl.trim()} onClick={() => { void run(previewImport) }}>{busy ? '读取中…' : '预览插件'}</button> : null}
      {importSource !== 'archive' && importPreview ? <div className="work-plugins__preview"><div className="work-plugins__preview-heading"><span className="work-plugins__preview-icon"><Icon name="puzzle" size={19} /></span><div><h2>{importPreview.manifest?.name ?? '导入信息'}</h2><p>{importPreview.manifest?.description}</p></div></div><dl><dt>版本</dt><dd>{importPreview.manifest?.version ?? '—'}</dd><dt>工具</dt><dd>{importPreview.manifest?.tools?.map(tool => tool.name).join('、') || '—'}</dd><dt>状态</dt><dd><span className={`work-plugins__status work-plugins__status--${importPreview.status}`}>{importStatus[importPreview.status] ?? importPreview.status}</span><button type="button" className="btn btn--icon btn--ghost" aria-label="刷新导入状态" title="刷新导入状态" disabled={busy} onClick={() => { void run(async () => { const response = await requestOrThrow<{ import: PluginImport }>({ method: 'GET', path: `/plugins/imports/${encodeURIComponent(importPreview.jobId)}` }); if (current()) setImportPreview(response.import) }) }}><Icon name="refresh" size={16} /></button></dd></dl>{importPreview.error ? <p className="work-plugins__inline-error" role="alert">{importPreview.error}</p> : null}{importPreview.requirements ? <details><summary>运行要求</summary><pre>{JSON.stringify(importPreview.requirements, null, 2)}</pre></details> : null}<button type="button" className="btn btn--primary" disabled={busy || !importPreview.manifest || (importPreview.status !== 'prepared' && !(importPreview.status === 'failed' && importPreview.failureStage === 'install'))} onClick={() => { void run(install) }}>安装插件</button></div> : null}
    </div> : editor ? <>
      <div className="work-plugins__editor-shell"><div className="work-plugins__editor-bar"><span className="work-plugins__editor-state"><i aria-hidden="true" />{editor.record?.publishedRevision ? `已发布 r${editor.record.publishedRevision}${editor.record.enabled ? ' · 已启用' : ' · 已停用'}` : '尚未发布'}{changed ? ' · 有未保存修改' : ''}</span><div className="work-plugins__actions"><button type="button" className="btn btn--icon btn--ghost" aria-label="导出插件 ZIP" title={!editor.id || changed ? '先保存草稿，再导出 ZIP' : `导出 r${editor.revision} 插件 ZIP`} disabled={busy || !editor.id || Boolean(changed)} onClick={() => { void run(exportArchive) }}><Icon name="download" size={17} /></button><button type="button" className="btn" disabled={busy || (!changed && Boolean(editor.id))} onClick={() => { void run(save) }}>保存草稿</button><button type="button" className="btn btn--primary" disabled={busy || !editor.id || Boolean(changed)} onClick={() => { void run(publish) }}>发布并启用</button></div></div>
      <div className="work-plugins__segments" role="tablist" aria-label="插件详情">{(['overview', 'tools', 'source', 'test', 'permissions', 'versions'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} disabled={busy} onClick={() => setTab(value)}>{({ overview: '概览', tools: '工具清单', source: '源文件', test: '测试', permissions: '权限', versions: '版本' })[value]}</button>)}</div>
      <div className="work-plugins__editor" role="tabpanel" aria-label={{ overview: '概览', tools: '工具清单', source: '源文件', test: '测试', permissions: '权限', versions: '版本' }[tab]}>
        {tab === 'overview' ? <>{!editor.id && editor.template ? <><label className="work-plugins__field"><span>官方模板</span><Select ariaLabel="官方模板" value={editor.template.id} disabled={busy} options={templates.map(template => ({ value: template.id, label: template.name, description: template.description }))} onChange={value => { void changeTemplate(value) }} /></label><p className="work-plugins__note">{editor.template.description} 随附源码、说明与测试案例。</p></> : null}{!manifest ? <p role="alert">清单 JSON 无效，请在工具清单中修正。</p> : <><div className="work-plugins__two">{[['name', '名称'], ['id', '标识'], ['version', '版本']].map(([key, label]) => <label className="work-plugins__field" key={key}><span>{label}</span><input className="ui-input" value={String(manifest[key] ?? '')} disabled={busy || (key === 'id' && Boolean(editor.id))} onChange={event => patchManifest(key, event.target.value)} /></label>)}</div><label className="work-plugins__field"><span>用途</span><textarea className="ui-input" rows={3} value={String(manifest.description ?? '')} disabled={busy} onChange={event => patchManifest('description', event.target.value)} /></label><p className="work-plugins__note">保存草稿后可测试；发布并启用后，在对话的 @ 菜单中添加插件。</p></>}{editor.template ? <details><summary>运行协议与能力范围</summary>{Object.entries(editor.template.protocol).filter(([, value]) => typeof value === 'string' && value !== 'node').map(([key, value]) => <p key={key} className="work-plugins__note">{value}</p>)}</details> : null}</> : null}
        {tab === 'tools' ? <label className="work-plugins__field"><span>插件清单 JSON</span><textarea className="ui-input work-plugins__code" aria-label="插件清单 JSON" spellCheck={false} value={editor.manifest} disabled={busy} onChange={event => setEditor({ ...editor, manifest: event.target.value })} /></label> : null}
        {tab === 'permissions' ? editor.record ? <><PluginPermissions key={editor.id} plugins={[editor.record]} disabled={Boolean(changed)} onUpdated={permissionsUpdated} onBusyChange={updateBusy} />{changed ? <p className="work-plugins__note">先保存草稿，再调整此插件的权限。</p> : null}</> : <p className="work-plugins__note">保存插件后可管理清单中申请的平台权限。</p> : null}
        {tab === 'source' ? <><div className="work-plugins__source-bar"><label><span className="sr-only">源文件</span><Select ariaLabel="选择源文件" value={file} disabled={busy} options={Object.keys(editor.files).map(path => ({ value: path, label: path }))} onChange={setFile} /></label><button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { let index = 1; while (editor.files[`tools/tool-${index}.mjs`] !== undefined) index++; const path = `tools/tool-${index}.mjs`; setEditor({ ...editor, files: { ...editor.files, [path]: '' } }); setFile(path) }}>添加文件</button><button type="button" className="btn btn--ghost" disabled={busy || !file || file === ROOT_MANIFEST || Object.keys(editor.files).length < 2} onClick={() => { const files = { ...editor.files }; delete files[file]; setEditor({ ...editor, files }); setFile(firstSource(files)) }}>移除文件</button></div><textarea className="ui-input work-plugins__code" aria-label={`源文件 ${file}`} spellCheck={false} value={file === ROOT_MANIFEST ? editor.manifest : editor.files[file] ?? ''} readOnly={file === ROOT_MANIFEST} disabled={busy || !file} onChange={event => { if (file !== ROOT_MANIFEST) setEditor({ ...editor, files: { ...editor.files, [file]: event.target.value } }) }} /><p className="work-plugins__note">{file === ROOT_MANIFEST ? '根清单为只读预览，请在「概览」或「工具清单」中编辑；保存时由引擎同步。' : '新增文件为空，请参考模板附带的 main.mjs 与 README.md 实现；工具入口还需在「工具清单」的 tools.entry 中登记。'}</p></> : null}
        {tab === 'test' ? <><p className="work-plugins__note">测试会执行已保存的插件代码。独立进程具有本机权限，不是系统沙箱。</p><label className="work-plugins__field"><span>测试工具</span><Select ariaLabel="测试工具" value={testTool} disabled={busy} options={tools.map(tool => ({ value: tool.name, label: tool.name }))} onChange={value => { setTestTool(value); setTestArgs(pluginExampleArgs(editor.files, value)); setTestOutput('') }} /></label><label className="work-plugins__field"><span>参数 JSON</span><textarea className="ui-input work-plugins__args" aria-label="测试参数 JSON" value={testArgs} disabled={busy} onChange={event => setTestArgs(event.target.value)} /></label><button type="button" className="btn" disabled={busy || !editor.id || Boolean(changed) || !testTool || !tools.some(tool => tool.name === testTool)} onClick={() => { void run(async () => { const result = await requestOrThrow({ method: 'POST', path: `${pluginPath(editor.id!)}/test`, body: { revision: editor.revision, tool: testTool, args: JSON.parse(testArgs) } }); if (current()) setTestOutput(JSON.stringify(result, null, 2)) }) }}>运行测试</button>{testOutput ? <pre className="work-plugins__result" aria-label="插件测试结果">{testOutput}</pre> : null}</> : null}
        {tab === 'versions' ? <><p className="work-plugins__note">每次保存保留独立修订；对话使用所选的已发布修订。</p><ul className="work-plugins__versions">{(editor.record?.revisions ?? []).map(version => <li key={version.revision}><strong>r{version.revision}</strong><span>{version.revision === editor.record?.publishedRevision ? '已发布' : '草稿'}</span><code title={version.hash}>{version.hash.slice(0, 22)}</code></li>)}</ul>{!editor.id ? <p>保存后显示版本记录。</p> : null}{editor.record?.source ? <details><summary>安装来源</summary><pre>{JSON.stringify(editor.record.source, null, 2)}</pre></details> : null}</> : null}
      </div></div>
    </> : <><div className="work-plugins__toolbar">
      <label className="work-plugins__search ui-input-shell"><Icon name="search" size={16} /><input className="ui-input-field" aria-label="搜索插件" value={query} placeholder="搜索插件" disabled={busy} onChange={event => { setQuery(event.target.value); setSelection([]) }} /></label>
      <div className="work-plugins__actions">
        {selectionMode === 'delete' ? <>
          <label className="work-plugins__selection"><SelectionCheckbox label="全选当前结果" checked={Boolean(filtered.length) && selectedVisible === filtered.length} mixed={selectedVisible > 0 && selectedVisible < filtered.length} disabled={busy || loading || !filtered.length} onChange={toggleAll} /><span>已选择 {selectedPlugins.length} 个插件</span></label>
          <button type="button" className="btn btn--icon btn--ghost work-plugins__delete" aria-label="删除所选插件" title="删除所选插件" disabled={busy || loading || !selectedPlugins.length} onClick={() => { void removeSelected() }}><Icon name="trash" size={16} /></button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={endSelection}>完成</button>
        </> : <>
          {plugins.length ? <button type="button" className="btn btn--ghost" aria-pressed={selectionMode === 'permissions'} disabled={busy || loading} onClick={() => { setSelectionMode(value => value === 'permissions' ? null : 'permissions'); setSelection([]) }}><Icon name="shield" size={16} />权限管理</button> : null}
          <button type="button" className="btn btn--ghost" disabled={busy || loading || !plugins.length} onClick={() => { setSelectionMode('delete'); setSelection([]) }}><Icon name="checkbox-multiple-marked-outline" size={16} />多选</button>
        </>}
        <button type="button" className="btn btn--icon btn--ghost work-plugins__refresh" aria-label="刷新插件" title="刷新插件" disabled={loading || busy} onClick={refreshAll}><Icon name="refresh" size={16} /></button>
      </div>
    </div>
      {selectionMode === 'permissions' ? <div className="plugin-permissions__batch"><div className="plugin-permissions__selection"><label><SelectionCheckbox label="选择当前列表全部插件" checked={Boolean(filtered.length) && selectedVisible === filtered.length} mixed={selectedVisible > 0 && selectedVisible < filtered.length} disabled={busy || loading || !filtered.length} onChange={toggleAll} />已选择 {selectedPlugins.length} 个插件</label><button type="button" className="btn btn--ghost" disabled={busy} onClick={endSelection}>完成</button></div><PluginPermissions key={selectedPlugins.map(plugin => plugin.id).join(':')} plugins={selectedPlugins} onUpdated={permissionsUpdated} onBusyChange={updateBusy} /></div> : null}
      {loading ? <p className="work-plugins__empty" role="status">正在读取插件…</p> : filtered.length ? <ul className="work-plugins__list" aria-label="已安装插件">{filtered.map(plugin => <li key={plugin.id} className={selectionMode && selection.includes(plugin.id) ? 'is-selected' : undefined}>
        {selectionMode ? <SelectionCheckbox label={`选择插件 ${plugin.name}`} checked={selection.includes(plugin.id)} disabled={busy} onChange={() => toggleSelection(plugin.id)} /> : null}
        <button type="button" className="work-plugins__row" aria-label={`${selectionMode ? '勾选插件' : '打开插件'} ${plugin.name}`} aria-pressed={selectionMode ? selection.includes(plugin.id) : undefined} disabled={busy} onClick={() => selectionMode ? toggleSelection(plugin.id) : launch(plugin)}><Icon name="puzzle" size={20} /><span className="work-plugins__copy"><strong>{plugin.name}</strong><span>{plugin.description}</span></span><small>{plugin.publishedRevision ? plugin.enabled ? '已启用' : '已停用' : '草稿'}</small></button>
        {!selectionMode ? <><Toggle label={`启用插件 ${plugin.name}`} checked={plugin.enabled} disabled={busy || !plugin.publishedRevision} onChange={enabled => toggle(plugin, enabled)} /><button type="button" className="btn btn--ghost" aria-label={`编辑插件 ${plugin.name}`} title="编辑插件" disabled={busy} onClick={() => { void open(plugin) }}><Icon name="file-edit-outline" size={16} /></button><button type="button" className="btn btn--ghost work-plugins__delete" aria-label={`删除插件 ${plugin.name}`} title="删除插件" disabled={busy} onClick={() => { void remove(plugin) }}><Icon name="trash" size={16} /></button></> : null}
      </li>)}</ul>
        : <div className="work-plugins__empty"><Icon name="puzzle" size={32} /><h2>{query ? '没有匹配的插件' : '添加你的第一项能力'}</h2><p>{query ? '尝试其他名称或用途。' : '手动创建、交给 AI，或导入已有插件。'}</p></div>}
    </>}
  </section>
}
