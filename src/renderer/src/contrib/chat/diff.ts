/**
 * 行级 diff（git unified 风格）
 *
 * 自实现而不引依赖：文件规模有限（超长已在引擎侧截断存档），
 * LCS DP 在几百行的量级足够快；超出上限时截断两侧输入保证不卡 UI。
 */

export interface DiffRow {
  type: 'context' | 'add' | 'del'
  text: string
  /** 旧文件行号（1 起始；add 行无） */
  oldNo?: number
  /** 新文件行号（1 起始；del 行无） */
  newNo?: number
}

export interface DiffStats {
  added: number
  removed: number
}

/** 参与比对的最大行数，防止 O(n²) DP 拖垮渲染 */
const MAX_DIFF_LINES = 800

/** 渲染时最多展示的行数（超出部分提示省略） */
export const MAX_RENDER_ROWS = 400

export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  let oldLines = oldText.length ? oldText.split('\n') : []
  let newLines = newText.length ? newText.split('\n') : []
  if (oldLines.length > MAX_DIFF_LINES) oldLines = oldLines.slice(0, MAX_DIFF_LINES)
  if (newLines.length > MAX_DIFF_LINES) newLines = newLines.slice(0, MAX_DIFF_LINES)

  const m = oldLines.length
  const n = newLines.length

  // LCS 长度表（滚动行省内存：只需要回溯方向时才要全表，这里直接建全表）
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: 'context', text: oldLines[i], oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: oldLines[i], oldNo: i + 1 })
      i++
    } else {
      rows.push({ type: 'add', text: newLines[j], newNo: j + 1 })
      j++
    }
  }
  while (i < m) {
    rows.push({ type: 'del', text: oldLines[i], oldNo: i + 1 })
    i++
  }
  while (j < n) {
    rows.push({ type: 'add', text: newLines[j], newNo: j + 1 })
    j++
  }
  return rows
}

export function diffStats(rows: DiffRow[]): DiffStats {
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.type === 'add') added++
    else if (row.type === 'del') removed++
  }
  return { added, removed }
}

/** 新建文件的 diff：全部按新增行展示 */
export function diffForNewFile(newText: string): DiffRow[] {
  const newLines = newText.length ? newText.split('\n') : []
  return newLines.map((text, index) => ({ type: 'add' as const, text, newNo: index + 1 }))
}

/** 删除文件的 diff：全部按删除行展示 */
export function diffForDeletedFile(oldText: string): DiffRow[] {
  const oldLines = oldText.length ? oldText.split('\n') : []
  return oldLines.map((text, index) => ({ type: 'del' as const, text, oldNo: index + 1 }))
}
