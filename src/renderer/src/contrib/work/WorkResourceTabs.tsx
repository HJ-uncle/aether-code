import { useEffect, useRef, type ChangeEvent, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'
import { browserAction, initializeBrowser, selectBrowserTab } from '../browser/browser-store'
import { openExternalWorkFileResource, selectWorkResource } from './work-resource-store'
import { engineConnectionKey, getEngineSource, getEngineStorageKey, getExpectedEngine } from '@renderer/core/engine/source'
import { getAppMode } from '@renderer/core/platform/app-mode'
import { getWorkState } from './work-state'
import { toast } from '@renderer/core/toast'
import './work-resource-tabs.css'

/**
 * Actions for creating resource entries in Work's unified tab strip.
 *
 * Resource tabs themselves are rendered by WorkView alongside surface tabs.
 * Keeping this component action-only prevents a second resource tab model from
 * reappearing when the strip layout changes.
 */
export function WorkResourceTabs({ sessionId, onSelect }: {
  sessionId: string
  onSelect: () => void
}): JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => { void initializeBrowser() }, [])

  const openFiles = (files: readonly File[]): void => {
    const candidate = files.find(file => file.size >= 0 && file.name)
    if (!candidate) return
    try {
      openExternalWorkFileResource(candidate, sessionId)
      onSelect()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    openFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ''
  }
  const openBrowser = (): void => {
    void browserAction(async () => {
      const source = getEngineSource()
      const current = (): boolean => source === getEngineSource() && getAppMode() === 'work' && getWorkState(getEngineStorageKey()).activeTaskId === sessionId
      const expectedId = engineConnectionKey({ ...getExpectedEngine(), phase: 'ready' })
      const connection = await window.aether.browser.getConnection()
      if (!current()) return
      if (connection.sessionId !== sessionId || connection.engineId !== expectedId) throw new Error('正在连接此会话的浏览器，请稍后重试。')
      const tab = await window.aether.browser.create({})
      if (!current() || tab.context?.sessionId !== sessionId || tab.context.engineId !== expectedId) return
      // Select the newly created page immediately. WorkView observes both
      // stores and adds it to the same openEntries list as every built-in
      // surface, so creation does not strand the user on the previous file.
      selectBrowserTab(tab.tabId)
      selectWorkResource(sessionId, `web:${tab.tabId}`)
      onSelect()
    })
  }

  // The list itself remains a pure role=tablist; these controls live in the
  // trailing toolbar slot and appear when the resource surface is in use.
  return <>
    <button
      type="button"
      className="work-resource-tabs__new work-resource-tabs__browser"
      aria-label="浏览器"
      title="打开浏览器"
      onClick={openBrowser}
    >
      <Icon name="eye-outline" size={15} />
      <span>浏览器</span>
    </button>
    <button type="button" className="work-resource-tabs__new" aria-label="打开文件" title="打开电脑上的文件" onClick={() => fileInput.current?.click()}>
      <Icon name="file" size={15} />
    </button>
    <input ref={fileInput} type="file" className="work-resource-tabs__file-input" aria-hidden="true" tabIndex={-1} onChange={onPick} />
    <button type="button" className="work-resource-tabs__new" aria-label="新建网页" title="新建网页" onClick={openBrowser}>
      <Icon name="plus" size={16} />
    </button>
  </>
}
