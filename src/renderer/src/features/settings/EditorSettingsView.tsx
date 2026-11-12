import type { JSX } from 'react'
import { EditorSettings } from '@renderer/features/editor/EditorSettings'
import './settings-pages.css'

/**
 * 复用编辑器偏好组件与持久化 store，避免设置页维护第二份状态。
 */
export function EditorSettingsView(): JSX.Element {
  return (
    <div className="settings-view settings-view--editor">
      <EditorSettings />
    </div>
  )
}
