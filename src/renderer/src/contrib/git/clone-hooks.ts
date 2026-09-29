/**
 * 「克隆仓库」流程的宿主接线（CloneFlowHooks → aether 实现）
 *
 * 应用根部（如 GitChangesPanel 挂载处）调用一次 configureGitCloneFlow()：
 * 把 git-clone-flow 需要的能力接到 aether 现有机制上——
 *   pickParentDir → 主进程系统目录选择框（fs.pickFolder，选中自动授权）
 *   confirmOpen   → confirmDialog（aether 全工程统一的确认手段，见 workbench/ConfirmDialog）
 *   openWorkspace → workspace-store.openFolderAt（切换工作区根）
 *   toast*        → 全局 toast（core/toast.ts）
 */
import { configureCloneFlow } from '@renderer/core/git/git-clone-flow'
import { pickFolder } from '@renderer/core/workspace/fs-client'
import { openFolderAt } from '@renderer/core/workspace/workspace-store'
import { confirmDialog } from '@renderer/workbench/ConfirmDialog'
import { toast } from '@renderer/core/toast'

let configured = false

/** 幂等：多次调用只注入一次（单例流程，重复注入无意义） */
export function configureGitCloneFlow(): void {
  if (configured) return
  configured = true

  configureCloneFlow({
    pickParentDir: () => pickFolder(),
    confirmOpen: (finalPath: string) =>
      confirmDialog({
        title: '克隆完成',
        body: `克隆完成：\n${finalPath}\n\n是否打开该仓库？`,
        confirmText: '打开'
      }),
    toastError: (message: string) => {
      toast.error(message)
    },
    toastSuccess: (message: string) => {
      toast.success(message)
    },
    openWorkspace: (path: string) => openFolderAt(path)
  })
}
