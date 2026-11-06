import type { GitCommitFileChange } from '@shared/git-types'

export interface GitCommitFileTreeNode {
  path: string
  name: string
  file?: GitCommitFileChange
  children?: GitCommitFileTreeNode[]
}

const naturalOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** Preserve real ancestry; grouping by similar path prefixes can misplace files. */
export function buildCommitFileTree(files: readonly GitCommitFileChange[]): GitCommitFileTreeNode[] {
  const roots: GitCommitFileTreeNode[] = []
  const directories = new Map<string, GitCommitFileTreeNode>()
  const seen = new Set<string>()
  for (const file of files) {
    if (!file.path || seen.has(file.path)) continue
    seen.add(file.path)
    const segments = file.path.split('/')
    let children = roots
    let directoryPath = ''
    for (const name of segments.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${name}` : name
      let directory = directories.get(directoryPath)
      if (!directory) {
        directory = { path: directoryPath, name, children: [] }
        directories.set(directoryPath, directory)
        children.push(directory)
      }
      children = directory.children!
    }
    children.push({ path: file.path, name: segments[segments.length - 1], file })
  }

  const compactAndSort = (nodes: GitCommitFileTreeNode[]): GitCommitFileTreeNode[] => nodes.map(node => {
    if (!node.children) return node
    let directory = { ...node, children: compactAndSort(node.children) }
    // Stop at a branch or a directory containing a file: hiding either would
    // give siblings an incorrect visible parent and lose useful collapse points.
    while (directory.children.length === 1 && directory.children[0].children) {
      const child = directory.children[0]
      directory = { path: child.path, name: `${directory.name}/${child.name}`, children: child.children! }
    }
    return directory
  }).sort((a, b) => Number(!!b.children) - Number(!!a.children)
    || naturalOrder.compare(a.name, b.name) || a.name.localeCompare(b.name, 'zh-CN'))

  return compactAndSort(roots)
}
