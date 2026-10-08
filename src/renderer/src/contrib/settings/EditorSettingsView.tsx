import type { JSX } from 'react'
import { EditorSettings } from '@renderer/contrib/editor/EditorSettings'
import '../editor/editor-toolbar.css'
import './settings-pages.css'

/**
 * VS Code-style settings entry for the options that already have a live
 * Monaco backing store. Keeping the existing editor preference component as
 * the control surface means the settings editor and the editor toolbar stay
 * in sync instead of persisting two competing copies.
 */
export function EditorSettingsView(): JSX.Element {
  return (
    <div className="settings-view settings-view--editor">
      <EditorSettings />
    </div>
  )
}
