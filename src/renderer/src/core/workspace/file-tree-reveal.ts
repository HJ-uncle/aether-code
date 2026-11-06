import type { FsEntry } from '@shared/ipc'
import { fileTreePathKey, isFileTreePathWithin } from './file-tree-memory'

export interface FileTreeReveal {
  path: string
  ancestors: string[]
}

function isAbsolutePath(path: string): boolean {
  if (path.startsWith('//')) return /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(path)
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path)
}

/** A preview path is only a request. Real directory entries authorize each
 * descendant read and supply the spelling used by the visible tree. */
export async function resolveFileTreeReveal({ root, path, readChildren, current = () => true }: {
  root: string
  path: string
  readChildren: (directory: string) => Promise<readonly FsEntry[] | null>
  current?: () => boolean
}): Promise<FileTreeReveal | null> {
  const rootSlashes = root.replace(/\\/g, '/')
  const pathSlashes = path.replace(/\\/g, '/')
  if (!root || !path || !isAbsolutePath(rootSlashes) || !isFileTreePathWithin(root, root)) return null
  // Drive-relative paths depend on process state and cannot identify a file in
  // this workspace. Dot components are rejected rather than resolved away.
  if (/^[A-Za-z]:/.test(pathSlashes) && !isAbsolutePath(pathSlashes)) return null
  if (pathSlashes.startsWith('//') && !isAbsolutePath(pathSlashes)) return null
  const absolute = isAbsolutePath(pathSlashes) ? pathSlashes : `${rootSlashes.replace(/\/+$/, '')}/${pathSlashes}`
  if (!isFileTreePathWithin(root, absolute)) return null
  const rootKey = fileTreePathKey(root)
  const targetKey = fileTreePathKey(absolute)
  if (targetKey === rootKey) return null
  const prefix = rootKey === '/' ? '/' : `${rootKey}/`
  const segments = targetKey.slice(prefix.length).split('/')
  const ancestors = [root]
  let directory = root
  let directoryKey = rootKey
  for (let index = 0; index < segments.length; index++) {
    if (!current()) return null
    const children = await readChildren(directory)
    if (!current() || children === null) return null
    const expectedKey = `${directoryKey === '/' ? '' : directoryKey}/${segments[index]}`
    const entry = children.find(candidate => isFileTreePathWithin(root, candidate.path) && fileTreePathKey(candidate.path) === expectedKey)
    if (!entry) return null
    if (index === segments.length - 1) return entry.isDirectory ? null : { path: entry.path, ancestors }
    if (!entry.isDirectory) return null
    directory = entry.path
    directoryKey = fileTreePathKey(directory)
    ancestors.push(directory)
  }
  return null
}
