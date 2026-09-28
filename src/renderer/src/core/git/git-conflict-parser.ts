/**
 * Git 合并冲突标记解析器（渲染进程侧，纯函数；移植自 wuzu-client components/code/gitConflictParser.ts）
 *
 * 对齐 VSCode extensions/merge-conflict 的解析语义：
 * - 标记行用 startsWith 容忍带 label 的变体（<<<<<<< HEAD、>>>>>>> feature (abc123)）
 * - splitter（=======）要求整行严格相等，避免正文里长横线分隔注释被误判
 * - 支持 diff3 风格的公共祖先段（||||||| ... =======，0 到多个）
 * - 输出「内容区间」与「装饰区间」两套 range：装饰含标记行供上色，
 *   内容只含正文行（替换时不吞掉标记行之外的任何内容）
 *
 * 关键约束：
 * - 只做纯解析，不触碰编辑器实例；Monaco 适配层在编辑器侧
 * - 性能：先做字符串 includes 预检，无标记的文件零扫描
 */

/** 冲突标记常量（与 VSCode mergeConflictParser 相同的容忍集） */
const START_MARKER = '<<<<<<<'
const ANCESTOR_MARKER = '|||||||'
const SPLIT_MARKER = '======='
const END_MARKER = '>>>>>>>'

/** 冲突块内一侧的内容归属 */
export type ConflictSide = 'current' | 'incoming'

/**
 * @description 单侧内容区间（内容与装饰分离，装饰区间含标记行供上色）
 */
export interface ConflictRegion {
  /** 当前分支侧（<<<<<<< 与 ======= 之间）或来源分支侧（======= 与 >>>>>>> 之间） */
  side: ConflictSide
  /** 内容区间（1 起，闭区间）：替换正文用 */
  contentStartLine: number
  contentEndLine: number
  /** 装饰区间（闭区间）：含标记行，上色与定位用 */
  decoStartLine: number
  decoEndLine: number
  /** 标记行上的 label（如 "HEAD (before rebase)"），裸标记为空串 */
  headerLabel: string
}

/** 单个冲突块描述符 */
export interface DocumentMergeConflict {
  /** 整块区间（含首尾标记行，1 起闭区间） */
  rangeStart: number
  rangeEnd: number
  current: ConflictRegion
  incoming: ConflictRegion
  /** diff3 公共祖先段（每段一个内容行闭区间；不含 ||||||| 与 ======= 标记行） */
  commonAncestors: { start: number; end: number }[]
  /** splitter（=======）所在行号 */
  splitterLine: number
  /** 尾标记行号（>>>>>>>） */
  endLine: number
}

/**
 * @description 判断行是否为某类冲突标记（startsWith 容忍尾部 label，如 "<<<<<<< HEAD"）
 */
function isMarker(line: string, marker: string): boolean {
  return line.startsWith(marker)
}

/**
 * @description 提取 marker 之后的 label 文本（去掉 marker 本身与一个空格）
 */
function markerLabel(line: string, marker: string): string {
  return line.length > marker.length ? line.slice(marker.length + 1).trim() : ''
}

/** 状态机扫描中间态 */
interface ScanState {
  /** <<<<<<< 行号（1 起） */
  startLine: number
  label: string
  /** 当前正在累积的内容行起点（0 表示尚未开始） */
  segStart: number
  segEnd: number
  /**
   * current 侧内容段结束行：在首个 ||||||| 或 ======= 处锁定。
   * segEnd 是跨侧复用的累加游标，splitter 之后会继续累积 incoming 段而被污染，
   * 故 current 侧必须单独记录，否则「采用当前更改」会把 ======= 与整段 incoming 一起吞入。
   * 0 表示尚未锁定；空 current 段锁定为 startLine（使 contentStartLine > currentEnd 判空）。
   */
  currentEnd: number
  /** 已闭环的段（祖先段或 current 内容段） */
  closedSegs: { start: number; end: number }[]
}

/**
 * @description 扫描全文，产出冲突块列表。逐行状态机（VSCode scanDocument 语义）：
 * 嵌套 / 未闭合到文件尾的残块一律不产出，避免半残数据驱动 UI
 * @param content 文件全文
 */
