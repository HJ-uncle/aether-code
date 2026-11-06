import type { FsFileContent } from '@shared/ipc'
import { hasEncodedPathTraversal } from '@shared/path-safety'
import { assertSessionFileTarget, readFile, writeFile, type SessionFileTarget } from '../../core/workspace/fs-client'
import type { RemoteSearchTransport, RemoteWorkspaceItem } from '../search/remote-search'

export interface WorkSearchDependencies {
  assertTarget(target: SessionFileTarget): void
  readFile(path: string, target: SessionFileTarget): Promise<FsFileContent>
  writeFile(path: string, content: string, target: SessionFileTarget): Promise<unknown>
}

const defaults: WorkSearchDependencies = { assertTarget: assertSessionFileTarget, readFile, writeFile }

function relativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (hasEncodedPathTraversal(value) || normalized.split('/').some(part =>
    !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f:]/.test(part))) {
    throw new Error('工作区搜索包含无效文件路径')
  }
  return normalized
}

/** Replacement reuses exactly the files that were present in its accepted preview. */
export function workSearchFileTree(files: readonly string[]): RemoteWorkspaceItem {
  const root: RemoteWorkspaceItem = { name: '', type: 'dir', children: [] }
  const nodes = new Map<string, RemoteWorkspaceItem>([['', root]])
  for (const value of files) {
    const parts = relativePath(value).split('/')
    let parent = root, path = ''
    for (let index = 0; index < parts.length; index++) {
      path = path ? `${path}/${parts[index]}` : parts[index]
      const type = index === parts.length - 1 ? 'file' : 'dir'
      let node = nodes.get(path)
      if (node && node.type !== type) throw new Error('工作区搜索文件列表存在路径冲突')
      if (!node) {
        node = { name: parts[index], type, ...(type === 'dir' ? { children: [] } : {}) }
        parent.children!.push(node)
        nodes.set(path, node)
      }
      parent = node
    }
  }
  return root
}

/** Both embedded and remote Work tasks own a session sandbox, independent of the Code workspace. */
export function createWorkSearchTransport(target: SessionFileTarget, current: () => boolean,
  files: readonly string[], deps: WorkSearchDependencies = defaults): RemoteSearchTransport {
  const root = target.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^(?:[A-Za-z]:|\/\/)/.test(root)
  const identity = (path: string): string => windows ? path.toLowerCase() : path
  const absolute = (path: string): string => `${root}/${relativePath(path)}`
  const tree = workSearchFileTree(files)
  const allowedFiles = new Set(files.map(file => identity(absolute(file))))
  const completeReads = new Set<string>()
  const assertCurrent = (): void => {
    if (!current()) throw new Error('工作区搜索已取消，请在当前会话重试')
    deps.assertTarget(target)
  }
  return {
    assertCurrent,
    // The server already selected these files; preview never enumerates directories.
    async listFiles() { assertCurrent(); return tree },
    async readFile(path) {
      assertCurrent()
      const fullPath = absolute(path), key = identity(fullPath)
      if (!allowedFiles.has(key)) throw new Error('文件不在本次搜索结果中，请重新搜索并预览')
      completeReads.delete(key)
      const file = await deps.readFile(fullPath, target)
      assertCurrent()
      // A preview is never a safe replacement source, even when its notice makes it look complete.
      if (file.truncated || file.tooLarge) throw new Error('文件内容被截断或超过读取上限，未搜索或替换此文件')
      if (!file.isBinary && !file.content.includes('\0')) completeReads.add(key)
      return { content: file.content, isBinary: file.isBinary, totalSize: file.size, originalLength: file.content.length }
    },
    async writeFile(path, content) {
      assertCurrent()
      const fullPath = absolute(path), key = identity(fullPath)
      if (!allowedFiles.has(key)) throw new Error('文件不在本次搜索结果中，请重新搜索并预览')
      if (!completeReads.has(key)) throw new Error('文件尚未完整读取，无法安全替换')
      completeReads.delete(key)
      await deps.writeFile(fullPath, content, target)
      // The replacer records this completed write before checking cancellation;
      // throwing here would hide a real disk change from Work preview refreshes.
    }
  }
}
