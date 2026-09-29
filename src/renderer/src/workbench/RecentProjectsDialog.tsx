/**
 * 「最近打开的完整列表」弹窗：欢迎页默认只展示前 8 条，其余从这里查看。
 * 对齐 wuzu-client 的 RecentProjectsDialog：全量历史 + 单条移除。
 */
import { useEffect, useState, type JSX } from 'react'
import {
  forgetRecentFolder,
  getRecentFolders,
  onRecentFoldersChanged,
  RECENT_PREVIEW_COUNT
} from '@renderer/core/workspace/recent-folders'
import { openFolderAt } from '@renderer/core/workspace/workspace-store'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { Dialog } from './Dialog'
import { Icon } from './icons'

export function RecentProjectsDialog({
  onClose
}: {
  onClose: () => void
}): JSX.Element {
  const workspace = useWorkspace()
  const [all, setAll] = useState<string[]>([])
  useEffect(() => {
    const sync = (): void =>
      setAll(getRecentFolders().filter((folder) => folder !== workspace.root))
    sync()
    return onRecentFoldersChanged(sync)
  }, [workspace.root])

  const open = (folder: string): void => {
    onClose()
    void openFolderAt(folder).catch(() => {
      // 目录已失效：从历史摘掉
      forgetRecentFolder(folder)
    })
  }

  return (
    <Dialog
      title={`最近打开（共 ${all.length} 个）`}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      {all.length === 0 ? (
        <p className="recent-dialog__empty">暂无历史项目</p>
      ) : (
        <ul className="recent-dialog__list">
          {all.map((folder, index) => {
            const name = folder.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? folder
            const inPreview = index < RECENT_PREVIEW_COUNT
            return (
              <li key={folder} className="recent-dialog__item">
                <button
                  type="button"
                  className="recent-dialog__open"
                  title={folder}
                  onClick={() => open(folder)}
                >
                  <Icon name="explorer" size={16} />
                  <span className="recent-dialog__text">
                    <span className="recent-dialog__name">{name}</span>
                    <span className="recent-dialog__path">{folder}</span>
                  </span>
                  {inPreview ? null : <span className="recent-dialog__more">未在首页展示</span>}
                </button>
                <button
                  type="button"
                  className="recent-dialog__remove"
                  title="从列表中移除"
                  aria-label={`从列表中移除 ${name}`}
                  onClick={() => forgetRecentFolder(folder)}
                >
                  <Icon name="close" size={16} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
