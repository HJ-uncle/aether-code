import { fileTreePathKey, isFileTreePathWithin } from '@renderer/core/workspace/file-tree-memory'

export interface SessionWorkspaceReferenceEntry {
  path: string
  kind: 'file' | 'directory'
}

/** A folder and a specifically selected child are separate references. Unlike
 * move/delete, reference selection also includes the workspace root itself. */
export function sessionWorkspaceReferencePaths(input: readonly string[], root: string): string[] {
  return [...new Map(input.filter(path => isFileTreePathWithin(root, path))
    .map(path => [fileTreePathKey(path), path])).values()]
}

/** Publish only a complete selection still owned by the initiating task. */
export async function resolveSessionWorkspaceReferences(
  selected: readonly string[],
  root: string,
  readInfo: (path: string) => Promise<{ isDirectory: boolean }>,
  current: () => boolean
): Promise<SessionWorkspaceReferenceEntry[] | null> {
  if (!current()) return null
  const paths = sessionWorkspaceReferencePaths(selected, root)
  const entries = await Promise.all(paths.map(async (path): Promise<SessionWorkspaceReferenceEntry> => ({
    path, kind: (await readInfo(path)).isDirectory ? 'directory' : 'file'
  })))
  return current() ? entries : null
}
