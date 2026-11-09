import { fileTreePathKey, isFileTreePathWithin } from '@renderer/core/workspace/file-tree-memory'

export interface WorkWorkspaceReferenceEntry {
  path: string
  kind: 'file' | 'directory'
}

/** A folder and a specifically selected child are separate references. Unlike
 * move/delete, reference selection also includes the workspace root itself. */
export function workWorkspaceReferencePaths(input: readonly string[], root: string): string[] {
  return [...new Map(input.filter(path => isFileTreePathWithin(root, path))
    .map(path => [fileTreePathKey(path), path])).values()]
}

/** Publish only a complete selection still owned by the initiating task. */
export async function resolveWorkWorkspaceReferences(
  selected: readonly string[],
  root: string,
  readInfo: (path: string) => Promise<{ isDirectory: boolean }>,
  current: () => boolean
): Promise<WorkWorkspaceReferenceEntry[] | null> {
  if (!current()) return null
  const paths = workWorkspaceReferencePaths(selected, root)
  const entries = await Promise.all(paths.map(async (path): Promise<WorkWorkspaceReferenceEntry> => ({
    path, kind: (await readInfo(path)).isDirectory ? 'directory' : 'file'
  })))
  return current() ? entries : null
}
