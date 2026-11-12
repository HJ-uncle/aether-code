import { documentKey } from './editor-store'
import { setLayout } from '../platform/layout-state'

/** Activate a document in the shared editor state. */
export function activateDocument(filePath: string): void {
  setLayout({ activeEditorView: documentKey(filePath) })
}
