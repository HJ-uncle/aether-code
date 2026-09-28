/**
 * git 视图用的展示格式化（纯函数，可直接单测）
 *
 * 只负责「把 git 的原始字段变成人能看的东西」，不做任何 IO，
 * 因此可以和造数据单测，不需要真的起一个仓库。
 *
 * 与 wuzu 移植来的 git-status-visuals 的关系：
 * - git-status-visuals 持有 VSCode gitDecoration 系的字母/hex/排序权重（纯数据表）；
 * - 本文件的 changeCode 消费它的 STATUS_LETTER，并额外给出 aether 组件 CSS
 *   需要的样式 class（`git-change__code--*`）。一处视觉真相，避免两边维护字母表。
 */
import type { GitChangeType, GitFileChange } from '@shared/git-types'
import { STATUS_LETTER, type GitVisualKey } from './git-status-visuals'

const CHANGE_TYPE_LABEL: Record<GitChangeType, string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  untracked: '未跟踪'
}

/** 角标 → aether 组件 CSS class 后缀（components.css 的 .git-change__code--*） */
const CHANGE_TYPE_CLASS: Record<GitVisualKey, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  untracked: 'untracked',
  // 冲突暂归入 deleted 的红色系，视觉上与「需立即处理」的警示一致
  conflict: 'deleted'
}

/**
 * 变更行的角标字符。
 *
 * 一个文件可能同时有暂存与工作区改动（git 的 MM 状态）：
 * 优先显示暂存区变更（用户最先关心「我暂存了什么」），否则显示工作区变更。
 * 冲突优先于一切（对齐 VSCode 冲突徽标永远最显眼的语义）。
 */
export function changeCode(change: GitFileChange): string {
  if (change.conflict) return STATUS_LETTER.conflict
  const type = change.stagedChange ?? change.unstagedChange ?? change.changeType
  return STATUS_LETTER[type] ?? '·'
}

/** 角标对应的组件样式 class 后缀 */
export function changeCodeClass(change: GitFileChange): string {
  if (change.conflict) return CHANGE_TYPE_CLASS.conflict
  const type = change.stagedChange ?? change.unstagedChange ?? change.changeType
  return CHANGE_TYPE_CLASS[type] ?? 'modified'
}

/** 角标悬浮提示：把暂存区/工作区两侧的状态讲清楚 */
export function changeTitle(change: GitFileChange): string {
  if (change.changeType === 'untracked') return '未跟踪（git 尚未纳入版本管理）'
  const parts: string[] = []
  parts.push(`暂存区 ${change.stagedChange ? CHANGE_TYPE_LABEL[change.stagedChange] : '无变化'}`)
  parts.push(`工作区 ${change.unstagedChange ? CHANGE_TYPE_LABEL[change.unstagedChange] : '无变化'}`)
  if (change.conflict) parts.push('合并冲突')
  if (change.staged) parts.push('已暂存')
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
