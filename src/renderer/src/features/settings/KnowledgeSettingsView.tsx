import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Select } from '@renderer/ui/Select'
import { Dialog } from '@renderer/ui/Dialog'
import { Icon } from '@renderer/ui/icons'
import { Spinner } from '@renderer/ui/ui-primitives'
import { FileGlyph } from '@renderer/features/explorer/FileGlyph'
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeBases,
  listKnowledgeDocuments,
  knowledgeDocumentByteLength,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  validateKnowledgeDocumentText,
  searchKnowledge,
  updateKnowledgeBase,
  updateKnowledgeDocument,
  uploadKnowledgeDocument,
  uploadKnowledgeFile,
  listKnowledgeFormats,
  KNOWLEDGE_SUPPORTED_FORMATS,
  type KnowledgeBase,
  type KnowledgeDocument,
  type KnowledgeSearchResult
} from '@renderer/core/engine/knowledge'
import { getEngineSource, subscribeEngineSource } from '@renderer/core/engine/source'
import { subscribeResourceCatalogueChanges } from '@renderer/core/engine/resource-catalogue'
import { confirmDialog } from '@renderer/ui/ConfirmDialog'
import { Segmented } from './SettingsGroup'
import { ResourceSettingsEmpty, ResourceSettingsField, ResourceSettingsHeader, ResourceSettingsMenu } from './ResourceSettings'
import './knowledge-settings.css'
import './settings-pages.css'

function formatDate(timestamp?: number): string { return timestamp ? new Date(timestamp * 1000).toLocaleString() : '—' }
function statusLabel(status?: KnowledgeDocument['status']): string {
  return status === 'error' ? '错误' : status === 'processing' ? '处理中' : '已就绪'
}

const MAX_DOCUMENT_BYTES = MAX_KNOWLEDGE_DOCUMENT_BYTES
const documentBytes = knowledgeDocumentByteLength

/** Knowledge-base lifecycle, document ingestion and retrieval verification surface. */
export function KnowledgeSettingsView(): JSX.Element {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  return <KnowledgeSettingsContent key={source} source={source} />
}