export function scanConflicts(content: string): DocumentMergeConflict[] {
  if (!content || !content.includes(START_MARKER) || !content.includes(END_MARKER)) {
    return []
  }
  const lines = content.split('\n')
  const conflicts: DocumentMergeConflict[] = []
  let st: ScanState | null = null
  /** 进入 incoming 侧后 splitter 行号（0 表示仍在 current 侧） */
  let splitterLine = 0

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i].replace(/\r$/, '')
    if (st === null) {
      if (isMarker(line, START_MARKER)) {
        st = {
          startLine: lineNo,
          label: markerLabel(line, START_MARKER),
          segStart: 0,
          segEnd: 0,
          currentEnd: 0,
          closedSegs: []
        }
        splitterLine = 0
      }
      continue
    }
    if (isMarker(line, END_MARKER)) {
      // incoming 内容段在尾标记前闭环
      const incomingStart = splitterLine + 1
      const incomingEnd = splitterLine === 0 ? 0 : lineNo - 1
      // current 段终点用 currentEnd（splitter/ancestor 处已锁定，不受 incoming 累积污染）；
      // 未见过 splitter/ancestor 的畸形块回退 segEnd，保持原有容错行为
      const curEnd = st.currentEnd > 0 ? st.currentEnd : st.segEnd
      conflicts.push({
        rangeStart: st.startLine,
        rangeEnd: lineNo,
        current: {
          side: 'current',
          contentStartLine: st.startLine + 1,
          contentEndLine: curEnd,
          decoStartLine: st.startLine,
          decoEndLine: curEnd > 0 ? curEnd : st.startLine,
          headerLabel: st.label
        },
        incoming: {
          side: 'incoming',
          contentStartLine: incomingStart,
          contentEndLine: incomingEnd,
          decoStartLine: splitterLine,
          decoEndLine: lineNo,
          headerLabel: markerLabel(line, END_MARKER)
        },
        commonAncestors: st.closedSegs.filter((s) => s.start <= s.end),
        splitterLine,
        endLine: lineNo
      })
      st = null
      splitterLine = 0
      continue
    }
    if (isMarker(line, ANCESTOR_MARKER)) {
      // current 侧内容到此闭环，进入祖先段累积
      if (st.currentEnd === 0) {
        st.currentEnd =
          st.segStart > 0 && st.segEnd >= st.segStart ? st.segEnd : st.startLine
      }
      if (st.segStart > 0 && st.segEnd >= st.segStart) {
        st.closedSegs.push({ start: st.segStart, end: st.segEnd })
      }
      st.segStart = 0
      st.segEnd = 0
      continue
    }
    if (splitterLine === 0 && line === SPLIT_MARKER) {
      // current 侧内容闭环（可能是祖先段也可能就是 current 内容，取决于是否见过 |||||||）
      // 首个 splitter（diff3 下 ||||||| 已锁定过则跳过）即 current 段终点
      if (st.currentEnd === 0) {
        st.currentEnd =
          st.segStart > 0 && st.segEnd >= st.segStart ? st.segEnd : st.startLine
      }
      if (st.segStart > 0 && st.segEnd >= st.segStart) {
        st.closedSegs.push({ start: st.segStart, end: st.segEnd })
      }
      st.segStart = 0
      st.segEnd = 0
      splitterLine = lineNo
      continue
    }
    // 普通内容行：累积当前段
    if (st.segStart === 0) {
      st.segStart = lineNo
    }
    st.segEnd = lineNo
  }
  // 文件尾仍有未闭合块：丢弃（残缺标记不驱动 UI）
  return conflicts
}

/**
 * @description 取冲突块某一侧的内容行闭区间（含 diff3 祖先段的归并结果）
 * @param conflict 冲突块
 * @param side 取哪一侧；incoming 在 diff3 模式下可并入祖先段
 */
export function conflictSideLines(
  conflict: DocumentMergeConflict,
  side: ConflictSide,
  includeAncestors = false
): { start: number; end: number }[] {
  if (side === 'current') {
    return conflict.current.contentEndLine >= conflict.current.contentStartLine
      ? [{ start: conflict.current.contentStartLine, end: conflict.current.contentEndLine }]
      : []
  }
  const ranges: { start: number; end: number }[] = []
  if (includeAncestors) {
    ranges.push(...conflict.commonAncestors)
  }
  if (conflict.incoming.contentEndLine >= conflict.incoming.contentStartLine) {
    ranges.push({ start: conflict.incoming.contentStartLine, end: conflict.incoming.contentEndLine })
  }
  return ranges
}

/**
 * @description 闭区间行号集合 → 文本
 */
function sliceLines(lines: string[], ranges: { start: number; end: number }[]): string {
  return ranges
    .map((r) => (r.end >= r.start ? lines.slice(r.start - 1, r.end).join('\n') : ''))
    .filter((t) => t !== '')
    .join('\n')
}

/**
 * @description 提取冲突块某一侧的内容文本
 * @param content 文件全文
 * @param conflict 冲突块
 * @param side 取哪一侧
 * @param includeAncestors diff3 模式下 incoming 侧是否拼入公共祖先段
 */
export function conflictSideText(
  content: string,
  conflict: DocumentMergeConflict,
  side: ConflictSide,
  includeAncestors = false
): string {
  return sliceLines(content.split('\n'), conflictSideLines(conflict, side, includeAncestors))
}

/**
 * @description 单块解决：把冲突整块替换为所选侧内容后的新全文（纯函数，不写盘）
 * @param content 文件全文
 * @param conflict 冲突块
 * @param side 解决方式：current / incoming / both（current 与 incoming 顺序拼接）
 */
