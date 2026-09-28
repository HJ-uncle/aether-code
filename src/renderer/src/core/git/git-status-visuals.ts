/**
 * Git 状态配色与角标（移植自 wuzu-client components/code/gitStatusVisuals.ts）
 *
 * 视觉值沿用 VSCode gitDecoration 系（dark_plus 取色），与布局无关的纯数据：
 * 与 wuzu 版唯一的差异是不再返回 Tailwind class（本项目不是 Tailwind 工程），
 * 只导出 hex 与字母，配色到 CSS class 的映射由 aether 的 git-format 消费。
 */
import type { GitChangeType } from '@shared/git-types'

/** 冲突态的视觉 key：文件同时存在 changeType 与 conflict 时，conflict 优先 */
export type GitVisualKey = GitChangeType | 'conflict'

/** 状态字母（VSCode 标签同款）：M / D / U / A / R / C；冲突显示 C! */
export const STATUS_LETTER: Record<GitVisualKey, string> = {
  modified: 'M',
  deleted: 'D',
  untracked: 'U',
  added: 'A',
  renamed: 'R',
  copied: 'C',
  conflict: 'C!'
}

/** 状态色（VSCode gitDecoration dark 系 hex） */
export const STATUS_COLOR: Record<GitVisualKey, string> = {
  modified: '#e2c08d',
  deleted: '#f14c4c',
  untracked: '#73c991',
  added: '#73c991',
  renamed: '#e2c08d',
  copied: '#e2c08d',
  conflict: '#f14c4c'
}

/** 状态排序权重（同列多个状态时优先级，便于排序） */
export const STATUS_RANK: Record<GitVisualKey, number> = {
  modified: 1,
  added: 2,
  untracked: 3,
  renamed: 4,
  copied: 5,
  deleted: 6,
  conflict: 0
}

/**
 * 取一行文件状态的视觉 key：冲突优先于普通变更类型（VSCode 冲突文件永远显示冲突徽标）
 */
export function visualKeyOf(file: { changeType: GitChangeType; conflict?: boolean }): GitVisualKey {
  return file.conflict === true ? 'conflict' : file.changeType
}