function KnowledgeSettingsContent({ source }: { source: number }): JSX.Element {
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [selectedBase, setSelectedBase] = useState('')
  const [editingBase, setEditingBase] = useState(false)
  const [creatingBase, setCreatingBase] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importMode, setImportMode] = useState<'file' | 'text'>('file')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searched, setSearched] = useState(false)
  const [detailLoading, setDetailLoading] = useState('')
  const [editBaseName, setEditBaseName] = useState('')
  const [editBaseDescription, setEditBaseDescription] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [filename, setFilename] = useState('notes.txt')
  const [content, setContent] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KnowledgeSearchResult[]>([])
  const [detailDocument, setDetailDocument] = useState<KnowledgeDocument | null>(null)
  const [editingDocumentId, setEditingDocumentId] = useState('')
  const [editFilename, setEditFilename] = useState('')
  const [editContent, setEditContent] = useState('')
  const [busy, setBusy] = useState<'base' | 'document' | 'search' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [supportedFormats, setSupportedFormats] = useState(KNOWLEDGE_SUPPORTED_FORMATS)
  const [supportedExtensions, setSupportedExtensions] = useState<string[]>([])
  const [fileDragging, setFileDragging] = useState(false)
  // Keep an invalid file selection from falling through to an older textarea
  // value. The error is cleared as soon as the user edits or selects a valid
  // replacement.
  const [fileError, setFileError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const formId = useId()
  const fileInput = useRef<HTMLInputElement>(null)

  const refreshSequence = useRef(0)
  const detailRequest = useRef(0)
  const fileRequest = useRef(0)
  const mounted = useRef(true)
  const isCurrent = useCallback(() => mounted.current && source === getEngineSource(), [source])
  const refresh = useCallback(async (baseId = '') => {
    if (!isCurrent()) return
    const sequence = ++refreshSequence.current
    const sourceAtStart = getEngineSource()
    setRefreshing(true)
    try {
      const [nextBases, nextDocs] = await Promise.all([
        listKnowledgeBases(),
        listKnowledgeDocuments(baseId || undefined)
      ])
      if (!isCurrent() || sequence !== refreshSequence.current || sourceAtStart !== getEngineSource()) return
      setBases(nextBases)
      setDocuments(nextDocs)
      if (baseId && !nextBases.some(base => base.id === baseId)) {
        setSelectedBase('')
        setDetailDocument(null)
        setEditingDocumentId('')
      }
    } finally {
      if (isCurrent() && sequence === refreshSequence.current && sourceAtStart === getEngineSource()) setRefreshing(false)
    }
  }, [isCurrent])

  useEffect(() => subscribeResourceCatalogueChanges(['knowledge'], () => {
    void refresh(selectedBase).catch(reason => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) })
  }), [source, refresh, selectedBase, isCurrent])

  useEffect(() => {
    mounted.current = true
    void refresh('').catch((reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) })
    // Keep the format hint in sync with the active engine. Older remote engines
    // may not expose this endpoint, so the built-in list remains a safe fallback.
    void listKnowledgeFormats().then(value => {
      if (!isCurrent() || !value || !Array.isArray(value.extensions)) return
      const extensions = value.extensions.filter((item): item is string => typeof item === 'string' && item.startsWith('.'))
      if (extensions.length) setSupportedExtensions(extensions)
      if (typeof value.description === 'string' && value.description.trim()) setSupportedFormats(value.description)
    }).catch(() => { /* endpoint is optional for older engines */ })
    return () => {
      mounted.current = false
      refreshSequence.current += 1
      detailRequest.current += 1
      fileRequest.current += 1
    }
  }, [isCurrent, refresh])

  const selected = useMemo(() => bases.find(base => base.id === selectedBase) || null, [bases, selectedBase])
  const contentTooLarge = documentBytes(content) > MAX_DOCUMENT_BYTES
  const editContentTooLarge = documentBytes(editContent) > MAX_DOCUMENT_BYTES
  const documentContentEditable = detailDocument?.contentExact !== false
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (!isCurrent()) return
    setError('')
    setNotice('')
    try { await operation() } catch (reason: unknown) { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  const addBase = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy('base')
    await run(async () => {
      const created = await createKnowledgeBase({ name: trimmed, description: description.trim() })
      if (!isCurrent()) return
      setName('')
      setDescription('')
      setCreatingBase(false)
      setSelectedBase(created.id)
      await refresh(created.id)
      if (isCurrent()) setNotice('知识库已创建')
    })
    if (isCurrent()) setBusy(null)
  }

  const beginBaseEdit = (): void => {
    if (!selected) return
    setEditBaseName(selected.name)
    setEditBaseDescription(selected.description)
    setEditingBase(true)
    setError('')
  }

  const saveBaseEdit = async (): Promise<void> => {
    if (!selected || !editBaseName.trim() || busy) return
    setBusy('base')
    await run(async () => {
      await updateKnowledgeBase(selected.id, { name: editBaseName.trim(), description: editBaseDescription.trim() })
      if (!isCurrent()) return
      setEditingBase(false)
      await refresh(selected.id)
      if (isCurrent()) setNotice('知识库已更新')
    })
    if (isCurrent()) setBusy(null)
  }

  const removeBase = async (): Promise<void> => {
    if (!selected || busy) return
    const confirmed = await confirmDialog({
      title: '删除知识库？',
      body: '将删除“' + selected.name + '”及其中的文档和索引。',
      confirmText: '删除知识库',
      danger: true
    })
    if (!confirmed || !isCurrent()) return
    setBusy('base')
    await run(async () => {
      await deleteKnowledgeBase(selected.id)
      if (!isCurrent()) return
      setSelectedBase('')
      setDetailDocument(null)
      setEditingDocumentId('')
      await refresh('')
      if (isCurrent()) setNotice('知识库已删除')
    })
    if (isCurrent()) setBusy(null)
  }

  const readFile = async (file: File): Promise<void> => {
    const requestId = ++fileRequest.current
    setError('')
    setFileError('')
    try {
      if (file.size > MAX_KNOWLEDGE_UPLOAD_BYTES) throw new Error('上传文件不能超过 2 MiB')
      const text = await file.text()
      if (!isCurrent() || requestId !== fileRequest.current) return
      setSelectedFile(file)
      // Binary formats are extracted by the engine during multipart upload;
      // text files remain editable in the preview area.
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      const binary = ['.xlsx', '.xls', '.docx', '.doc', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'].includes(ext)
      if (binary) {
        setFilename(file.name)
        setContent('')
        setNotice('已选择文件，上传时由引擎提取文本并建立索引')
        return
      }
      validateKnowledgeDocumentText(text)
      setFilename(file.name)
      setContent(text)
      setNotice('已读取文件，点击上传并索引')
    } catch (reason: unknown) {
      if (isCurrent() && requestId === fileRequest.current) {
        // Do not leave an invalid text file armed for upload after validation
        // fails; otherwise the upload button would bypass the text-size guard.
        setSelectedFile(null)
        const message = reason instanceof Error ? reason.message : String(reason)
        setFileError(message)
        setError(message)
      }
    }
  }

  const upload = async (): Promise<void> => {
    if (!filename.trim() || busy || fileError) return
    if (!selectedFile) {
      try { validateKnowledgeDocumentText(content) } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); return }
    }
    setBusy('document')
    await run(async () => {
      if (selectedFile) await uploadKnowledgeFile(selectedFile, selectedBase || undefined)
      else await uploadKnowledgeDocument({ filename: filename.trim(), content, ...(selectedBase ? { knowledgeBaseId: selectedBase } : {}) })
      if (!isCurrent()) return
      setContent('')
      setSelectedFile(null)
      setImportOpen(false)
      await refresh(selectedBase)
      if (isCurrent()) setNotice('文档已加入索引')
    })
    if (isCurrent()) setBusy(null)
  }

  const removeDocument = async (document: KnowledgeDocument): Promise<void> => {
    if (busy) return
    const confirmed = await confirmDialog({
      title: '删除文档？',
      body: '将删除“' + document.filename + '”及其检索索引。',
      confirmText: '删除文档',
      danger: true
    })
    if (!confirmed || !isCurrent()) return
    setBusy('document')
    await run(async () => {
      await deleteKnowledgeDocument(document.id)
      if (!isCurrent()) return
      if (detailDocument?.id === document.id) {
        setDetailDocument(null)
        setEditingDocumentId('')
      }
      await refresh(selectedBase)
      if (isCurrent()) setNotice('文档已删除')
    })
    if (isCurrent()) setBusy(null)
  }

  const showDocument = async (document: KnowledgeDocument, edit = false): Promise<void> => {
    const requestId = ++detailRequest.current
    const sourceAtStart = getEngineSource()
    setError('')
    setDetailLoading(document.id)
    try {
      const detail = await getKnowledgeDocument(document.id)
      if (!isCurrent() || requestId !== detailRequest.current || sourceAtStart !== getEngineSource()) return
      setDetailDocument(detail)
      setEditingDocumentId(edit ? detail.id : '')
      if (edit) {
        setEditingDocumentId(detail.id)
        setEditFilename(detail.filename)
        setEditContent(detail.content ?? '')
      }
    } catch (reason: unknown) { if (isCurrent() && requestId === detailRequest.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (isCurrent() && requestId === detailRequest.current) setDetailLoading('') }
  }

  const saveDocumentEdit = async (): Promise<void> => {
    if (!editingDocumentId || !editFilename.trim() || busy) return
    const contentEditable = documentContentEditable
    if (contentEditable) {
      try { validateKnowledgeDocumentText(editContent) } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); return }
    }
    setBusy('document')
    await run(async () => {
      const updated = await updateKnowledgeDocument(editingDocumentId, { filename: editFilename.trim(), ...(contentEditable ? { content: editContent } : {}) })
      if (!isCurrent()) return
      setDetailDocument(updated)
      setEditingDocumentId('')
      await refresh(selectedBase)
      if (isCurrent()) setNotice('文档已更新并重新建立索引')
    })
    if (isCurrent()) setBusy(null)
  }

  const search = async (): Promise<void> => {
    if (!query.trim() || busy) return
    setBusy('search')
    await run(async () => {
      const next = await searchKnowledge(query, 8, selectedBase ? [selectedBase] : undefined)
      if (isCurrent()) { setResults(next); setSearched(true) }
    })
    if (isCurrent()) setBusy(null)
  }

  const closeDocument = (): void => { detailRequest.current++; setDetailDocument(null); setEditingDocumentId(''); setError('') }
  const modalOpen = creatingBase || editingBase || importOpen || searchOpen || Boolean(detailDocument)
  const importDisabled = busy !== null || Boolean(fileError) || (importMode === 'file' ? !selectedFile : !filename.trim() || !content.trim() || contentTooLarge)
  const beginImport = (): void => { setError(''); setNotice(''); setImportOpen(true) }
  return (
    <div className="settings-view settings-view--knowledge resource-settings">
      <div className="knowledge-library-bar">
        <div className="knowledge-library-bar__selection"><Icon name="library" size={17} />
          <Select ariaLabel="当前知识库" value={selectedBase} disabled={busy !== null} onChange={next => {
            detailRequest.current++; setDetailLoading(''); setSelectedBase(next); setDetailDocument(null); setEditingDocumentId(''); setResults([]); setSearched(false)
            void run(() => refresh(next))
          }} options={[{ value: '', label: '全部知识库' }, ...bases.map(base => ({ value: base.id, label: base.name }))]} />
        </div>
        <div className="resource-toolbar">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => { setError(''); setCreatingBase(true) }}><Icon name="plus" size={14} />新建知识库</button>
          {selected ? <ResourceSettingsMenu label={selected.name} disabled={busy !== null} actions={[
            { label: '编辑知识库', icon: 'pencil', onSelect: beginBaseEdit },
            { label: '删除知识库', icon: 'trash', danger: true, onSelect: () => void removeBase() }
          ]} /> : null}
        </div>
      </div>
      {selected?.description ? <p className="knowledge-library-description">{selected.description}</p> : null}
      <section aria-label="知识库文档">
        <ResourceSettingsHeader title="文档" count={documents.length} description={selected ? selected.name : '查看和管理所有知识库文档'}>
          <button type="button" className="resource-icon-button" title="刷新" aria-label="刷新知识库" disabled={busy !== null || refreshing} onClick={() => void run(() => refresh(selectedBase))}>
            {refreshing ? <Spinner size={15} /> : <Icon name="refresh" size={16} />}
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => { setError(''); setSearchOpen(true) }}><Icon name="search" size={14} />检索测试</button>
          <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={beginImport}><Icon name="plus" size={14} />导入文档</button>
        </ResourceSettingsHeader>
        {!modalOpen && error ? <div className="resource-feedback is-error" role="alert">{error}</div> : null}
        {!modalOpen && notice ? <div className="resource-feedback is-success" role="status"><Icon name="check" size={14} />{notice}</div> : null}
        <div className="resource-list knowledge-documents" aria-label="知识库文档列表" aria-busy={refreshing}>
          {documents.length === 0 ? <ResourceSettingsEmpty icon="book-open" loading={refreshing} title={refreshing ? '正在读取文档…' : '暂无文档'} description={refreshing ? undefined : '导入文件或文本，建立可检索的资料。'} /> : documents.map(document => (
            <article className="resource-row knowledge-document" key={document.id} aria-label={document.filename}>
              <button type="button" className="resource-row__main" disabled={busy !== null} onClick={() => void showDocument(document)} aria-label={'查看 ' + document.filename}>
                <span className="resource-row__icon"><FileGlyph name={document.filename} mimeType={document.contentType} size={21} /></span>
                <span className="resource-row__copy"><strong>{document.filename}</strong>
                  <span className="resource-row__meta"><span className={document.status === 'error' ? 'knowledge-document__error' : undefined}>{statusLabel(document.status)}</span><span>{document.chunkCount} 个片段</span><span>{formatDate(document.createdAt)}</span></span>
                </span>
              </button>
              <div className="resource-row__actions">
                {detailLoading === document.id ? <Spinner size={15} /> : null}
                <ResourceSettingsMenu label={document.filename} disabled={busy !== null} actions={[
                  { label: '查看详情', icon: 'eye-outline', onSelect: () => void showDocument(document) },
                  { label: '编辑', icon: 'pencil', onSelect: () => void showDocument(document, true) },
                  { label: '删除', icon: 'trash', danger: true, onSelect: () => void removeDocument(document) }
                ]} />
              </div>
            </article>
          ))}
        </div>
      </section>

      {creatingBase || editingBase ? <Dialog title={editingBase ? '编辑知识库' : '新建知识库'} width={520} className="resource-editor knowledge-base-editor" closeDisabled={busy !== null}
        onClose={() => { setCreatingBase(false); setEditingBase(false); setError('') }}
        footer={<><button type="button" className="btn" disabled={busy !== null} onClick={() => { setCreatingBase(false); setEditingBase(false); setError('') }}>取消</button>
          <button type="submit" form={formId + '-base'} className="btn btn--primary" disabled={busy !== null || !(editingBase ? editBaseName : name).trim()}>{busy === 'base' ? '保存中…' : editingBase ? '保存知识库' : '创建知识库'}</button></>}>
        <form id={formId + '-base'} className="resource-form" onSubmit={event => { event.preventDefault(); void (editingBase ? saveBaseEdit() : addBase()) }}>
          <ResourceSettingsField label="名称" wide><input className="field__input" autoFocus value={editingBase ? editBaseName : name} disabled={busy !== null}
            onChange={event => editingBase ? setEditBaseName(event.target.value) : setName(event.target.value)} placeholder="例如：项目资料" aria-label={editingBase ? '编辑知识库名称' : '知识库名称'} /></ResourceSettingsField>
          <ResourceSettingsField label="描述 · 可选" wide><textarea className="field__input" value={editingBase ? editBaseDescription : description} disabled={busy !== null}
            onChange={event => editingBase ? setEditBaseDescription(event.target.value) : setDescription(event.target.value)} rows={3} placeholder="简要说明资料的用途" aria-label={editingBase ? '编辑知识库描述' : '知识库描述'} /></ResourceSettingsField>
          {error ? <div className="resource-feedback is-error knowledge-form-feedback" role="alert">{error}</div> : null}
        </form>
      </Dialog> : null}

      {importOpen ? <Dialog title="导入文档" width={640} className="resource-editor knowledge-import-editor" closeDisabled={busy !== null} onClose={() => { setImportOpen(false); setFileDragging(false); setError('') }}
        footer={<><button type="button" className="btn" disabled={busy !== null} onClick={() => { setImportOpen(false); setFileDragging(false); setError('') }}>取消</button>
          <button type="button" className="btn btn--primary" disabled={importDisabled} onClick={() => void upload()}>{busy === 'document' ? '索引中…' : '上传并索引'}</button></>}>
        <div className="knowledge-import">
          <div className="knowledge-import__heading"><Segmented value={importMode} disabled={busy !== null} options={[{ value: 'file', label: '文件' }, { value: 'text', label: '文本' }]}
            onChange={mode => { setImportMode(mode); setError(''); setFileError(''); if (mode === 'text') setSelectedFile(null) }} />
            <span title={selected?.name ?? '未归属知识库'}>保存到：{selected?.name ?? '未归属知识库'}</span></div>
          {importMode === 'file' ? <>
            <div className={'knowledge-file-drop' + (fileDragging ? ' is-dragging' : '')}
              onDragEnter={event => { event.preventDefault(); if (!busy) setFileDragging(true) }}
              onDragOver={event => { event.preventDefault(); if (!busy) setFileDragging(true) }}
              onDragLeave={event => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFileDragging(false) }}
              onDrop={event => { event.preventDefault(); setFileDragging(false); const file = event.dataTransfer.files?.[0]; if (file && !busy) void readFile(file) }}>
              <span className="knowledge-file-drop__icon">{selectedFile ? <FileGlyph name={selectedFile.name} mimeType={selectedFile.type} size={30} /> : <Icon name="upload-outline" size={28} />}</span>
              <div className="knowledge-file-drop__copy"><strong>{selectedFile ? selectedFile.name : '拖拽文件到这里'}</strong><span>{selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB · 待上传` : '文档、表格、图片或文本文件'}</span></div>
              <button type="button" className="btn" disabled={busy !== null} onClick={() => fileInput.current?.click()}>{selectedFile ? '更换文件' : '选择文件'}</button>
              <input ref={fileInput} className="knowledge-file-input" type="file" disabled={busy !== null}
                accept={supportedExtensions.length ? supportedExtensions.join(',') : '.txt,.md,.markdown,.json,.html,.htm,.xml,.svg,.csv,.ts,.tsx,.js,.jsx,.py,.go,.java,.c,.cpp,.h,.hpp,.rs,.css,.scss,.less,.sh,.yaml,.yml,.toml,.ini,.lock,.log,.xlsx,.xls,.docx,.doc,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tiff'}
                onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void readFile(file) }} aria-label="选择文档文件" />
            </div>
            <details className="resource-disclosure knowledge-formats"><summary>支持的文件格式</summary><p>{supportedFormats}</p></details>
          </> : <div className="resource-form">
            <ResourceSettingsField label="文件名" wide><input className="field__input" value={filename} disabled={busy !== null} onChange={event => setFilename(event.target.value)} placeholder="例如：notes.txt" aria-label="文档文件名" /></ResourceSettingsField>
            <ResourceSettingsField label="正文" wide><textarea className="field__input knowledge-content-editor" value={content} disabled={busy !== null} onChange={event => { setFileError(''); setSelectedFile(null); setContent(event.target.value) }} placeholder="粘贴或输入文档内容" aria-label="文档内容" rows={9} /></ResourceSettingsField>
            <div className="knowledge-size-hint">{(documentBytes(content) / 1024).toFixed(1)} / {MAX_DOCUMENT_BYTES / 1024} KB</div>
            {contentTooLarge ? <div className="resource-feedback is-error knowledge-form-feedback" role="alert">文档正文不能超过 1 MiB</div> : null}
          </div>}
          {error ? <div className="resource-feedback is-error" role="alert">{error}</div> : null}
        </div>
      </Dialog> : null}

      {/* A mode switch must replace the action node so the edit click cannot submit the newly mounted form. */}
      {detailDocument ? <Dialog title={editingDocumentId ? '编辑文档' : '文档详情'} width={720} className="resource-editor knowledge-detail-editor" closeDisabled={busy !== null} onClose={closeDocument}
        footer={editingDocumentId ? <><button type="button" className="btn" disabled={busy !== null} onClick={() => { setEditingDocumentId(''); setError('') }}>取消</button>
          <button key="save-document" type="submit" form={formId + '-document'} className="btn btn--primary" disabled={!editFilename.trim() || (documentContentEditable && (!editContent.trim() || editContentTooLarge)) || busy !== null}>{busy === 'document' ? '保存中…' : '保存文档'}</button></> :
          <><button type="button" className="btn" onClick={closeDocument}>关闭</button><button key="edit-document" type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => { setEditingDocumentId(detailDocument.id); setEditFilename(detailDocument.filename); setEditContent(detailDocument.content ?? ''); setError('') }}>编辑文档</button></>}>
        {editingDocumentId ? <form id={formId + '-document'} className="resource-form" onSubmit={event => { event.preventDefault(); void saveDocumentEdit() }}>
          <ResourceSettingsField label="文件名" wide><input className="field__input" value={editFilename} disabled={busy !== null} onChange={event => setEditFilename(event.target.value)} aria-label="编辑文档文件名" autoFocus /></ResourceSettingsField>
          <ResourceSettingsField label="正文" wide><textarea className="field__input knowledge-content-editor" value={editContent} disabled={!documentContentEditable || busy !== null} onChange={event => setEditContent(event.target.value)} aria-label="编辑文档内容" placeholder={documentContentEditable ? '文档正文' : '此文件未保存原文，仅支持修改文件名'} rows={12} /></ResourceSettingsField>
          <div className="knowledge-size-hint">{documentContentEditable ? `${(documentBytes(editContent) / 1024).toFixed(1)} / ${MAX_DOCUMENT_BYTES / 1024} KB` : '此文档未保存原文，可修改文件名。'}</div>
          {documentContentEditable && editContentTooLarge ? <div className="resource-feedback is-error knowledge-form-feedback" role="alert">文档正文不能超过 1 MiB</div> : null}
          {error ? <div className="resource-feedback is-error knowledge-form-feedback" role="alert">{error}</div> : null}
        </form> : <div className="knowledge-document-detail">
          <div className="knowledge-document-detail__heading"><FileGlyph name={detailDocument.filename} mimeType={detailDocument.contentType} size={28} /><div><strong>{detailDocument.filename}</strong><span>{detailDocument.contentType} · {detailDocument.chunkCount} 个片段 · {statusLabel(detailDocument.status)}</span></div></div>
          {detailDocument.error ? <div className="resource-feedback is-error" role="alert">{detailDocument.error}</div> : null}
          <pre className="knowledge-document-detail__content">{detailDocument.content ?? '暂无原文'}</pre>
          <div className="knowledge-document-detail__meta"><span>创建于 {formatDate(detailDocument.createdAt)}</span><span>{detailDocument.contentExact === false ? '原文不可用' : '原文已保存'}</span></div>
          {error ? <div className="resource-feedback is-error" role="alert">{error}</div> : null}
        </div>}
      </Dialog> : null}

      {searchOpen ? <Dialog title="检索测试" width={640} className="resource-editor knowledge-search-dialog" closeDisabled={busy !== null} onClose={() => { setSearchOpen(false); setError('') }}
        footer={<button type="button" className="btn" disabled={busy !== null} onClick={() => { setSearchOpen(false); setError('') }}>关闭</button>}>
        <form className="knowledge-search__bar" onSubmit={event => { event.preventDefault(); void search() }}>
          <input className="field__input" value={query} disabled={busy !== null} onChange={event => setQuery(event.target.value)} placeholder="输入问题或关键词" aria-label="知识库检索关键词" autoFocus />
          <button type="submit" className="btn btn--primary" disabled={!query.trim() || busy !== null}>{busy === 'search' ? '检索中…' : '检索'}</button>
        </form>
        <p className="knowledge-search__context">检索范围：{selected?.name ?? '全部知识库'}</p>
        {error ? <div className="resource-feedback is-error" role="alert">{error}</div> : null}
        {results.length === 0 ? <ResourceSettingsEmpty icon="search" loading={busy === 'search'} title={busy === 'search' ? '正在检索…' : searched ? '未找到相关内容' : '输入关键词开始检索'} description={searched ? '可以尝试其他词语或切换知识库。' : '查看资料中的相关片段。'} /> : <div className="knowledge-results" aria-label="知识库检索结果">{results.map(result => <article className="knowledge-result" key={result.chunkId}><div><FileGlyph name={result.filename} size={16} /><strong>{result.filename}</strong><span>片段 {result.chunkIndex + 1}</span></div><p>{result.content}</p></article>)}</div>}
      </Dialog> : null}
    </div>
  )
}
