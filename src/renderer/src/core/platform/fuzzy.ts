/**
 * 模糊匹配（照搬 VS Code fuzzyScorer 的评分行为）
 *
 * 子序列贪心匹配：查询的每个字符按顺序在目标中找位置，全部命中才算匹配。
 * 评分对齐 fuzzyScorer 的核心权重：连续命中、词首命中（字符串开头 /
 * 分隔符后 / 驼峰边界）、大小写一致均加分，目标更短整体分更高。
 * 返回命中位置供列表项逐字符高亮；不匹配返回 null。
 */
export interface FuzzyResult {
  score: number
  /** 命中的目标字符下标（升序） */
  positions: number[]
}

const SCORE_MATCH = 1
const SCORE_CONSECUTIVE = 5
const SCORE_WORD_START = 8
const SCORE_CASE = 1

/** 词首判定：开头 / 分隔符后 / 驼峰边界（小写后跟大写） */
function isWordStart(target: string, index: number): boolean {
  if (index === 0) return true
  const prev = target[index - 1]
  if ('/\\_- .'.includes(prev)) return true
  return target[index] !== target[index].toLowerCase() && prev === prev.toLowerCase()
}

export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (!query) return null
  const qLower = query.toLowerCase()
  const tLower = target.toLowerCase()
  let score = 0
  const positions: number[] = []
  let searchFrom = 0

  for (let i = 0; i < qLower.length; i += 1) {
    const index = tLower.indexOf(qLower[i], searchFrom)
    if (index < 0) return null
    score += SCORE_MATCH
    if (positions.length > 0 && index === positions[positions.length - 1] + 1) {
      score += SCORE_CONSECUTIVE
    }
    if (isWordStart(target, index)) score += SCORE_WORD_START
    if (query[i] === target[index]) score += SCORE_CASE
    positions.push(index)
    searchFrom = index + 1
  }

  // 同分时更短的目标更相关（VS Code 隐含偏好短路径/短命令）
  score += Math.max(0, 16 - Math.floor(target.length / 8))
  return { score, positions }
}
