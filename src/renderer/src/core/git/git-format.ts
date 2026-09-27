/**
 * git 视图用的展示格式化（纯函数，可直接单测）
 *
 * 只负责「把 git 的原始字段变成人能看的东西」，不做任何 IO，
 * 因此可以和造数据单测，不需要真的起一个仓库。
 */
import type { GitFileChange } from '@shared/ipc'

/**
 * 变更行的角标字符。
 *
 * git 的状态是 XY 两位（暂存区 / 工作区），其中 ' ' 表示该侧无变化。
 * 角标只显示一个字符，规则：
 *   - 两边都是 '?' → 未跟踪，显示 U（沿用 git 习惯用字）
 *   - 有暂存改动（X 非空格）→ 显示 X，用户最先关心「我暂存了什么」
 *   - 否则显示 Y
 */
export function changeCode(change: GitFileChange): string {
  const { indexStatus, workTreeStatus } = change

  if (indexStatus === '?' && workTreeStatus === '?') return 'U'
  const code = indexStatus !== ' ' ? indexStatus : workTreeStatus
  return code === ' ' ? '·' : code
}

/** 角标悬浮提示：把 XY 两位的含义讲清楚 */
export function changeTitle(change: GitFileChange): string {
  const { indexStatus, workTreeStatus, staged } = change
  if (indexStatus === '?' && workTreeStatus === '?') return '未跟踪（git 尚未纳入版本管理）'
  const parts: string[] = []
  parts.push(`暂存区 ${indexStatus === ' ' ? '无变化' : indexStatus}`)
  parts.push(`工作区 ${workTreeStatus === ' ' ? '无变化' : workTreeStatus}`)
  if (staged) parts.push('已暂存')
  return parts.join(' · ')
}

/** 斜杠统一：git 输出用 /，Windows 下拼接时保持一致，交给主进程 resolve */
export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * 提交时间格式化。
 *
 * 解析失败时原样返回 —— 展示层不该把「看不懂的值」变成「空」，
 * 那会让用户以为数据丢了。
 */
export function formatCommitDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** 提交的引用装饰（HEAD -> main, origin/main）→ 只保留可读的分支/标签名列表 */
export function splitRefs(refs: string): string[] {
  return refs
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^HEAD -> /, ''))
}

/** 状态汇总：给状态栏与视图头部用的一句话描述 */
export function summarizeChanges(status: { changes: GitFileChange[] }): string {
  const total = status.changes.length
  if (total === 0) return '无改动'
  return `${total} 处改动`
}
