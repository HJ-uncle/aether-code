import type { JSX } from 'react'
import { DEFAULT_FILES_EXCLUDE } from '@shared/ipc'
import { ExcludeSettingsView, useExcludeSettings } from './ExcludeSettingsView'

/**
 * 文件排除设置（files.exclude）
 *
 * 命中的文件与目录不显示在资源管理器中。改动即时生效 —— 资源管理器立刻重建树。
 * 编辑界面与「搜索排除」共用（见 ExcludeSettingsView），这里只负责文案与字段。
 */
export function FilesExcludeSettingsView(): JSX.Element {
  const [value, setValue] = useExcludeSettings('filesExclude')

  return (
    <ExcludeSettingsView
      className="settings-view--files-exclude"
      value={value}
      defaults={DEFAULT_FILES_EXCLUDE}
      onChange={setValue}
      legend="文件排除"
      ariaLabel="文件排除规则"
      emptyHint="当前没有排除规则，所有文件都会显示。"
      placeholder="例如 **/node_modules"
      hint={
        <>
          命中的文件与目录不会显示在资源管理器中（目录命中时整棵子树一并隐藏）。 模式写{' '}
          <code>*.log</code> 表示任意层级；写 <code>src/generated</code>{' '}
          表示相对工作区根的具体路径。 取消勾选表示「显式显示」，可用来覆盖默认规则。
        </>
      }
    />
  )
}
