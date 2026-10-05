/**
 * 提交信息输入与提交操作栏（仅在 Git 管理视图中显示）
 *
 * 移植自 wuzu-client components/code/GitCommitBar.vue：
 * - 输入框随内容自动撑高（最多 10 行），Enter 提交（仅当主按钮处于提交态）；
 * - 右上角 AI 生成提交信息按钮（gitSuggestCommitMessage，成功后回填输入框）；
 * - 主操作槽位：有改动时「提交」（暂存区非空只提交暂存区，否则 smart commit 全量）；
 *   仓库干净后按上游状态切换为「同步更改」/「发布」，与 VSCode actionButton 优先级链一致；
 * - 右侧下拉（ContextMenu）：提交（暂存区）/ 提交（全部改动）/ 提交并推送 / 提交并同步 /
 *   amend / undo / 空提交 / 同步 / 拉取 / 推送|发布。
 *
 * 与源的差异：错误反馈走全局 toast（core/toast.ts）。
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { toast } from '../../core/toast'
import {
  useGitStore,
  busyOperationOf,
  canCommitOf,
  canCommitStagedOf,
  hasChangesToCommitOf,
  stagedFilesOf,
  changeCountOf,
  setCommitMessage,
  commit,
  commitStaged,
  commitAll,
  commitAmend,
  undoCommit,
  commitEmpty,
  push,
  forceRefreshGit,
  gitRemoteStore,
  mergeStrategyStore
} from '../../core/git/git-store'
import { gitSuggestCommitMessage } from '../../core/git/git-client'
import { utilityChat } from '../../core/engine/utility-chat'
import { useApp } from '../../core/app-context'
import { runGitRemoteAction, type GitRemoteAction } from '../../core/git/git-remote-actions'
import { chooseMergeStrategy, type ChooseStrategy } from '../../core/git/git-merge-strategy'
import { ContextMenu, type ContextMenuItem } from '../../workbench/ContextMenu'
import { PromptDialog } from '../../workbench/PromptDialog'
import { pickDivergedStrategy } from './DivergedStrategyDialog'
import { Icon } from '../../workbench/icons'

/**
 * 规整模型返回的提交信息，保留标题下面的正文。
 *
 * 轻任务模型有时会把结果包在 Markdown 围栏或“提交信息：”标签里；
 * 这里只清理包装，不截断正文，避免几十个文件的改动最后只剩一句标题。
 */
