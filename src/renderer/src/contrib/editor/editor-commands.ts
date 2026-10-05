import type { editor } from 'monaco-editor'
import { getActiveEditor } from '@renderer/core/editor/active-editor'
import {
  getEditorDisplayOptions,
  setEditorDisplayOptions
} from '@renderer/core/editor/editor-display-options'
import { registerCommands } from '@renderer/core/platform/commands'
import { ipcErrorMessage } from '@renderer/core/ipc-error'
import { toast } from '@renderer/core/toast'
import { addFilesToChat, addSelectionToChat } from '@renderer/contrib/chat/editor-context'

interface NativeEditorCommand {
  id: string
  title: string
  nativeId: string
  unsupported?: string
  bridgePrecondition?: string
}

// ID 来自当前 Monaco 0.56 的 format/rename/gotoSymbol/quickAccess/folding/find/multicursor。
// 不把工作台命令当成 standalone editor action：两者的注册表并不相同。
const NATIVE_COMMANDS: NativeEditorCommand[] = [
  {
    id: 'formatDocument',
    title: '格式化文档',
    nativeId: 'editor.action.formatDocument',
    unsupported: '当前文件没有可用的文档格式化服务。'
  },
  {
    id: 'formatSelection',
    title: '格式化选区',
    nativeId: 'editor.action.formatSelection',
    unsupported: '当前文件没有可用的选区格式化服务。'
  },
  {
    id: 'renameSymbol',
    title: '重命名符号',
    nativeId: 'editor.action.rename',
    unsupported: '当前文件没有可用的符号重命名服务。'
  },
  {
    id: 'quickFix',
    title: '快速修复',
    nativeId: 'editor.action.quickFix',
    unsupported: '当前文件没有可用的代码操作服务。',
    bridgePrecondition: 'editorHasCodeActionsProvider'
  },
  {
    id: 'refactor',
    title: '重构代码',
    nativeId: 'editor.action.refactor',
    unsupported: '当前文件没有可用的重构服务。',
    bridgePrecondition: 'editorHasCodeActionsProvider'
  },
  {
    id: 'organizeImports',
    title: '整理导入',
    nativeId: 'editor.action.organizeImports',
    unsupported: '当前文件没有可用的导入整理服务。',
    bridgePrecondition: 'editorHasCodeActionsProvider'
  },
  {
    id: 'goToDefinition',
    title: '转到定义',
    nativeId: 'editor.action.revealDefinition',
    unsupported: '当前文件没有可用的定义跳转服务。',
    bridgePrecondition: 'editorHasDefinitionProvider'
  },
  {
    id: 'goToReferences',
    title: '转到引用',
    nativeId: 'editor.action.goToReferences',
    unsupported: '当前文件没有可用的引用查找服务。',
    bridgePrecondition:
      'editorHasReferenceProvider && !inReferenceSearchEditor && !isInEmbeddedEditor'
  },
  {
    id: 'goToSymbol',
    title: '转到文件符号',
    nativeId: 'editor.action.quickOutline',
    unsupported: '当前文件没有可用的文件符号服务。'
  },
  { id: 'goToLine', title: '转到行', nativeId: 'editor.action.gotoLine' },
  { id: 'fold', title: '折叠当前区域', nativeId: 'editor.fold' },
  { id: 'unfold', title: '展开当前区域', nativeId: 'editor.unfold' },
  { id: 'foldAll', title: '折叠全部区域', nativeId: 'editor.foldAll' },
  { id: 'unfoldAll', title: '展开全部区域', nativeId: 'editor.unfoldAll' },
  { id: 'find', title: '查找', nativeId: 'actions.find' },
  { id: 'replace', title: '替换', nativeId: 'editor.action.startFindReplaceAction' },
  {
    id: 'addCursorAbove',
    title: '在上方添加光标',
    nativeId: 'editor.action.insertCursorAbove'
  },
  {
    id: 'addCursorBelow',
    title: '在下方添加光标',
    nativeId: 'editor.action.insertCursorBelow'
  },
  {
    id: 'selectNextOccurrence',
    title: '选择下一个匹配项',
    nativeId: 'editor.action.addSelectionToNextFindMatch'
  },
  {
    id: 'selectAllOccurrences',
    title: '选择所有匹配项',
    nativeId: 'editor.action.selectHighlights'
  },
  { id: 'toggleLineComment', title: '切换行注释', nativeId: 'editor.action.commentLine' }
]

