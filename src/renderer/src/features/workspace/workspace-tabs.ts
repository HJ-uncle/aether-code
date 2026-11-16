import type { IconName } from '@renderer/ui/icons'
import type { ExtensionWorkspaceTab } from '../extensions/types'
import { type WorkspaceTab, isExtensionDestination, extensionIcon } from '../../app/navigation'

/** The persistent heading menu and the mounted pane share destination labels. */
export function workspaceSurfaceTabs(extensions: readonly ExtensionWorkspaceTab[]): Array<[WorkspaceTab, string, IconName]> {
  return [
    ['files', '成果', 'file-check'],
    ['workspace', '工作区', 'folder-outline'],
    ['sources', '资料', 'library'],
    ['subagents', '子代理', 'users'],
    ['terminal', '终端', 'terminal'],
    ['git', 'Git', 'git'],
    ...extensions.flatMap(item => isExtensionDestination(item.id)
      ? [[item.id, item.title, extensionIcon(item.icon)] as [WorkspaceTab, string, IconName]] : [])
  ]
}
