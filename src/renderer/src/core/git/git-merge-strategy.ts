/**
 * 分叉时让用户在界面里选择合并方式（移植自 wuzu-client utils/gitMergeStrategy.ts）
 *
 * 本地与远端各自有新提交时 git 会拒绝拉取并要求指定策略。这里与 wuzu 的差异：
 * wuzu 版直接弹 element-plus 的 MessageBox；aether 没有该组件，故把 UI 剥离——
 * 选择策略的弹窗由调用方（GitView 等 UI 层）注入 ChooseStrategy 回调，
 * 本模块只负责「查分叉计数 → 问用户 → 按所选策略重试」的编排。
 */
import type { GitResult } from '@shared/git-types'

/** 本模块消费的最小 git store 切面 */
export interface MergeStrategyStore {
  divergence: () => Promise<GitResult & { ahead?: number; behind?: number }>
  pullMerge: (remember: boolean) => Promise<GitResult>
  pullRebaseWithChoice: (remember: boolean) => Promise<GitResult>
}

/** UI 注入的策略选择回调：返回用户选定的策略；取消返回 null（调用方保持现状不再操作） */
export type ChooseStrategy = (info: {
  ahead: number | null
  behind: number | null
  detail: string
}) => Promise<'merge' | 'rebase' | null>

/**
 * 弹出合并方式选择框。分叉计数查询失败时用泛化文案，不阻塞选择。
 * @returns 用户选定的策略；取消返回 null
 */
export async function chooseMergeStrategy(
  store: MergeStrategyStore,
  choose: ChooseStrategy
): Promise<'merge' | 'rebase' | null> {
  const diff = await store.divergence()
  const detail = diff.success
    ? `本地有 ${diff.ahead} 个远端没有的提交，远端有 ${diff.behind} 个你本地没有的提交。`
    : '本地与远端各自都有新的提交。'
  return choose({
    ahead: diff.success ? (diff.ahead ?? null) : null,
    behind: diff.success ? (diff.behind ?? null) : null,
    detail
  })
}

/**
 * 拉取因分叉失败时，就地补一次策略选择并按所选策略重试
 * @returns 重试结果；用户放弃选择时返回 null，调用方应保持现状
 */
export async function pullWithStrategy(
  store: MergeStrategyStore,
  choose: ChooseStrategy
): Promise<GitResult | null> {
  const strategy = await chooseMergeStrategy(store, choose)
  if (!strategy) return null
  return strategy === 'rebase' ? store.pullRebaseWithChoice(true) : store.pullMerge(true)
}
