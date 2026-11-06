import { useEffect, useRef, type ChangeEvent, type JSX } from 'react'
import { ActionMenu, type ActionMenuItem } from '@renderer/workbench/ActionMenu'
import { browserAction, initializeBrowser, selectBrowserTab } from '../browser/browser-store'
import { openExternalWorkFileResource, selectWorkResource } from './work-resource-store'
import { getEngineSource, getEngineStorageKey } from '@renderer/core/engine/source'
import { getBrowserSurfaceOwner } from '@renderer/core/browser/presentation'
import { browserTabInScope } from '@renderer/core/browser/scope'
import { getAppMode } from '@renderer/core/platform/app-mode'
import { getWorkState } from './work-state'
import { toast } from '@renderer/core/toast'
import './work-resource-tabs.css'

/**
 * Resource actions share the workspace menu so open tabs retain the strip's
 * width. The file input stays mounted when the menu closes for a native picker.
 */
export function WorkResourceTabs({ sessionId, onSelect, items }: {
  sessionId: string
  onSelect: () => void
  items: ActionMenuItem[]
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
      const presentation = getBrowserSurfaceOwner()
      if (!current() || presentation.mode !== 'work' || presentation.sessionId !== sessionId) return
      const tab = await window.aether.browser.create({})
      if (!current() || !browserTabInScope(tab, presentation)) return
      // Select the newly created page immediately. WorkView observes both
      // stores and adds it to the same openEntries list as every built-in
      // surface, so creation does not strand the user on the previous file.
      selectBrowserTab(tab.tabId)
      selectWorkResource(sessionId, `web:${tab.tabId}`)
      onSelect()
    })
  }

  return <>
    <ActionMenu className="work-workspace__more" panelClassName="work-workspace-menu" label="更多工作区" items={[
      ...items,
      { id: 'open-file', label: '打开文件…', icon: 'file', separatorBefore: true, onSelect: () => fileInput.current?.click() },
      { id: 'new-webpage', label: '新建网页', icon: 'plus', onSelect: openBrowser }
    ]} />
    <input ref={fileInput} type="file" className="work-resource-tabs__file-input" aria-hidden="true" tabIndex={-1} onChange={onPick} />
  </>
}
