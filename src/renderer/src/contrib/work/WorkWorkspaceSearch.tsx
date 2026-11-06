import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type JSX } from 'react'
import { onAppSettingsChanged } from '@renderer/core/app-context'
import type { SessionFileTarget } from '@renderer/core/workspace/fs-client'
import type { TextPreviewReveal } from '@renderer/core/editor/TextPreview'
import { SearchPanel } from '../search/SearchView'
import { createWorkSearchController } from './work-search-controller'

export function WorkWorkspaceSearch({ target, active, onOpenFile }: {
  target: SessionFileTarget
  active: boolean
  onOpenFile?: (path: string, reveal?: TextPreviewReveal) => void
}): JSX.Element {
  const owner = useRef({ target, active, mounted: true, onOpenFile })
  owner.current = { target, active, mounted: owner.current.mounted, onOpenFile }
  const controller = useMemo(() => createWorkSearchController(target,
    () => owner.current.mounted && owner.current.active && owner.current.target.key === target.key,
    (path, reveal) => owner.current.onOpenFile?.(path, reveal)), [target])
  const search = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  // Layout setup precedes the child's passive search effect, including React's
  // development replay of setup/cleanup. A replay must not leave ownership off.
  useLayoutEffect(() => {
    owner.current.mounted = true
    const unsubscribe = onAppSettingsChanged(controller.settingsChanged)
    return () => { owner.current.mounted = false; unsubscribe(); controller.suspend() }
  }, [controller])
  useEffect(() => { if (!active) controller.suspend() }, [active, controller])
  return <SearchPanel root={target.root} search={search} actions={controller.actions} active={active} embedded />
}