function bridgeId(command: NativeEditorCommand): string {
  return `aether.native.${command.id}`
}

/** Monaco can cancel an in-flight provider call when the same command is
 * dispatched again (the command palette closes before the action promise
 * settles). Reuse the existing run so repeated dispatches do not create a
 * cancellation storm in the language worker. */
const nativeCommandRuns = new Map<string, Promise<void>>()

/**
 * Monaco 0.56 把定义/引用注册成 Action2，getAction() 无法取得它们。
 * 用公开 addAction/trigger 桥接，并沿用原生命令的 provider 条件，避免无服务时静默返回。
 */
export function registerEditorActionBridges(instance: editor.IStandaloneCodeEditor): () => void {
  const disposers = NATIVE_COMMANDS.filter((command) => command.bridgePrecondition).map((command) =>
    instance.addAction({
      id: bridgeId(command),
      label: command.title,
      precondition: command.bridgePrecondition,
      run: (target) => target.trigger('aether.commandPalette', command.nativeId, undefined)
    })
  )
  return () => disposers.forEach((disposer) => disposer.dispose())
}

async function withEditor(
  title: string,
  run: (instance: editor.IStandaloneCodeEditor) => void | Promise<void>
): Promise<void> {
  const instance = getActiveEditor()
  if (!instance) {
    toast.info('请先打开并聚焦一个文本文件。')
    return
  }
  try {
    // 原生查找/符号/跳行会从 Monaco 的焦点服务取目标，不能只保留实例引用。
    instance.focus()
    await run(instance)
  } catch (error) {
    toast.error(`${title}失败：${ipcErrorMessage(error)}`)
  }
}

export function registerEditorCommands(): () => void {
  return registerCommands([
    {
      id: 'aether.editor.addSelectionToChat', title: '添加选区到对话', category: '编辑器',
      run: () => { addSelectionToChat() }
    },
    {
      id: 'aether.editor.addFileToChat', title: '添加当前文件到对话', category: '编辑器',
      run: () => withEditor('添加当前文件到对话', (instance) => {
        const model = instance.getModel()
        if (model?.uri.scheme === 'file') addFilesToChat([{ path: model.uri.fsPath, kind: 'file' }])
        else toast.info('请在源码文件中添加完整文件；差异快照可以选中内容后添加到对话。')
      })
    },
    ...NATIVE_COMMANDS.map((command) => ({
      id: `aether.editor.${command.id}`,
      title: command.title,
      category: '编辑器',
      run: () => {
        const previous = nativeCommandRuns.get(command.id)
        if (previous) return previous
        const current = withEditor(command.title, async (instance) => {
          const action = instance.getAction(
            command.bridgePrecondition ? bridgeId(command) : command.nativeId
          )
          if (!action || !action.isSupported()) {
            toast.info(command.unsupported ?? `当前编辑器暂不支持“${command.title}”。`)
            return
          }
          await action.run()
        })
        nativeCommandRuns.set(command.id, current)
        return current.finally(() => {
          if (nativeCommandRuns.get(command.id) === current) nativeCommandRuns.delete(command.id)
        })
      }
    })),
    {
      id: 'aether.editor.toggleWordWrap',
      title: '切换自动换行',
      category: '编辑器',
      run: () =>
        withEditor('切换自动换行', () => {
          const wrap = getEditorDisplayOptions().wordWrap
          setEditorDisplayOptions({ wordWrap: wrap === 'off' ? 'on' : 'off' })
        })
    },
    {
      id: 'aether.editor.toggleMinimap',
      title: '切换小地图',
      category: '编辑器',
      run: () =>
        withEditor('切换小地图', () => {
          setEditorDisplayOptions({ minimapEnabled: !getEditorDisplayOptions().minimapEnabled })
        })
    }
  ])
}
