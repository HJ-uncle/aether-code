/**
 * 提交历史泳道图预计算（移植自 wuzu-client components/code/gitHistoryGraph.ts，
 * 源对齐 VSCode scmHistory.ts toISCMHistoryItemViewModelArray）：
 * 按 git log 顺序（新→旧）逐行推导每行的 input/output 泳道；
 * lane 状态完全由每行 input/output 数组传递，无独立 lane 表。
 */
import type { GitCommitRef, GitLogEntry } from '@shared/git-types'

export const LOG_PAGE_SIZE = 50

/** 泳道节点：id 为提交哈希，color 为该 lane 颜色 */
export interface GraphNode {
  id: string
  color: string
}

export interface HistoryItemViewModel {
  hash: string
  parents: string[]
  inputSwimlanes: GraphNode[]
  outputSwimlanes: GraphNode[]
  isHead: boolean
  isMerge: boolean
}

/** 与 VSCode 相同的循环取色 */
export const LANE_COLORS = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF']

export function laneColor(index: number): string {
  return LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]
}

/** ref 展示排序：当前分支 > 远程 > 标签 > 其他 */
export function compareRefs(a: GitCommitRef, b: GitCommitRef): number {
  const rank = (r: GitCommitRef): number => (r.type === 'head' ? 0 : r.type === 'remote' ? 1 : r.type === 'tag' ? 2 : 3)
  return rank(a) - rank(b)
}

/**
 * 逐行推导泳道视图模型
 * @param commits git log 输出（新→旧），已带 parents
 * @param headHash 当前检出提交（HEAD 外圈高亮）
 */
export function buildHistoryViewModels(commits: GitLogEntry[], headHash: string): HistoryItemViewModel[] {
  const models: HistoryItemViewModel[] = []
  let colorIndex = -1
  for (const commit of commits) {
    const parents = commit.parents ?? []
    const inputSwimlanes = models.length > 0 ? models[models.length - 1].outputSwimlanes.map((n) => ({ ...n })) : []
    const outputSwimlanes: GraphNode[] = []
    let firstParentAdded = false

    // 第一父：占用 lane 原位替换为父提交（位置不变）；同 id 的重复 lane 不提前去重，
    // 保留到目标提交行再汇入圆点（渲染层画收拢弧，对齐 VSCode）。
    // 根提交（无父）跳过整段：output 为空 = 全部 lane 终止（对齐 VSCode）
    if (parents.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === commit.hash) {
          if (!firstParentAdded) {
            outputSwimlanes.push({ id: parents[0], color: node.color })
            firstParentAdded = true
          }
          continue
        }
        outputSwimlanes.push({ ...node })
      }
    }

    // 其余父（merge）或不在任何 input lane 的提交（新分支头 / 截断边界）：
    // 从 i=0 起全部追加到末尾新 lane，取下一个循环色（对齐 VSCode 的 unprocessed parent 循环）
    for (let i = firstParentAdded ? 1 : 0; i < parents.length; i++) {
      colorIndex = (colorIndex + 1) % LANE_COLORS.length
      outputSwimlanes.push({ id: parents[i], color: laneColor(colorIndex) })
    }

    models.push({
      hash: commit.hash,
      parents,
      inputSwimlanes,
      outputSwimlanes,
      isHead: commit.hash === headHash,
      isMerge: parents.length > 1
    })
  }
  return models
}