export function resolveConflictText(
  content: string,
  conflict: DocumentMergeConflict,
  side: ConflictSide | 'both'
): string {
  const lines = content.split('\n')
  const ranges =
    side === 'both'
      ? [
          ...conflictSideLines(conflict, 'current'),
          ...conflictSideLines(conflict, 'incoming')
        ]
      : conflictSideLines(conflict, side)
  const replacement = sliceLines(lines, ranges)
  const head = lines.slice(0, conflict.rangeStart - 1)
  const tail = lines.slice(conflict.rangeEnd)
  const replaced = replacement === '' ? [] : replacement.split('\n')
  return [...head, ...replaced, ...tail].join('\n')
}

/**
 * @description 解决全部冲突：按块尾从后往前逐块替换，行号不受前块影响
 */
export function resolveAllConflictsText(
  content: string,
  conflicts: DocumentMergeConflict[],
  side: ConflictSide | 'both'
): string {
  let result = content
  const sorted = [...conflicts].sort((a, b) => b.rangeEnd - a.rangeEnd)
  for (const c of sorted) {
    result = resolveConflictText(result, c, side)
  }
  return result
}

/**
 * @description 可撤销编辑计划：编辑器层（MonacoHost）据此起 monaco.Range 调
 * pushEditOperations，只替换冲突块自身行区间，而不是 setValue 整篇重置。
 *
 * range 边界含一个易错点：selected 侧内容为空（如空 current 侧）时要整块删除，
 * 此时替换区间必须连块尾行末的换行一起吞掉，否则块所在行会残留一个空行；
 * 若块已在文件末尾则无换行可吞，故给出 includeTrailingNewline 由调用方决定是否扩行。
 */
export interface ConflictEditPlan {
  /** 被替换区间的起始行（1 起，即 <<<<<<< 所在行） */
  startLine: number
  /** 被替换区间的结束行（1 起，即 >>>>>>> 所在行） */
  endLine: number
  /** 替换文本；空串表示删除整块 */
  text: string
  /** true 时把 endLine 行末换行一并替换（空侧删除用），避免残留空行 */
  includeTrailingNewline: boolean
}

/**
 * @description 生成单块解决的可撤销编辑计划
 * @param content 文件全文
 * @param conflict 冲突块
 * @param side 解决方式：current / incoming / both
 */
export function planConflictEdit(
  content: string,
  conflict: DocumentMergeConflict,
  side: ConflictSide | 'both'
): ConflictEditPlan {
  const lines = content.split('\n')
  const ranges =
    side === 'both'
      ? [...conflictSideLines(conflict, 'current'), ...conflictSideLines(conflict, 'incoming')]
      : conflictSideLines(conflict, side)
  const text = ranges
    .map((r) => (r.end >= r.start ? lines.slice(r.start - 1, r.end).join('\n') : ''))
    .filter((t) => t !== '')
    .join('\n')
  return {
    startLine: conflict.rangeStart,
    endLine: conflict.rangeEnd,
    text,
    includeTrailingNewline: text === '' && conflict.rangeEnd < lines.length
  }
}

/**
 * @description 多块批量解决的可撤销编辑计划，按起始行降序 —— 先改后面的块，
 * 前面各块的行号区间才不会因替换增减行数而失效。
 * @param content 文件全文
 * @param conflicts 冲突块列表
 * @param side 解决方式
 */
export function planAllConflictsEdits(
  content: string,
  conflicts: DocumentMergeConflict[],
  side: ConflictSide | 'both'
): ConflictEditPlan[] {
  return [...conflicts]
    .sort((a, b) => b.rangeStart - a.rangeStart)
    .map((c) => planConflictEdit(content, c, side))
}

/**
 * @description 判断给定行号落在哪个冲突块内（导航/点击定位用）
 */
export function findConflictAtLine(
  conflicts: DocumentMergeConflict[],
  line: number
): DocumentMergeConflict | null {
  for (const c of conflicts) {
    if (line >= c.rangeStart && line <= c.rangeEnd) return c
  }
  return null
}

/**
 * @description 找下一个冲突块（VSCode findConflictForNavigation 语义）：
 * 前向取首个起点在光标之后的块；反向取最后一个起点在光标之前的块；均无时回绕到首/尾块
 */
export function nextConflict(
  conflicts: DocumentMergeConflict[],
  fromLine: number,
  forward: boolean
): DocumentMergeConflict | null {
  if (conflicts.length === 0) return null
  const sorted = [...conflicts].sort((a, b) => a.rangeStart - b.rangeStart)
  if (forward) {
    const next = sorted.find((c) => c.rangeStart > fromLine)
    return next ?? sorted[0]
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].rangeStart < fromLine) return sorted[i]
  }
  return sorted[sorted.length - 1]
}
