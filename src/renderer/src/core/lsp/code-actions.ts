import * as monaco from 'monaco-editor'
import { toast } from '../toast'
import {
  parseLspCodeAction,
  parseWorkspaceTextEdits,
  type LspCodeAction,
  type LspCommand
} from './workspace-edit'

type PreparedEdit = monaco.languages.WorkspaceEdit & monaco.languages.Rejection
interface ActionContext {
  generation: number
  sourceUri?: string
  versions: Map<string, number>
}
interface BridgeOptions {
  selector: monaco.languages.LanguageSelector
  generation: () => number
  request: <T = unknown>(
    method: string,
    params?: unknown,
    token?: monaco.CancellationToken
  ) => Promise<T>
  prepareEdit: (
    edit: unknown,
    versions: Map<string, number>,
    token?: monaco.CancellationToken,
    generation?: number
  ) => Promise<PreparedEdit>
  supportedCommands: ReadonlySet<string> | null
  resolveSupported: boolean
}
export interface WorkspaceActionBridge {
  applyServerEdit: (edit: unknown) => Promise<{ applied: boolean; failureReason?: string }>
  completionCommand: (command: unknown) => monaco.languages.Command | undefined
  dispose: () => void
}

const COMMAND_ID = 'aether.lsp.executeCommand'
const ACTION_ID = 'aether.lsp.applyCodeAction'

