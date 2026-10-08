import type { JSX } from 'react'
import { Segmented, SettingsGroup, SettingsRow, Toggle } from './SettingsGroup'
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, resetLayout, setLayout } from '@renderer/core/platform/layout-state'
import { useLayout } from '@renderer/workbench/useLayout'
import './settings-pages.css'

export function WorkbenchSettingsView(): JSX.Element {
  const layout = useLayout()
  return (
    <div className="settings-view settings-view--workbench">
      <SettingsGroup title="界面区域" footer="这些选项立即应用，并在下次启动时保留。拖动分隔线也会更新对应的尺寸。">
        <SettingsRow label="显示侧边栏" description="显示资源管理器、搜索和源代码管理等视图。">
          <Toggle checked={layout.sidebarVisible} label="显示侧边栏" onChange={(sidebarVisible) => setLayout({ sidebarVisible })} />
        </SettingsRow>
        <SettingsRow label="显示底部面板" description="显示终端、输出和问题等面板。">
          <Toggle checked={layout.panelVisible} label="显示底部面板" onChange={(panelVisible) => setLayout({ panelVisible })} />
        </SettingsRow>
        <SettingsRow label="显示对话面板" description="显示 Aether 的对话侧栏。">
          <Toggle checked={layout.chatPanelVisible} label="显示对话面板" onChange={(chatPanelVisible) => setLayout({ chatPanelVisible })} />
        </SettingsRow>
        <SettingsRow label="对话面板位置" description="选择对话面板靠近活动栏或窗口右侧。">
          <Segmented
            options={[{ value: 'right', label: '右侧' }, { value: 'left', label: '左侧' }] as const}
            value={layout.chatOnLeft ? 'left' : 'right'}
            onChange={(value) => setLayout({ chatOnLeft: value === 'left' })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="尺寸">
        <SettingsRow label="侧边栏宽度" description={`${LAYOUT_LIMITS.sidebarMin}–${LAYOUT_LIMITS.sidebarMax}px`}>
          <input
            className="field__input settings-number-input"
            type="number"
            min={LAYOUT_LIMITS.sidebarMin}
            max={LAYOUT_LIMITS.sidebarMax}
            step={10}
            value={layout.sidebarWidth}
            aria-label="侧边栏宽度"
            onChange={(event) => setLayout({ sidebarWidth: Number(event.target.value) })}
          />
        </SettingsRow>
        <SettingsRow label="对话面板宽度" description={`${LAYOUT_LIMITS.chatPanelMin}–${LAYOUT_LIMITS.chatPanelMax}px`}>
          <input
            className="field__input settings-number-input"
            type="number"
            min={LAYOUT_LIMITS.chatPanelMin}
            max={LAYOUT_LIMITS.chatPanelMax}
            step={10}
            value={layout.chatPanelWidth}
            aria-label="对话面板宽度"
            onChange={(event) => setLayout({ chatPanelWidth: Number(event.target.value) })}
          />
        </SettingsRow>
        <SettingsRow label="底部面板高度" description={`${LAYOUT_LIMITS.panelMin}–${LAYOUT_LIMITS.panelMax}px`}>
          <input
            className="field__input settings-number-input"
            type="number"
            min={LAYOUT_LIMITS.panelMin}
            max={LAYOUT_LIMITS.panelMax}
            step={10}
            value={layout.panelHeight}
            aria-label="底部面板高度"
            onChange={(event) => setLayout({ panelHeight: Number(event.target.value) })}
          />
        </SettingsRow>
      </SettingsGroup>
      <div className="settings-view__actions">
        <button type="button" className="btn" onClick={resetLayout}>
          恢复默认（{DEFAULT_LAYOUT.sidebarWidth}px 侧边栏）
        </button>
      </div>
    </div>
  )
}
