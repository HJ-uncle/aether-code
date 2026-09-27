import { documentKey } from './editor-store'
import { setLayout } from '../platform/layout-state'

/**
 * 把某个已打开的文件切成当前激活标签。
 *
 * 「哪个标签是激活的」由 layout-state 持有，而标签栏在 workbench/EditorArea 内。
 * 这里单独成一个模块、而不是写进 EditorArea 或 store：
 *   - 写进 EditorArea：core 层就要反向 import workbench，分层倒置；
 *   - 写进 editor-store：store 便同时承担「文档内容」与「标签激活」两件事。
 * 因此只抽出这一个动作，谁需要谁调用。
 */
export function activateDocument(filePath: string): void {
  setLayout({ activeEditorView: documentKey(filePath) })
}
