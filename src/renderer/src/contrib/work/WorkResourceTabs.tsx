import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { FileGlyph } from '../explorer/FileGlyph'
import { browserAction, initializeBrowser, selectBrowserTab, useBrowserState } from '../browser/browser-store'
import { closeWorkResource, openExternalWorkFileResource, resolvedWorkResourceId, selectWorkResource, useWorkResources, workResourceBrowserTabs } from './work-resource-store'
import { engineConnectionKey, getEngineSource, getEngineStorageKey, getExpectedEngine } from '@renderer/core/engine/source'
import { getAppMode } from '@renderer/core/platform/app-mode'
import { getWorkState } from './work-state'
import { toast } from '@renderer/core/toast'
import './work-resource-tabs.css'

export function WorkResourceTabs({ sessionId, active, onSelect }: {
  sessionId: string; active: boolean; onSelect: () => void
}): JSX.Element {
  const resources = useWorkResources(sessionId)
  const browser = useBrowserState()
  const webTabs = workResourceBrowserTabs(browser.tabs, sessionId)
  const files = resources.files.map(file => ({ id: file.id, name: file.name, title: file.path, file: true }))
  const tabs = [...files, ...webTabs.map(tab => ({ id: `web:${tab.tabId}`, name: tab.title || (tab.url === 'about:blank' ? '新网页' : tab.url), title: tab.url, file: false }))]
  const selected = resolvedWorkResourceId(resources, webTabs.map(tab => tab.tabId), browser.activeTabId)
  const order = useRef<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  // Preserve opening order across title/loading updates, including interleaved
  // web and file tabs. Streamed agent progress must not reshuffle this strip.
  order.current = [...order.current.filter(id => tabs.some(tab => tab.id === id)), ...tabs.map(tab => tab.id).filter(id => !order.current.includes(id))]
  const ordered = order.current.map(id => tabs.find(tab => tab.id === id)!)
  useEffect(() => { void initializeBrowser() }, [])
  const activate = (id: string): void => {
    if (id.startsWith('web:')) selectBrowserTab(id.slice(4))
    selectWorkResource(sessionId, id)
    onSelect()
  }
  const openFiles = (files: readonly File[]): void => {
    const candidate = files.find(file => file.size >= 0 && file.name)
    if (!candidate) return
    try {
      openExternalWorkFileResource(candidate, sessionId)
      onSelect()
    } catch (error) {
      // Keep the strip usable when a capacity guard rejects a drop, while still
      // giving the user an actionable reason instead of silently discarding it.
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
    openFiles(Array.from(event.dataTransfer.files))
  }
  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    openFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ''
  }
  return <div className={`work-resource-tabs${dragging ? ' is-dragging' : ''}`} role="tablist" aria-label="打开的资源"
    onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true) } }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false) }}
    onDrop={onDrop}>
    {ordered.map((tab, index) => <div className="work-resource-tab" key={tab.id} data-active={active && selected === tab.id}>
      <button type="button" role="tab" aria-selected={active && selected === tab.id} aria-controls="work-panel-browser"
        tabIndex={selected === tab.id || (!selected && index === 0) ? 0 : -1} title={tab.title}
        onClick={() => activate(tab.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % ordered.length : event.key === 'ArrowLeft' ? (index - 1 + ordered.length) % ordered.length : event.key === 'Home' ? 0 : event.key === 'End' ? ordered.length - 1 : -1
          if (next < 0) return
          event.preventDefault()
          activate(ordered[next].id)
          event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}>
        {tab.file ? <FileGlyph name={tab.name} size={15} /> : <Icon name="eye-outline" size={15} />}
        <span>{tab.name}</span>
      </button>
      <button type="button" className="work-resource-tab__close" aria-label={`关闭${tab.file ? '文档' : '网页'} ${tab.name}`} onClick={() => {
        if (tab.file) closeWorkResource(sessionId, tab.id)
        else browserAction(async () => {
          const source = getEngineSource()
          await window.aether.browser.close(tab.id.slice(4))
          if (source !== getEngineSource() || getAppMode() !== 'work' || getWorkState(getEngineStorageKey()).activeTaskId !== sessionId) return
          if (resources.selected === tab.id) closeWorkResource(sessionId, tab.id)
        })
      }}><Icon name="close" size={12} /></button>
    </div>)}
    {!ordered.length && <span className="work-resource-tabs__hint">打开文件或网页，在这里查看</span>}
    <button type="button" className="work-resource-tabs__new" aria-label="打开文件" title="打开电脑上的文件" onClick={() => fileInput.current?.click()}>
      <Icon name="file" size={15} />
    </button>
    <input ref={fileInput} type="file" className="work-resource-tabs__file-input" aria-hidden="true" tabIndex={-1} onChange={onPick} />
    <button type="button" className="work-resource-tabs__new" aria-label="新建网页" title="新建网页" onClick={() => browserAction(async () => {
      const source = getEngineSource()
      const current = (): boolean => source === getEngineSource() && getAppMode() === 'work' && getWorkState(getEngineStorageKey()).activeTaskId === sessionId
      const expectedId = engineConnectionKey({ ...getExpectedEngine(), phase: 'ready' })
      const connection = await window.aether.browser.getConnection()
      if (!current()) return
      if (connection.sessionId !== sessionId || connection.engineId !== expectedId) throw new Error('正在连接此会话的浏览器，请稍后重试。')
      const tab = await window.aether.browser.create({})
      if (!current() || tab.context?.sessionId !== sessionId || tab.context.engineId !== expectedId) return
      activate(`web:${tab.tabId}`)
    })}><Icon name="plus" size={16} /></button>
    {dragging && <span className="work-resource-tabs__drop-hint" role="status">松开即可打开文件</span>}
  </div>
}