/** User actions share one edit transaction path with server-initiated workspace/applyEdit. */
export function registerWorkspaceActions(options: BridgeOptions): WorkspaceActionBridge {
  let disposed = false
  let actionQueue: Promise<unknown> = Promise.resolve()
  let serverEditQueue: Promise<unknown> = Promise.resolve()
  let executing: ActionContext | null = null
  const actionData = new WeakMap<
    monaco.languages.CodeAction,
    { raw: LspCodeAction; context: ActionContext; resolved?: boolean }
  >()
  const disposables: monaco.IDisposable[] = []
  const capture = (model?: monaco.editor.ITextModel): ActionContext => ({
    generation: options.generation(),
    sourceUri: model?.uri.toString(),
    versions: new Map(
      monaco.editor.getModels().map((item) => [item.uri.toString(), item.getVersionId()])
    )
  })
  const assertCurrent = (context: ActionContext): void => {
    if (disposed || context.generation !== options.generation())
      throw new Error('语言服务已切换，请重新执行操作')
    if (context.sourceUri) {
      const model = monaco.editor.getModel(monaco.Uri.parse(context.sourceUri))
      if (!model || model.getVersionId() !== context.versions.get(context.sourceUri))
        throw new Error('文件在操作期间发生变化，请重试')
    }
  }

  const applyEdit = async (edit: unknown, context: ActionContext): Promise<void> => {
    assertCurrent(context)
    const prepared = await options.prepareEdit(
      edit,
      context.versions,
      undefined,
      context.generation
    )
    if (prepared.rejectReason) throw new Error(prepared.rejectReason)
    assertCurrent(context)
    const groups = new Map<monaco.editor.ITextModel, monaco.languages.TextEdit[]>()
    // Validate every target before the first mutation, including models loaded during preparation.
    for (const edit of prepared.edits) {
      if (!('textEdit' in edit)) throw new Error('暂不支持此类工作区资源操作')
      const model = monaco.editor.getModel(edit.resource)
      if (!model || model.isDisposed() || model.getVersionId() !== edit.versionId)
        throw new Error('目标文件已变化，没有应用编辑')
      const range = model.validateRange(edit.textEdit.range)
      if (!monaco.Range.equalsRange(range, edit.textEdit.range))
        throw new Error('语言服务返回的编辑范围超出文档，没有应用编辑')
      const edits = groups.get(model) ?? []
      edits.push(edit.textEdit)
      groups.set(model, edits)
    }
    for (const [model, edits] of groups) {
      const offsets = edits
        .map((edit) => ({
          start: model.getOffsetAt({
            lineNumber: edit.range.startLineNumber,
            column: edit.range.startColumn
          }),
          end: model.getOffsetAt({
            lineNumber: edit.range.endLineNumber,
            column: edit.range.endColumn
          })
        }))
        .sort((left, right) => left.start - right.start || left.end - right.end)
      for (let index = 1; index < offsets.length; index++)
        if (offsets[index].start < offsets[index - 1].end)
          throw new Error('语言服务返回了重叠编辑，没有应用编辑')
    }
    for (const [model, edits] of groups) {
      model.pushStackElement()
      model.pushEditOperations([], edits, () => null)
      model.pushStackElement()
      context.versions.set(model.uri.toString(), model.getVersionId())
    }
  }

  const execute = async (command: LspCommand, context: ActionContext): Promise<void> => {
    assertCurrent(context)
    // TLS implements its completion callback but omits it from the initialize command list.
    if (
      options.supportedCommands &&
      !options.supportedCommands.has(command.command) &&
      command.command !== '_typescript.applyCompletionCodeAction'
    )
      throw new Error('当前语言服务未提供此代码操作：' + command.command)
    executing = context
    try {
      await options.request('workspace/executeCommand', {
        command: command.command,
        arguments: command.arguments
      })
      await serverEditQueue
    } finally {
      executing = null
    }
  }
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = actionQueue.then(operation, operation)
    actionQueue = next.catch(() => undefined)
    return next.catch((error: unknown) => {
      if (!disposed)
        toast.error(`代码操作失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const asCommand = (raw: unknown): LspCommand | undefined => {
    if (!raw || typeof raw !== 'object') return undefined
    const command = raw as { command?: unknown; title?: unknown; arguments?: unknown }
    return typeof command.command === 'string'
      ? {
          command: command.command,
          title: typeof command.title === 'string' ? command.title : command.command,
          arguments: Array.isArray(command.arguments) ? command.arguments : undefined
        }
      : undefined
  }
  const convertAction = (
    raw: LspCodeAction,
    context: ActionContext
  ): monaco.languages.CodeAction => {
    let disabled = raw.disabled?.reason
    if (raw.edit !== undefined) {
      try {
        parseWorkspaceTextEdits(raw.edit)
      } catch (error) {
        disabled = error instanceof Error ? error.message : String(error)
      }
    }
    if (
      raw.command &&
      options.supportedCommands &&
      !options.supportedCommands.has(raw.command.command)
    )
      disabled = '此操作需要尚未接入的语言服务命令'
    // Some TS commands create files before asking the client to apply text edits.
    // Until resource transactions exist, block these actions before executing them.
    if (
      raw.kind?.startsWith('refactor.move') ||
      raw.command?.command === '_typescript.applyRenameFile'
    )
      disabled = '创建、移动或重命名文件的重构尚未接入；请使用文件管理操作'
    if (!raw.edit && !raw.command && (raw.data === undefined || !options.resolveSupported))
      disabled = '语言服务未提供可执行的编辑'
    const title =
      (
        {
          'Organize Imports': '整理导入',
          'Sort Imports': '对导入排序',
          'Remove Unused Imports': '删除未使用的导入'
        } as Record<string, string>
      )[raw.title] ?? raw.title
    const action: monaco.languages.CodeAction = {
      title,
      kind: raw.kind,
      isPreferred: raw.isPreferred,
      disabled,
      command: {
        id: ACTION_ID,
        title: raw.title,
        arguments: [disabled ? { ...raw, disabled: { reason: disabled } } : raw, context]
      }
    }
    actionData.set(action, { raw, context })
    return action
  }

  disposables.push(
    monaco.editor.registerCommand(COMMAND_ID, (_accessor, raw: unknown) => {
      const command = asCommand(raw)
      if (!command) return
      return enqueue(() => execute(command, capture()))
    })
  )
  disposables.push(
    monaco.editor.registerCommand(
      ACTION_ID,
      (_accessor, raw: LspCodeAction, context: ActionContext) =>
        enqueue(async () => {
          assertCurrent(context)
          if (raw.disabled) throw new Error(raw.disabled.reason)
          if (raw.edit !== undefined) await applyEdit(raw.edit, context)
          if (raw.command) await execute(raw.command, context)
        })
    )
  )
  disposables.push(
    monaco.languages.registerCodeActionProvider(
      options.selector,
      {
        async provideCodeActions(model, range, context, token) {
          const captured = capture(model)
          const diagnostics = monaco.editor
            .getModelMarkers({ resource: model.uri, owner: 'tsserver' })
            .filter((marker) => monaco.Range.areIntersectingOrTouching(range, marker))
            .map((marker) => {
              const code = typeof marker.code === 'object' ? marker.code.value : marker.code
              return {
                range: {
                  start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
                  end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 }
                },
                message: marker.message,
                severity:
                  marker.severity === monaco.MarkerSeverity.Error
                    ? 1
                    : marker.severity === monaco.MarkerSeverity.Warning
                      ? 2
                      : 3,
                code: code !== undefined && /^\d+$/.test(code) ? Number(code) : code,
                source: marker.source
              }
            })
          try {
            const response = await options.request<unknown[] | null>(
              'textDocument/codeAction',
              {
                textDocument: { uri: model.uri.toString() },
                range: {
                  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
                },
                context: {
                  diagnostics,
                  only: context.only ? [context.only] : undefined,
                  triggerKind: context.trigger
                }
              },
              token
            )
            if (token.isCancellationRequested) return { actions: [], dispose() {} }
            assertCurrent(captured)
            const actions = (response ?? []).flatMap((value) => {
              const raw = parseLspCodeAction(value)
              return raw
                ? [convertAction(raw, { ...captured, versions: new Map(captured.versions) })]
                : []
            })
            return { actions, dispose() {} }
          } catch (error) {
            if (
              !token.isCancellationRequested &&
              context.trigger === monaco.languages.CodeActionTriggerType.Invoke
            )
              toast.error(
                `无法获取代码操作：${error instanceof Error ? error.message : String(error)}`
              )
            return { actions: [], dispose() {} }
          }
        },
        async resolveCodeAction(action, token) {
          const data = actionData.get(action)
          if (!data || data.resolved || data.raw.data === undefined || !options.resolveSupported)
            return action
          try {
            assertCurrent(data.context)
            const resolved = await options.request<Record<string, unknown>>(
              'codeAction/resolve',
              data.raw,
              token
            )
            assertCurrent(data.context)
            const raw = parseLspCodeAction({ ...data.raw, ...resolved })
            if (!raw) throw new Error('语言服务返回了无效的代码操作')
            // Monaco 0.56 copies only `edit` from the returned value. Update the same
            // action so a lazily resolved command also reaches its actual executor.
            Object.assign(action, convertAction(raw, data.context))
            actionData.set(action, { raw, context: data.context, resolved: true })
            return action
          } catch (error) {
            const reason = `无法准备代码操作：${error instanceof Error ? error.message : String(error)}`
            Object.assign(
              action,
              convertAction({ ...data.raw, disabled: { reason } }, data.context)
            )
            return action
          }
        }
      },
      { providedCodeActionKinds: ['quickfix', 'refactor', 'source', 'source.organizeImports', 'source.fixAll'] }
    )
  )

  return {
    applyServerEdit(edit) {
      const context = executing
      if (!context)
        return Promise.resolve({ applied: false, failureReason: '没有正在执行的用户代码操作' })
      const pending = serverEditQueue.then(async () => {
        try {
          await applyEdit(edit, context)
          return { applied: true }
        } catch (error) {
          const failureReason = error instanceof Error ? error.message : String(error)
          if (!disposed) toast.error(`无法应用工作区编辑：${failureReason}`)
          return { applied: false, failureReason }
        }
      })
      serverEditQueue = pending
      return pending
    },
    completionCommand(raw) {
      const command = asCommand(raw)
      return command
        ? { id: COMMAND_ID, title: command.title ?? command.command, arguments: [command] }
        : undefined
    },
    dispose() {
      disposed = true
      executing = null
      for (const disposable of disposables) disposable.dispose()
    }
  }
}
