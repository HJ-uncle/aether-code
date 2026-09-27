import type { JSX } from 'react'
import { DEFAULT_SEARCH_EXCLUDE } from '@shared/ipc'
import { ExcludeSettingsView, useExcludeSettings } from './ExcludeSettingsView'

/**
 * 搜索排除设置（search.exclude）
 *
 * 照搬 VS Code：搜索结果 = files.exclude 与 search.exclude 的并集，
 * 同名键以本表为准 —— 因此默认被排除的依赖目录可以在这里写 false 放回来，
 * 用户也不必为了搜索再抄一遍文件排除里已有的规则。
 */
export function SearchExcludeSettingsView(): JSX.Element {
  const [value, setValue] = useExcludeSettings('searchExclude')

  return (
    <div className="settings-view">
      <ExcludeSettingsView
        value={value}
        defaults={DEFAULT_SEARCH_EXCLUDE}
        onChange={setValue}
        legend="搜索排除"
        ariaLabel="搜索排除规则"
        emptyHint="当前没有搜索排除规则。"
        placeholder="例如 **/node_modules"
        hint={
          <>
            命中的文件与目录不会出现在全文搜索结果中（目录命中时整棵子树都会跳过，
            顺带省下遍历时间）。本表与「文件」分区里的文件排除取并集，
            同名模式以本表为准。取消勾选表示「显式搜索」，可用来把默认排除的{' '}
            <code>node_modules</code> 放回结果里。
          </>
        }
      />
    </div>
  )
}
