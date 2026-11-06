import type { FilesExclude, FsEntry, FsFileContent, SearchOptions } from '@shared/ipc'
import { hasEncodedPathTraversal } from '@shared/path-safety'
import { assertSessionFileTarget, readDir, readFile, writeFile, type SessionFileTarget } from '../../core/workspace/fs-client'
import { remoteSearchPathExcluded, type RemoteSearchTransport, type RemoteWorkspaceItem } from '../search/remote-search'

export interface WorkSearchDependencies {
  assertTarget(target: SessionFileTarget): void
  readDir(path: string, target: SessionFileTarget): Promise<FsEntry[]>
  readFile(path: string, target: SessionFileTarget): Promise<FsFileContent>
  writeFile(path: string, content: string, target: SessionFileTarget): Promise<unknown>
}
export interface WorkSearchLimits { files: number; directories: number; depth: number }

const defaults: WorkSearchDependencies = { assertTarget: assertSessionFileTarget, readDir, readFile, writeFile }
const defaultLimits: WorkSearchLimits = { files: 20_000, directories: 2_000, depth: 48 }

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
  options: SearchOptions, excludes: FilesExclude, deps: WorkSearchDependencies = defaults,
  limits: WorkSearchLimits = defaultLimits): RemoteSearchTransport {
  const root = target.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^(?:[A-Za-z]:|\/\/)/.test(root)
  const identity = (path: string): string => windows ? path.toLowerCase() : path
  const absolute = (path: string): string => `${root}/${relativePath(path)}`
  const completeReads = new Set<string>()
  const assertCurrent = (): void => {
    if (!current()) throw new Error('工作区搜索已取消，请在当前会话重试')
    deps.assertTarget(target)
  }
  return {
    assertCurrent,
    async listFiles() {
      assertCurrent()
      const files: string[] = []
      const visited = new Set<string>([identity(root)])
      const pending = [{ path: '', depth: 0 }]
      let directories = 0
      while (pending.length) {
        assertCurrent()
        if (++directories > limits.directories) throw new Error(`工作区目录超过搜索上限（${limits.directories} 个），请增加排除范围`)
        const next = pending.pop()!
        let entries: FsEntry[]
        try { entries = await deps.readDir(next.path ? absolute(next.path) : target.root, target) }
        catch (error) {
          assertCurrent()
          throw new Error(`无法搜索目录 ${next.path || '工作区'}：${error instanceof Error ? error.message : String(error)}`)
        }
        assertCurrent()
        for (const entry of entries) {
          assertCurrent()
          if (!entry.name || /[/\\]/.test(entry.name)) throw new Error('工作区目录包含无效文件名')
          const path = relativePath(next.path ? `${next.path}/${entry.name}` : entry.name)
          // Do not follow a malformed response back to an ancestor or outside the captured root.
          if (identity(entry.path.replace(/\\/g, '/')) !== identity(absolute(path))) {
            throw new Error(`工作区目录路径不一致：${path}`)
          }
          if (entry.name === '.git' || remoteSearchPathExcluded(path, options, excludes)) continue
          const key = identity(absolute(path))
          if (visited.has(key)) throw new Error(`工作区目录包含重复路径：${path}`)
          visited.add(key)
          if (entry.isDirectory) {
            if (next.depth >= limits.depth) throw new Error(`工作区目录超过搜索深度（${limits.depth} 层），请增加排除范围`)
            if (directories + pending.length >= limits.directories) throw new Error(`工作区目录超过搜索上限（${limits.directories} 个），请增加排除范围`)
            pending.push({ path, depth: next.depth + 1 })
          } else {
            if (files.length >= limits.files) throw new Error(`工作区文件超过搜索上限（${limits.files} 个），请增加排除范围`)
            files.push(path)
          }
        }
      }
      assertCurrent()
      return workSearchFileTree(files)
    },
    async readFile(path) {
      assertCurrent()
      const fullPath = absolute(path), key = identity(fullPath)
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
      if (!completeReads.has(key)) throw new Error('文件尚未完整读取，无法安全替换')
      completeReads.delete(key)
      await deps.writeFile(fullPath, content, target)
      // The replacer records this completed write before checking cancellation;
      // throwing here would hide a real disk change from Work preview refreshes.
    }
  }
}
