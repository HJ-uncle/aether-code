/**
 * Git 状态配色与角标（移植自 wuzu-client components/code/gitStatusVisuals.ts）
 *
 * 视觉值沿用 VSCode gitDecoration 系（色值落在 --git-* 主题令牌里，深浅各一套），
 * 与布局无关的纯数据：与 wuzu 版唯一的差异是不再返回 Tailwind class（本项目不是
 * Tailwind 工程），只导出颜色引用与字母，配色到 CSS class 的映射由 git-format 消费。
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

/** 状态色：引用主题令牌，不写死 hex。
 *  令牌在深浅两套外观各有取值（浅色版刻意压深，深色那套放在 #fafafa 上对比度不足），
 *  写死 hex 会让 git 面板在浅色模式里沿用深色配色。
 *  深色下的取值与原先的 hex 完全一致，此处只是改为随主题解析。 */
export const STATUS_COLOR: Record<GitVisualKey, string> = {
  modified: 'var(--git-modified)',
  deleted: 'var(--git-deleted)',
  untracked: 'var(--git-added)',
  added: 'var(--git-added)',
  renamed: 'var(--git-modified)',
  copied: 'var(--git-modified)',
  conflict: 'var(--git-deleted)'
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
