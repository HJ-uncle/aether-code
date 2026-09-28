/**
 * 提交历史泳道图单行渲染（移植自 wuzu-client components/code/GitHistoryGraph.vue，
 * 逐段对齐 VSCode scmHistory.renderSCMHistoryItemGraph）：
 * - 泳道状态由 core/git/git-history-graph 的 buildHistoryViewModels 按行预计算
 *   （inputSwimlanes/outputSwimlanes），本组件只负责画，不维护 lane 表。
 * - 关键规则（与源/VSCode 一致）：
 *   1. 行走指针配对：input/output 泳道按位置对齐（不按 id 查找），lane 不交叉换位
 *   2. 被消费（终止）的 lane 不画任何线，避免搁板横线
 *   3. 当前提交的重复 lane：画「/ + 横线」汇入圆点
 *   4. merge 额外父：行中部「- + \」弧线从圆点弯入目标 lane
 * - 节点样式：merge 双层圆，普通提交单圆，HEAD 外圈高亮。
 * 泳道颜色来自 LANE_COLORS 数据源（VSCode 同款循环取色），不走 CSS 变量。
 */
import { useMemo, type JSX } from 'react'
import type { HistoryItemViewModel } from '@renderer/core/git/git-history-graph'

const ROW_HEIGHT = 22
const LANE_WIDTH = 11
const CURVE_R = 5

export function GitHistoryGraph({ item }: { item: HistoryItemViewModel }): JSX.Element {
  const input = item.inputSwimlanes
  const output = item.outputSwimlanes

  /** 圆点所在 lane 下标：input 中指向当前提交的位置，否则追加到末尾 */
  const circleIndex = useMemo(() => {
    const idx = input.findIndex((n) => n.id === item.hash)
    return idx >= 0 ? idx : input.length
  }, [input, item.hash])

  const svgWidth = LANE_WIDTH * (Math.max(input.length, output.length, 1) + 1)
  const isMerge = item.parents.length > 1
  const circleX = LANE_WIDTH * (circleIndex + 1)

  /** 从后往前找 lane 下标（对齐 VSCode findLastIndex） */
  const findLastIdx = (nodes: { id: string }[], id: string): number => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].id === id) return i
    }
    return -1
  }

  /** 行内全部 path（对照 VSCode renderSCMHistoryItemGraph 的绘制顺序） */
  const paths = useMemo(() => {
    const segs: { d: string; color: string }[] = []
    const cx = circleX
    let outPtr = 0

    /** 圆点颜色（对齐 VSCode circleColor：output 优先，input 次之） */
    const nodeColor = (): string => {
      if (circleIndex < output.length) return output[circleIndex].color
      if (circleIndex < input.length) return input[circleIndex].color
      return output[0]?.color ?? input[0]?.color ?? '#FFB000'
    }

    for (let index = 0; index < input.length; index++) {
      const color = input[index].color

      if (input[index].id === item.hash) {
        // 当前提交占用的 lane：不在圆点位的（重复 lane）画「/ + 横线」汇入圆点
        if (index !== circleIndex) {
          segs.push({
            color,
            d: `M ${LANE_WIDTH * (index + 1)} 0 A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * index} ${LANE_WIDTH}`
          })
          segs.push({ color, d: `M ${LANE_WIDTH * index} ${LANE_WIDTH} H ${cx}` })
        } else {
          outPtr++
        }
        continue
      }

      // 非当前提交 lane：与 output 按位置配对
      if (outPtr < output.length && input[index].id === output[outPtr].id) {
        if (index === outPtr) {
          // 同位直行竖线
          segs.push({ color, d: `M ${LANE_WIDTH * (index + 1)} 0 V ${ROW_HEIGHT}` })
        } else {
          // 左移收拢：竖线 + S 弯 + 横线 + S 弯 + 竖线
          segs.push({
            color,
            d: [
              `M ${LANE_WIDTH * (index + 1)} 0`,
              'V 6',
              `A ${CURVE_R} ${CURVE_R} 0 0 1 ${LANE_WIDTH * (index + 1) - CURVE_R} ${ROW_HEIGHT / 2}`,
              `H ${LANE_WIDTH * (outPtr + 1) + CURVE_R}`,
              `A ${CURVE_R} ${CURVE_R} 0 0 0 ${LANE_WIDTH * (outPtr + 1)} ${ROW_HEIGHT / 2 + CURVE_R}`,
              `V ${ROW_HEIGHT}`
            ].join(' ')
          })
        }
        outPtr++
      }
      // 配对失败 = lane 在此行终止：不画线（VSCode 同款）
    }

    // merge 额外父：行中部「横线 + 弧线」从圆点弯入目标 lane 底部
    for (let pi = 1; pi < item.parents.length; pi++) {
      const pOut = findLastIdx(output, item.parents[pi])
      if (pOut < 0) continue
      const color = output[pOut].color
      segs.push({
        color,
        d: `M ${LANE_WIDTH * pOut} ${ROW_HEIGHT / 2} A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * (pOut + 1)} ${ROW_HEIGHT}`
      })
      segs.push({ color, d: `M ${LANE_WIDTH * pOut} ${ROW_HEIGHT / 2} H ${cx}` })
    }

    // 圆点上半段竖线（| to *）
    if (circleIndex < input.length && input[circleIndex].id === item.hash) {
      segs.push({ color: input[circleIndex].color, d: `M ${cx} 0 V ${ROW_HEIGHT / 2}` })
    }

    // 圆点下半段竖线（| from *）
    if (item.parents.length > 0) {
      segs.push({ color: nodeColor(), d: `M ${cx} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}` })
    }

    return { segs, nodeColor }
  }, [input, output, item.hash, item.parents, circleIndex, circleX])

  const color = paths.nodeColor()

  return (
    <svg width={svgWidth} height={ROW_HEIGHT} className="git-graph" aria-hidden="true">
      {paths.segs.map((seg, i) => (
        <path
          key={`p${i}`}
          d={seg.d}
          fill="none"
          stroke={seg.color}
          strokeWidth={1}
          strokeLinecap="round"
        />
      ))}
      {isMerge ? (
        <>
          <circle
            cx={circleX}
            cy={11}
            r={6}
            fill={color}
            stroke="var(--bg-app)"
            strokeWidth={1.5}
          />
          <circle cx={circleX} cy={11} r={3} fill="var(--bg-app)" />
        </>
      ) : (
        <circle
          cx={circleX}
          cy={11}
          r={4.5}
          fill={color}
          stroke="var(--bg-app)"
          strokeWidth={1.5}
        />
      )}
      {item.isHead ? (
        <circle
          cx={circleX}
          cy={11}
          r={7.5}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          opacity={0.9}
        />
      ) : null}
    </svg>
  )
}