export function cleanAiCommitMessage(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // 只去掉包裹整段结果的围栏；正文里的 Markdown 反引号属于有效内容，不能全局删除。
  if (text.startsWith('```')) {
    const openingLineEnd = text.indexOf('\n')
    text = openingLineEnd >= 0 ? text.slice(openingLineEnd + 1) : text.slice(3)
    text = text.replace(/\s*```$/i, '').trim()
  }
  if (!text) return ''

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  if (lines.length === 0) return ''

  // 常见的模型包装标签不属于提交正文。
  lines[0] = lines[0]
    .replace(/^(?:提交信息|commit message|message|标题)\s*[:：]\s*/i, '')
    .trim()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  let value = lines.join('\n').trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1).trim()
  }
  return value
}

/** 远程操作的中文名（进度文案与失败提示共用） */
const labels: Record<GitRemoteAction, string> = {
  sync: '同步',
  pull: '拉取',
  pullRebase: '拉取（变基）',
  push: '推送',
  fetch: '获取',
  publish: '发布分支'
}

export function GitCommitBar(): JSX.Element {
  const s = useGitStore()
  const { settings } = useApp()
  const [suggesting, setSuggesting] = useState(false)
  const [remotePending, setRemotePending] = useState<GitRemoteAction | ''>('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** SSH 口令 / 空提交信息两个对话框的开关 */
  const [sshAsk, setSshAsk] = useState<{ resolve: (v: string | null) => void } | null>(null)
  const [emptyAsk, setEmptyAsk] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const opBusy = busyOperationOf(s) !== ''
  const hasChanges = hasChangesToCommitOf(s)
  const canCommit = canCommitOf(s)
  const canCommitStaged = canCommitStagedOf(s)
  const hasPendingSync = (s.ahead ?? 0) > 0 || (s.behind ?? 0) > 0

  /** 主按钮语义：Commit > Publish > Sync（对齐 VSCode actionButton） */
  const primaryMode: 'commit' | 'publish' | 'sync' = hasChanges
    ? 'commit'
    : !s.upstream
      ? 'publish'
      : hasPendingSync
        ? 'sync'
        : 'commit'
  const primaryDisabled = opBusy
    ? true
    : primaryMode === 'commit'
      ? !canCommit
      : !s.isRepo || !s.branch || s.loading
  const primaryBusy = remotePending !== ''
  const pendingLabel = remotePending ? labels[remotePending] : ''
  const primaryIdle = primaryMode === 'commit' && !hasChanges
  const primaryLabel = primaryBusy
    ? pendingLabel
    : primaryMode === 'commit'
      ? '提交'
      : primaryMode === 'publish'
        ? '发布'
        : '同步更改'
  const primaryTitle = primaryBusy
    ? `正在${pendingLabel}…`
    : opBusy
      ? '正在执行 Git 操作…'
      : primaryIdle
        ? '工作区干净，且本地与远程已一致'
        : primaryMode === 'commit'
          ? hasChanges && stagedFilesOf(s).length === 0
            ? '提交全部改动（暂存区为空，将自动全部暂存后提交）'
            : '提交暂存区（Enter）'
          : primaryMode === 'publish'
            ? '发布当前分支到 origin 并设置上游'
            : `同步更改：${s.behind ?? 0} 个待拉取，${s.ahead ?? 0} 个待推送`

  /** 输入框随内容自动撑高，最高 10 行 */
  const autosize = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 18 * 10 + 8)}px`
  }
  useEffect(autosize, [s.commitMessage])

  const handleSuggest = async (): Promise<void> => {
    if (suggesting) return
    setSuggesting(true)
    try {
      const res = await gitSuggestCommitMessage(s.cwd)
      if (!res.success) {
        toast.error(res.error ?? '生成失败，请稍后重试')
        return
      }
      // AI 增强：有改动上下文时让轻任务模型读 diff 生成更贴合的信息；
      // 失败（未配置模型 / 引擎不可用）时保留本地启发式文案，但明确告知用户，
      // 避免按钮看起来像没有执行任何操作。
      if (res.aiContext) {
        let aiError: string | null = null
        try {
          const ai = await utilityChat({
            // 轻任务模型为空时跟随当前主对话模型；设置页的语义就是如此。
            model: settings.utilityModelId || settings.lastModelId || undefined,
            systemPrompt:
              '你是资深工程师，负责根据完整 git 改动摘要撰写提交信息。规则：使用中文；' +
              '第一行写 Conventional Commits 标题（feat/fix/refactor/docs/style/test/chore/build/perf 前缀，尽量不超过 72 个字符）；' +
              '标题后空一行，再写 3-6 条带序号的正文要点（使用“1. ”、“2. ”格式），按功能或目录归纳具体改动及目的，覆盖主要改动而不是只写一个笼统结论；' +
              '只根据提供的统计、文件清单和 diff 片段，不要臆测；不要逐行罗列文件，不要输出解释、引号或代码围栏。',
            userPrompt: `以下是本次 git 改动的统计、文件清单和 diff 片段。请生成完整的标题 + 正文提交信息，确保正文能反映这次较大范围改动：\n\n${res.aiContext}`,
            temperature: 0.4,
            // Reasoning models can spend the first few hundred tokens on hidden
            // thinking; reserve enough room for the visible one-line result.
            // Thinking tokens are counted by the gateway even at low effort;
            // keep enough reserve for both the title and the grouped body.
            maxTokens: 4000
          })
          const cleaned = cleanAiCommitMessage(ai.text)
          if (cleaned) {
            setCommitMessage(cleaned)
            return
          }
          aiError = 'AI 返回了空内容'
        } catch (err) {
          aiError = err instanceof Error ? err.message : '请求失败'
        }
        if (res.message) {
          setCommitMessage(res.message)
          toast.warning(`AI 提交信息不可用（${aiError ?? '返回为空'}），已使用本地摘要`)
          return
        }
      }
      if (res.message) setCommitMessage(res.message)
      else toast.error('生成失败，请稍后重试')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成失败，请稍后重试')
    } finally {
      setSuggesting(false)
    }
  }

  const handleCommit = async (): Promise<void> => {
    if (!canCommit) return
    const smart = stagedFilesOf(s).length === 0
    const res = await commit()
    if (res.success) toast.success(smart ? '已提交全部改动' : '提交成功')
    else toast.error(res.error ?? '提交失败')
  }

  /** SSH 私钥口令：PromptDialog 承载，密码语义靠 note 提示（aether PromptDialog 无 inputType） */
  const requestSshPassphrase = (): Promise<string | null> =>
    new Promise((resolve) => setSshAsk({ resolve }))

  /** 分叉时弹「合并/变基/取消」Dialog 并 resolve 对应值（弹窗由 DivergedStrategyDialogHost 渲染） */
  const chooseStrategy: ChooseStrategy = (info) => pickDivergedStrategy(info.detail)

  const runRemote = async (action: GitRemoteAction): Promise<void> => {
    if (opBusy || remotePending) return
    setRemotePending(action)
    const cwd = s.cwd
    try {
      const result = await runGitRemoteAction(gitRemoteStore, action, {
        requestSshPassphrase,
        choosePullStrategy: () => chooseMergeStrategy(mergeStrategyStore, chooseStrategy)
      })
      if (gitRemoteStore.cwd === cwd && (action === 'sync' || action === 'pull')) {
        await forceRefreshGit()
      }
      if (!result) return
      if (result.success) toast.success(`${labels[action]}完成`)
      else toast.error(result.error ?? `${labels[action]}失败`)
    } finally {
      setRemotePending('')
    }
  }

  const handlePrimary = (): void => {
    if (primaryMode === 'commit') void handleCommit()
    else void runRemote(primaryMode === 'publish' ? 'publish' : 'sync')
  }

  const committingAny = ((): boolean => {
    if (s.committing || opBusy) return true
    if (primaryMode !== 'commit') return false
    return !canCommit && !(changeCountOf(s) > 0 && s.commitMessage.trim().length > 0)
  })()

  const runSimple = async (
    action: () => Promise<{ success: boolean; error?: string }>,
    ok: string
  ): Promise<void> => {
    const res = await action()
    if (res.success) toast.success(ok)
    else toast.error(res.error ?? '操作失败')
  }

  const menuItems: ContextMenuItem[] =
    primaryMode === 'commit'
      ? [
          {
            id: 'commit',
            label: '提交（暂存区）',
            disabled: opBusy || !canCommitStaged,
            onSelect: () => void runSimple(commitStaged, '提交成功')
          },
          {
            id: 'commitAll',
            label: '提交（全部改动）',
            disabled: opBusy || changeCountOf(s) === 0 || !s.commitMessage.trim(),
            onSelect: () => void runSimple(commitAll, '已提交全部改动')
          },
          {
            id: 'commitPush',
            label: '提交并推送',
            disabled: opBusy || !hasChanges,
            onSelect: () => {
              void (async () => {
                const c = await commit()
                if (!c.success) return toast.error(c.error ?? '提交失败')
                const p = await push()
                if (p.success) toast.success('已提交并推送')
                else toast.error(p.error ?? '推送失败')
              })()
            }
          },
          {
            id: 'commitSync',
            label: '提交并同步',
            disabled: opBusy || !hasChanges,
            onSelect: () => {
              void (async () => {
                const c = await commit()
                if (!c.success) return toast.error(c.error ?? '提交失败')
                await runRemote('sync')
              })()
            }
          },
          {
            id: 'amend',
            label: '修补上一次提交（amend）',
            disabled: opBusy,
            onSelect: () => void runSimple(() => commitAmend(), '已修补上一次提交')
          },
          {
            id: 'undo',
            label: '撤销上一次提交',
            disabled: opBusy,
            onSelect: () => void runSimple(undoCommit, '已撤销上一次提交')
          },
          { id: 'empty', label: '空提交…', disabled: opBusy, onSelect: () => setEmptyAsk(true) }
        ]
      : [
          {
            id: 'sync',
            label: '同步更改（先拉取再推送）',
            disabled: opBusy || !s.upstream,
            onSelect: () => void runRemote('sync')
          },
          {
            id: 'pull',
            label: '拉取',
            disabled: opBusy || !s.upstream,
            onSelect: () => void runRemote('pull')
          },
          {
            id: 'push',
            label: s.upstream ? '推送' : '发布分支到 origin',
            disabled: opBusy,
            onSelect: () => void runRemote(s.upstream ? 'push' : 'publish')
          }
        ]

  return (
    <div className="git-commitbar">
      <div className="git-commitbar__input-wrap">
        <textarea
          ref={inputRef}
          className="git-commitbar__input"
          rows={1}
          value={s.commitMessage}
          placeholder="提交信息"
          onChange={(event) => setCommitMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (primaryMode === 'commit') void handleCommit()
            }
          }}
        />
        <button
          type="button"
          className={`git-commitbar__ai${suggesting ? ' is-spinning' : ''}`}
          disabled={suggesting}
          title="AI 帮我写提交信息"
          onClick={() => void handleSuggest()}
        >
          <Icon name="sparkles" size={16} />
        </button>
      </div>

      <div className="git-commitbar__actions">
        <button
          type="button"
          className="git-commitbar__primary"
          disabled={primaryDisabled}
          title={primaryTitle}
          onClick={handlePrimary}
        >
          <Icon
            name={
              primaryMode === 'commit'
                ? 'check'
                : primaryMode === 'publish'
                  ? 'cloud-upload-outline'
                  : 'sync'
            }
            size={16}
          />
          {primaryLabel}
        </button>
        <button
          type="button"
          className="git-commitbar__more"
          disabled={committingAny}
          title="更多提交方式"
          onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}
        >
          <Icon name="chevron" size={16} />
        </button>
      </div>


      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}

      {sshAsk ? (
        <PromptDialog
          title="加载 SSH 私钥"
          label="请输入 SSH 私钥口令，加载后重试本次操作。"
          confirmLabel="加载并重试"
          validate={(v) => (v ? null : '请输入口令')}
          onConfirm={(v) => sshAsk.resolve(v)}
          onClose={() => {
            sshAsk.resolve(null)
            setSshAsk(null)
          }}
        />
      ) : null}

      {emptyAsk ? (
        <PromptDialog
          title="空提交"
          label="提交信息"
          confirmLabel="创建空提交"
          onConfirm={async (msg) => {
            const res = await commitEmpty(msg)
            if (!res.success) throw new Error(res.error ?? '空提交失败')
            toast.success('已创建空提交')
          }}
          onClose={() => setEmptyAsk(false)}
        />
      ) : null}
    </div>
  )
}
