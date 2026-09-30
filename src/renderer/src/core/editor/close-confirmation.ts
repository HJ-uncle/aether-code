import type { ConfirmOptions } from '../../workbench/ConfirmDialog'

export interface ClosableDocument {
  path: string
  name: string
  content: string
  savedContent: string
  isBinary: boolean
}

export interface CloseConfirmationHost {
  read: (path: string) => ClosableDocument | undefined
  save: (path: string) => Promise<void>
  confirm: (options: ConfirmOptions) => Promise<boolean>
  error: (message: string) => void
}

function dirty(document: ClosableDocument): boolean {
  return !document.isBinary && document.content !== document.savedContent
}

/** 所有关闭入口先完成整个集合的决策，避免批量保存到一半失败时已丢掉其它标签。 */
export async function confirmDocumentClose(
  paths: readonly string[],
  host: CloseConfirmationHost
): Promise<boolean> {
  const documents = new Map<string, ClosableDocument>()
  for (const path of paths) {
    const document = host.read(path)
    if (document) documents.set(document.path, { ...document })
  }
  const unsaved = [...documents.values()].filter(dirty)
  if (unsaved.length === 0) return true

  let saved = false
  let saveRequest: Promise<boolean> | undefined
  const names = unsaved.map((document) => `「${document.name}」`).join('、')
  const approved = await host.confirm({
    title: unsaved.length === 1 ? '关闭未保存的文件' : `关闭 ${unsaved.length} 个未保存的文件`,
    body: `${names}有未保存的修改。`,
    confirmText: '不保存并关闭',
    danger: true,
    tertiary: {
      text: unsaved.length === 1 ? '保存并关闭' : '全部保存并关闭',
      run: () => {
        // 双击保存按钮不能发出两份并发写盘请求。
        saveRequest ??= (async () => {
          try {
            for (const path of documents.keys()) {
              const latest = host.read(path)
              if (latest && dirty(latest)) await host.save(path)
            }
          } catch {
            host.error('保存失败，文件均未关闭')
            return false
          }
          if ([...documents.keys()].some((path) => {
            const latest = host.read(path)
            return latest && dirty(latest)
          })) {
            host.error('保存期间又有新的修改，文件均未关闭')
            return false
          }
          saved = true
          return true
        })()
        return saveRequest
      }
    }
  })
  if (!approved) return false

  // 弹窗/写盘期间也可能收到外部模型编辑。用户只批准丢弃当时那一版，不能顺带丢弃新输入。
  for (const [path, snapshot] of documents) {
    const latest = host.read(path)
    if (latest && dirty(latest) && (saved || !dirty(snapshot) || latest.content !== snapshot.content)) {
      host.error('确认期间文件又有新的修改，文件均未关闭')
      return false
    }
  }
  return true
}
