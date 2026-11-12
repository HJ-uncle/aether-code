/**
 * 行级 diff：所有输入行都保留，只有 LCS 的计算量受限。
 * 公共前后缀不进入 DP；超预算的中段完整按替换展示，并明确标记估算统计。
 */

export interface DiffRow {
  type: 'context' | 'add' | 'del'
  text: string
  /** 旧文件行号（1 起始；add 行无） */
  oldNo?: number
  /** 新文件行号（1 起始；del 行无） */
  newNo?: number
  /** 该行在文件末尾且没有换行符；不能把它和有换行符的行视为相同。 */
  noNewline?: boolean
  /** 超出计算预算的中段按整段替换，增删数量是上界。 */
  approximate?: boolean
}

export interface DiffStats {
  added: number
  removed: number
  approximate: boolean
}

/** 限制二维表的时间和内存，不截断文件内容。 */
const MAX_LCS_CELLS = 1_000_000

/** 渲染上限只影响折叠展示，不能用于统计。 */
export const MAX_RENDER_ROWS = 400
export const DIFF_APPROXIMATION_HINT = '中间差异过大，按整段替换估算；增删行数可能高于实际值。'

/** 换行符属于前一行：空文件是零行，末尾换行也不会多造一行。 */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function makeRow(
  type: DiffRow['type'],
  line: string,
  oldNo?: number,
  newNo?: number,
  approximate = false
): DiffRow {
  const hasNewline = line.endsWith('\n')
  return {
    type,
    text: hasNewline ? line.slice(0, -1) : line,
    ...(oldNo === undefined ? {} : { oldNo }),
    ...(newNo === undefined ? {} : { newNo }),
    ...(!hasNewline ? { noNewline: true } : {}),
    ...(approximate ? { approximate: true } : {})
  }
}

export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  const rows: DiffRow[] = []
  for (let i = 0; i < prefix; i++) rows.push(makeRow('context', oldLines[i], i + 1, i + 1))

  const m = oldEnd - prefix
  const n = newEnd - prefix
  if (m === 0 || n === 0 || (m + 1) * (n + 1) > MAX_LCS_CELLS) {
    // 没有共同的行时，整段替换本身就是精确结果，不必误标为估算。
    const oldMiddle = new Set(oldLines.slice(prefix, oldEnd))
    const approximate = m > 0 && n > 0 && newLines.slice(prefix, newEnd).some(line => oldMiddle.has(line))
    for (let i = prefix; i < oldEnd; i++) rows.push(makeRow('del', oldLines[i], i + 1, undefined, approximate))
    for (let j = prefix; j < newEnd; j++) rows.push(makeRow('add', newLines[j], undefined, j + 1, approximate))
  } else {
    const width = n + 1
    const dp = new Uint32Array((m + 1) * width)
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * width + j] = oldLines[prefix + i] === newLines[prefix + j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
      }
    }

    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (oldLines[prefix + i] === newLines[prefix + j]) {
        rows.push(makeRow('context', oldLines[prefix + i], prefix + i + 1, prefix + j + 1))
        i++
        j++
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        rows.push(makeRow('del', oldLines[prefix + i], prefix + i + 1))
        i++
      } else {
        rows.push(makeRow('add', newLines[prefix + j], undefined, prefix + j + 1))
        j++
      }
    }
    while (i < m) {
      rows.push(makeRow('del', oldLines[prefix + i], prefix + i + 1))
      i++
    }
    while (j < n) {
      rows.push(makeRow('add', newLines[prefix + j], undefined, prefix + j + 1))
      j++
    }
  }

  for (let i = oldEnd, j = newEnd; i < oldLines.length; i++, j++) {
    rows.push(makeRow('context', oldLines[i], i + 1, j + 1))
  }
  return rows
}

export function diffStats(rows: readonly DiffRow[]): DiffStats {
  let added = 0
  let removed = 0
  let approximate = false
  for (const row of rows) {
    if (row.type === 'add') added++
    else if (row.type === 'del') removed++
    if (row.approximate) approximate = true
  }
  return { added, removed, approximate }
}

/** 空文件的创建/删除是文件状态变化，但都是零行文本变化。 */
export function diffForNewFile(newText: string): DiffRow[] {
  return splitLines(newText).map((line, index) => makeRow('add', line, undefined, index + 1))
}

export function diffForDeletedFile(oldText: string): DiffRow[] {
  return splitLines(oldText).map((line, index) => makeRow('del', line, index + 1))
}
