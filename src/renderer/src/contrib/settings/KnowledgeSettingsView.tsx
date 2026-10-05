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
  validateKnowledgeDocumentText,
  searchKnowledge,
  updateKnowledgeBase,
  updateKnowledgeDocument,
  uploadKnowledgeDocument,
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
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KnowledgeSearchResult[]>([])
  const [detailDocument, setDetailDocument] = useState<KnowledgeDocument | null>(null)
  const [editingDocumentId, setEditingDocumentId] = useState('')
  const [editFilename, setEditFilename] = useState('')
  const [editContent, setEditContent] = useState('')
  const [busy, setBusy] = useState<'base' | 'document' | 'search' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refreshSequence = useRef(0)
  const detailRequest = useRef(0)
  const fileRequest = useRef(0)
  const mounted = useRef(true)
  const isCurrent = useCallback(() => mounted.current && source === getEngineSource(), [source])
  const refresh = useCallback(async (baseId = '') => {
    if (!isCurrent()) return
    const sequence = ++refreshSequence.current
    const sourceAtStart = getEngineSource()
    const [nextBases, nextDocs] = await Promise.all([
      listKnowledgeBases(),
      listKnowledgeDocuments(baseId || undefined)
    ])
    if (!isCurrent() || sequence !== refreshSequence.current || sourceAtStart !== getEngineSource()) return
    setBases(nextBases)
    setDocuments(nextDocs)
    if (baseId && !nextBases.some(base => base.id === baseId)) setSelectedBase('')
  }, [isCurrent])

  useEffect(() => {
    mounted.current = true
    void refresh('').catch((reason: unknown) => { if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason)) })
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
    try {
      if (file.size > MAX_DOCUMENT_BYTES) throw new Error('文档正文不能超过 1 MiB')
      const text = await file.text()
      if (!isCurrent() || requestId !== fileRequest.current) return
      validateKnowledgeDocumentText(text)
      setFilename(file.name)
      setContent(text)
      setNotice('已读取文件，点击上传并索引')
    } catch (reason: unknown) { if (isCurrent() && requestId === fileRequest.current) setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  const upload = async (): Promise<void> => {
    if (!filename.trim() || busy) return
    try { validateKnowledgeDocumentText(content) } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); return }
    setBusy('document')
    await run(async () => {
      await uploadKnowledgeDocument({
        filename: filename.trim(),
        content,
        ...(selectedBase ? { knowledgeBaseId: selectedBase } : {})
      })
      if (!isCurrent()) return
      setContent('')
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
    try { validateKnowledgeDocumentText(editContent) } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); return }
    setBusy('document')
    await run(async () => {
      const updated = await updateKnowledgeDocument(editingDocumentId, { filename: editFilename.trim(), content: editContent })
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
            <select id="knowledge-base-select" className="field__input" value={selectedBase} onChange={event => { setSelectedBase(event.target.value); setDetailDocument(null); setEditingDocumentId(''); void refresh(event.target.value) }}>
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
            <input type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.xml" onChange={event => { const file = event.target.files?.[0]; if (file) void readFile(file) }} aria-label="选择文档文件" />
            <textarea className="field__input knowledge-upload__textarea" value={content} onChange={event => setContent(event.target.value)} placeholder="粘贴文档文本" aria-label="文档内容" rows={6} />
            <div className="knowledge-size-hint">{documentBytes(content)} / {MAX_DOCUMENT_BYTES} bytes</div>
            {contentTooLarge ? <div className="knowledge-validation-error" role="alert">文档正文不能超过 1 MiB</div> : null}
            <button type="button" className="btn btn--primary" disabled={!filename.trim() || !content.trim() || contentTooLarge || busy !== null} onClick={() => void upload()}>{busy === 'document' ? '索引中…' : '上传并索引'}</button>
          </div>
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
            <textarea className="field__input knowledge-upload__textarea" value={editContent} onChange={event => setEditContent(event.target.value)} aria-label="编辑文档内容" rows={8} />
            <div className="knowledge-size-hint">{documentBytes(editContent)} / {MAX_DOCUMENT_BYTES} bytes</div>
            {editContentTooLarge ? <div className="knowledge-validation-error" role="alert">文档正文不能超过 1 MiB</div> : null}
            <div className="knowledge-meta-actions"><button type="button" className="btn btn--primary" disabled={!editFilename.trim() || !editContent.trim() || editContentTooLarge || busy !== null} onClick={() => void saveDocumentEdit()}>{busy === 'document' ? '保存中…' : '保存文档'}</button><button type="button" className="btn" disabled={busy !== null} onClick={() => setEditingDocumentId('')}>取消</button></div>
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

