import { useMemo, useState, type JSX } from 'react'
import type { GitCommitFileChange } from '@shared/git-types'
import {
  buildCommitFileTree,
  type GitCommitFileTreeNode
} from '@renderer/core/git/git-commit-file-tree'
import { FileTreeRow } from '@renderer/features/explorer/FileTreeRow'

const COMMIT_FILE_ROW_HEIGHT = 24

function codeClass(code: string): string {
  if (code === 'A' || code === 'U') return 'is-added'
  if (code === 'D') return 'is-deleted'
  if (code === 'R' || code === 'C') return 'is-renamed'
  return 'is-modified'
}

interface GitCommitFilesProps {
  files: readonly GitCommitFileChange[]
  viewMode: 'list' | 'tree'
  historicalDiff: boolean
  onOpen: (file: GitCommitFileChange) => void
}

function CommitFileRow({ file, depth, list, historicalDiff, onOpen }: {
  file: GitCommitFileChange
  depth: number
  list?: boolean
  historicalDiff: boolean
  onOpen: (file: GitCommitFileChange) => void
}): JSX.Element {
  const slash = file.path.lastIndexOf('/')
  return (
    <FileTreeRow
      name={file.path.slice(slash + 1)}
      path={file.path}
      title={historicalDiff ? `查看 ${file.path} 在此提交中的变更` : `打开当前工作区的 ${file.path}`}
      depth={depth}
      rowHeight={COMMIT_FILE_ROW_HEIGHT}
      isDirectory={false}
      className="git-panel__commit-file git-panel__commit-tree-row"
      nameClassName="git-panel__commit-file-name"
      indentGuides={!list}
      onClick={(event) => { event.stopPropagation(); onOpen(file) }}
      onActivate={() => onOpen(file)}
      labelSuffix={list && slash > 0 ? (
        <span className="git-panel__commit-file-dir">{file.path.slice(0, slash)}</span>
      ) : undefined}
      trailing={<span className={`git-panel__commit-code ${codeClass(file.code)}`}>{file.code || 'M'}</span>}
    />
  )
}

function CommitTreeNode({ node, depth, historicalDiff, onOpen }: {
  node: GitCommitFileTreeNode
  depth: number
  historicalDiff: boolean
  onOpen: (file: GitCommitFileChange) => void
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  if (node.children) {
    const toggle = (): void => setCollapsed((value) => !value)
    return (
      <div>
        <FileTreeRow
          name={node.name}
          path={node.path}
          depth={depth}
          rowHeight={COMMIT_FILE_ROW_HEIGHT}
          isDirectory
          isExpanded={!collapsed}
          className="git-panel__commit-dir git-panel__commit-tree-row"
          indentGuides
          onClick={(event) => { event.stopPropagation(); toggle() }}
          onActivate={toggle}
        />
        {!collapsed ? (
          <div role="group">
            {node.children.map((child) => (
              <CommitTreeNode key={child.path} node={child} depth={depth + 1}
                historicalDiff={historicalDiff} onOpen={onOpen} />
            ))}
          </div>
        ) : null}
      </div>
    )
  }
  return node.file ? <CommitFileRow file={node.file} depth={depth}
    historicalDiff={historicalDiff} onOpen={onOpen} /> : null
}

/** Directory state belongs to the expanded commit, so retained virtual rows keep it intact. */
export function GitCommitFiles({ files, viewMode, historicalDiff, onOpen }: GitCommitFilesProps): JSX.Element {
  const tree = useMemo(() => buildCommitFileTree(files), [files])
  return (
    <div role="tree" aria-label="提交文件" className="git-panel__commit-file-tree">
      {viewMode === 'tree' ? tree.map((node) => (
        <CommitTreeNode key={node.path} node={node} depth={0} historicalDiff={historicalDiff} onOpen={onOpen} />
      )) : files.map((file) => (
        <CommitFileRow key={file.path} file={file} depth={0} list historicalDiff={historicalDiff} onOpen={onOpen} />
      ))}
    </div>
  )
}
