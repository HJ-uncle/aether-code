import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
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
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { SettingsContent, SettingsGroup, SettingsRow } from './SettingsGroup'
import './knowledge-settings.css'

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
  // Keep an invalid file selection from falling through to an older textarea
  // value. The error is cleared as soon as the user edits or selects a valid
  // replacement.
  const [fileError, setFileError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

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
      if (isCurrent()) setResults(next)
    })
    if (isCurrent()) setBusy(null)
  }

  return (
    <div className="settings-view settings-view--knowledge">
      <SettingsGroup title="知识库" footer="知识库按引擎租户隔离；文档会切块并建立全文检索索引。">
        <SettingsContent className="knowledge-toolbar">
          <div className="knowledge-toolbar__fields">
            <input className="field__input" value={name} onChange={event => setName(event.target.value)} placeholder="新知识库名称" aria-label="知识库名称" />
            <input className="field__input" value={description} onChange={event => setDescription(event.target.value)} placeholder="描述（可选）" aria-label="知识库描述" />
            <button type="button" className="btn btn--primary" disabled={!name.trim() || busy !== null} onClick={() => void addBase()}>{busy === 'base' ? '保存中…' : '新建知识库'}</button>
          </div>
          <div className="knowledge-toolbar__base">
            <label htmlFor="knowledge-base-select">当前知识库</label>
            <select id="knowledge-base-select" className="field__input" value={selectedBase} onChange={event => { const next = event.target.value; setSelectedBase(next); setDetailDocument(null); setEditingDocumentId(''); setResults([]); void refresh(next) }}>
              <option value="">全部知识库</option>
              {bases.map(base => <option key={base.id} value={base.id}>{base.name}</option>)}
            </select>
            <button type="button" className="btn btn--danger-ghost" disabled={!selected || busy !== null} onClick={() => void removeBase()}>删除</button>
          </div>
        </SettingsContent>
        {selected ? <SettingsRow label="当前知识库" description={selected.description || '没有描述'}>
          {editingBase ? <div className="knowledge-edit-form">
            <input className="field__input" value={editBaseName} onChange={event => setEditBaseName(event.target.value)} aria-label="编辑知识库名称" />
            <input className="field__input" value={editBaseDescription} onChange={event => setEditBaseDescription(event.target.value)} aria-label="编辑知识库描述" />
            <button type="button" className="btn btn--primary" disabled={!editBaseName.trim() || busy !== null} onClick={() => void saveBaseEdit()}>{busy === 'base' ? '保存中…' : '保存知识库'}</button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => setEditingBase(false)}>取消</button>
          </div> : <div className="knowledge-meta-actions"><span className="knowledge-meta">{selected.documentCount ?? documents.length} 篇文档</span><button type="button" className="btn" disabled={busy !== null} onClick={beginBaseEdit}>编辑知识库</button></div>}
        </SettingsRow> : null}
      </SettingsGroup>

      <SettingsGroup title="文档">
        <SettingsContent className="knowledge-upload">
          <div className="knowledge-upload__fields">
            <input className="field__input" value={filename} onChange={event => setFilename(event.target.value)} placeholder="文件名" aria-label="文档文件名" />
            <label className="knowledge-file-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void readFile(file) }}>
              <span className="knowledge-file-drop__title">拖拽文件到这里</span>
              <span className="knowledge-file-drop__hint">或</span>
              <span role="button" tabIndex={0} className="btn knowledge-file-drop__button" onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.closest('label')?.querySelector<HTMLInputElement>('input[type="file"]')?.click() } }}>选择文件</span>
              {selectedFile ? <span className="knowledge-file-drop__selected" title={selectedFile.name}>已选择：{selectedFile.name}</span> : null}
              <input className="knowledge-file-input" type="file" accept={supportedExtensions.length ? supportedExtensions.join(',') : '.txt,.md,.markdown,.json,.html,.htm,.xml,.svg,.csv,.ts,.tsx,.js,.jsx,.py,.go,.java,.c,.cpp,.h,.hpp,.rs,.css,.scss,.less,.sh,.yaml,.yml,.toml,.ini,.lock,.log,.xlsx,.xls,.docx,.doc,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tiff'} onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void readFile(file) }} aria-label="选择文档文件" />
            </label>
            <details className="knowledge-formats"><summary>支持的文件格式</summary><p>{supportedFormats}</p></details>
            <textarea className="field__input knowledge-upload__textarea" value={content} onChange={event => { setFileError(''); setSelectedFile(null); setContent(event.target.value) }} placeholder="粘贴文档文本" aria-label="文档内容" rows={6} />
            <div className="knowledge-size-hint">{documentBytes(content)} / {MAX_DOCUMENT_BYTES} bytes</div>
            {contentTooLarge ? <div className="knowledge-validation-error" role="alert">文档正文不能超过 1 MiB</div> : null}
            <button type="button" className="btn btn--primary" disabled={Boolean(fileError) || !filename.trim() || (!content.trim() && !selectedFile) || contentTooLarge || busy !== null} onClick={() => void upload()}>{busy === 'document' ? '索引中…' : '上传并索引'}</button>
          </div>
        </SettingsContent>
        <SettingsContent className="knowledge-document-summary">
          <div><strong>{selected ? `“${selected.name}”中的文档` : '全部知识库文档'}</strong><span>{documents.length} 篇 · {refreshing ? '同步中…' : '已同步'}</span></div>
          <button type="button" className="btn" disabled={busy !== null || refreshing} onClick={() => void refresh(selectedBase)}>刷新</button>
        </SettingsContent>
        <div className="knowledge-documents" aria-label="知识库文档列表">
          {documents.length === 0 ? <div className="knowledge-empty">暂无文档</div> : documents.map(document => (
            <div className="knowledge-document" key={document.id}>
              <div><strong>{document.filename}</strong><span>{document.chunkCount} 个片段 · {statusLabel(document.status)} · {formatDate(document.createdAt)}</span></div>
              <div className="knowledge-document__actions">
                <button type="button" className="btn" disabled={busy !== null} onClick={() => void showDocument(document)}>详情</button>
                <button type="button" className="btn" disabled={busy !== null} onClick={() => void showDocument(document, true)}>编辑</button>
                <button type="button" className="btn btn--danger-ghost" disabled={busy !== null} onClick={() => void removeDocument(document)}>删除</button>
              </div>
            </div>
          ))}
        </div>
        {detailDocument ? <div className="knowledge-document-detail" aria-label="文档详情">
          <div className="knowledge-document-detail__heading"><strong>{editingDocumentId ? '编辑文档' : '文档详情'}</strong><button type="button" className="btn" onClick={() => { detailRequest.current += 1; setDetailDocument(null); setEditingDocumentId('') }}>关闭</button></div>
          {editingDocumentId ? <div className="knowledge-edit-form">
            <input className="field__input" value={editFilename} onChange={event => setEditFilename(event.target.value)} aria-label="编辑文档文件名" />
            <textarea className="field__input knowledge-upload__textarea" value={editContent} disabled={!documentContentEditable} onChange={event => setEditContent(event.target.value)} aria-label="编辑文档内容" placeholder={documentContentEditable ? '文档正文' : '此文件未保存原文，仅支持修改文件名'} rows={8} />
            <div className="knowledge-size-hint">{documentBytes(editContent)} / {MAX_DOCUMENT_BYTES} bytes</div>
            {editContentTooLarge ? <div className="knowledge-validation-error" role="alert">文档正文不能超过 1 MiB</div> : null}
            <div className="knowledge-meta-actions"><button type="button" className="btn btn--primary" disabled={!editFilename.trim() || (documentContentEditable && !editContent.trim()) || (documentContentEditable && editContentTooLarge) || busy !== null} onClick={() => void saveDocumentEdit()}>{busy === 'document' ? '保存中…' : '保存文档'}</button><button type="button" className="btn" disabled={busy !== null} onClick={() => setEditingDocumentId('')}>取消</button></div>
          </div> : <div className="knowledge-document-detail__body"><div><strong>{detailDocument.filename}</strong><span>{detailDocument.contentType} · {detailDocument.chunkCount} 个片段 · {detailDocument.contentExact === false ? '原文不可用' : '原文已保存'}</span></div><pre>{detailDocument.content ?? '暂无原文'}</pre><button type="button" className="btn" disabled={busy !== null} onClick={() => { setEditingDocumentId(detailDocument.id); setEditFilename(detailDocument.filename); setEditContent(detailDocument.content ?? '') }}>编辑文档</button></div>}
        </div> : null}
      </SettingsGroup>

      <SettingsGroup title="检索测试" footer="测试查询只返回所选知识库中的片段，不会写入对话。">
        <SettingsContent className="knowledge-search">
          <div className="knowledge-search__bar">
            <input className="field__input" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search() }} placeholder="输入问题或关键词" aria-label="知识库检索关键词" />
            <button type="button" className="btn" disabled={!query.trim() || busy !== null} onClick={() => void search()}>{busy === 'search' ? '检索中…' : '检索'}</button>
          </div>
          {results.length === 0 ? <div className="knowledge-empty">输入关键词查看命中片段</div> : <div className="knowledge-results">{results.map(result => <article className="knowledge-result" key={result.chunkId}><strong>{result.filename}</strong><span>{result.content}</span></article>)}</div>}
        </SettingsContent>
      </SettingsGroup>
      {error ? <div className="settings-view__error" role="alert">{error}</div> : null}
      {notice ? <div className="knowledge-notice" role="status">{notice}</div> : null}
    </div>
  )
}

