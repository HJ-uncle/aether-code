import { useEffect, type JSX } from 'react'
import type { GitCommit, GitFileChange } from '@shared/ipc'
import { documentKey, openFile } from '@renderer/core/editor/editor-store'
import {
  changeCode,
  changeTitle,
  formatCommitDate,
  normalizeGitPath,
  splitRefs
} from '@renderer/core/git/git-format'
import { useGit } from '@renderer/core/git/git-store'
import { setLayout } from '@renderer/core/platform/layout-state'
import { paths } from '@renderer/core/workspace/fs-client'
import { useWorkspace } from '@renderer/core/workspace/workspace-store'
import { Icon } from '@renderer/workbench/icons'

/**
 * 版本控制视图（侧边栏窄栏形态，对标 VS Code 源代码管理）
 *
 * 只读展示：当前分支、工作区改动、最近提交。存在的理由很实际 —— Agent 会
 * 在用户的工作区里直接改文件，用户需要一个不依赖 Agent 自述的核对手段：
 * 「它到底动了哪些文件」在 git status 里一眼可见，比读对话里的话可信。
 *
 * 刻意不做 stage/commit：写操作误操作成本高，终端里做更顺手。
 * 因此这里唯一的交互是「点开某个改动文件看内容」。
 */
export function GitView(): JSX.Element {
  const workspace = useWorkspace()
  const { status, commits, loading, error, loaded, refresh } = useGit()
  const root = workspace.root

  useEffect(() => {
    void refresh(root)
  }, [root, refresh])

  const openChange = (change: GitFileChange): void => {
    if (!root) return
    const filePath = paths.join(root, normalizeGitPath(change.path))
    void openFile(filePath)
    setLayout({ activeEditorView: documentKey(filePath) })
  }

  if (!root) {
    return (
      <div className="settings-view">
        <div className="notice">尚未打开文件夹。打开一个项目后才能读取它的 git 状态。</div>
      </div>
    )
  }

  const staged = status?.changes.filter((item) => item.staged) ?? []
  const unstaged = status?.changes.filter((item) => !item.staged) ?? []

  return (
    <div className="git-view">
      <div className="git-view__toolbar">
        {status?.isRepo ? (
          <>
            <span className="git-view__branch" title="当前分支">
              <Icon name="git" size={13} />
              {status.branch || '未知分支'}
            </span>
            {status.ahead !== null || status.behind !== null ? (
              <span className="chip chip--static" title="相对上游的领先/落后提交数">
                {status.ahead !== null ? `↑${status.ahead}` : ''}
                {status.behind !== null ? ` ↓${status.behind}` : ''}
              </span>
            ) : null}
          </>
        ) : (
          <span className="git-view__summary">非 Git 仓库</span>
        )}

        <div className="chat__toolbar-spacer" />

        <button
          type="button"
          className="chat__toolbar-btn"
          disabled={loading}
          title="重新读取 git 状态与历史"
          onClick={() => void refresh(root)}
        >
          <Icon name="restart" size={13} />
        </button>
      </div>

      {error ? <div className="notice notice--error">{error}</div> : null}

      {!status && loading ? (
        <div className="settings-view__saved">正在读取 git 状态…</div>
      ) : status && !status.isRepo ? (
        <div className="notice">
          当前文件夹不是 git
          仓库（或位于仓库之外）。初始化仓库并提交一次后，这里即可看到状态与历史。
          <br />
          Agent 改过哪些文件属于版本控制信息，IDE 不会替它记录，请以 git 为准。
        </div>
      ) : (
        <>
          <section className="git-view__section">
            <header className="git-view__section-head">
              <Icon name="chevron" size={12} />
              改动
              {loaded && status ? (
                <span className="git-view__count">{status.changes.length}</span>
              ) : null}
            </header>

            <div className="git-view__list">
              {status && status.changes.length === 0 ? (
                <div className="git-view__empty">工作区干净，没有未提交的改动。</div>
              ) : null}

              {staged.length > 0 ? <div className="git-view__group">已暂存</div> : null}
              {staged.map((change) => (
                <ChangeRow key={`s-${change.path}`} change={change} onOpen={openChange} />
              ))}

              {unstaged.length > 0 ? <div className="git-view__group">未暂存</div> : null}
              {unstaged.map((change) => (
                <ChangeRow key={`u-${change.path}`} change={change} onOpen={openChange} />
              ))}
            </div>
          </section>

          <details className="git-view__section" open>
            <summary className="git-view__section-head">
              <Icon name="chevron" size={12} />
              最近提交
              {commits.length > 0 ? (
                <span className="git-view__count">{commits.length}</span>
              ) : null}
            </summary>

            <div className="git-view__list">
              {commits.length === 0 ? (
                <div className="git-view__empty">还没有提交记录。</div>
              ) : (
                commits.map((commit) => <CommitRow key={commit.hash} commit={commit} />)
              )}
            </div>
          </details>
        </>
      )}
    </div>
  )
}

function ChangeRow({
  change,
  onOpen
}: {
  change: GitFileChange
  onOpen: (change: GitFileChange) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`git-change${change.staged ? ' is-staged' : ''}`}
      title={`${change.path}\n${changeTitle(change)}`}
      onClick={() => onOpen(change)}
    >
      <span className={`git-change__code git-change__code--${codeClass(changeCode(change))}`}>
        {changeCode(change)}
      </span>
      <span className="git-change__path">{normalizeGitPath(change.path)}</span>
    </button>
  )
}

function CommitRow({ commit }: { commit: GitCommit }): JSX.Element {
  const refs = splitRefs(commit.refs)

  return (
    <article className="git-commit">
      <div className="git-commit__head">
        <span className="git-commit__hash" title={commit.hash}>
          {commit.shortHash}
        </span>
        {refs.map((ref) => (
          <span key={ref} className="chip chip--static" title={ref}>
            {ref}
          </span>
        ))}
      </div>
      <div className="git-commit__subject" title={commit.subject}>
        {commit.subject}
      </div>
      <div className="git-commit__meta">
        {commit.author} · {formatCommitDate(commit.date)}
      </div>
    </article>
  )
}

/** 角标配色分组：不同状态用不同颜色，避免一列字母全靠读 */
function codeClass(code: string): string {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
    case 'U':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    default:
      return 'other'
  }
}
