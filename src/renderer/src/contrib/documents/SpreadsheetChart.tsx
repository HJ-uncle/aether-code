import { memo, useId, useState, type JSX } from 'react'
import type { SheetChart } from './spreadsheet-charts'
import { spreadsheetChartArc, spreadsheetChartLabelIndices, spreadsheetChartScale, spreadsheetChartSegments, spreadsheetChartSlices } from './spreadsheet-chart-geometry'
import './spreadsheet-chart.css'

const chartNames: Record<SheetChart['type'], string> = { column: '柱状图', bar: '条形图', line: '折线图', area: '面积图', pie: '饼图', doughnut: '环形图', scatter: '散点图', unsupported: '图表' }
const short = (text: string, count = 12): string => Array.from(text).length > count ? Array.from(text).slice(0, count - 1).join('') + '…' : text
const color = (index: number, source?: string): string => source && /^#?[0-9a-f]{6}$/i.test(source) ? '#' + source.replace(/^#/, '') : `var(--document-chart-${index % 8 + 1})`
const actual = (value: number | null | undefined): string => value === null || value === undefined ? '—' : String(value)

function ChartData({ chart }: { chart: SheetChart }): JSX.Element {
  const count = Math.max(chart.categories.length, ...chart.series.map(series => series.values.length), 0)
  return <div className="spreadsheet-chart__data" tabIndex={0} aria-label={`${chart.title}的数据`}>
    <table><thead><tr><th scope="col">{chart.type === 'scatter' ? '点' : '分类'}</th>{chart.series.map((series, index) => <th key={index} scope="col">{series.name}</th>)}</tr></thead>
      <tbody>{Array.from({ length: count }, (_, index) => <tr key={index}><th scope="row">{chart.categories[index] || index + 1}</th>
        {chart.series.map((series, seriesIndex) => <td key={seriesIndex}>{chart.type === 'scatter' ? `(${actual(series.xValues?.[index])}, ${actual(series.values[index])})` : actual(series.values[index])}</td>)}</tr>)}</tbody></table>
  </div>
}

/** This is a read-only rendering of the native chart data. The workbook still
 * owns its editable chart and cells; no image is substituted into the file. */
export const SpreadsheetChart = memo(function SpreadsheetChart({ chart, width = chart.width, height = chart.height, onExpand }: {
  chart: SheetChart; width?: number; height?: number; onExpand?: () => void
}): JSX.Element {
  const [showData, setShowData] = useState(false)
  const clipId = 'sheet-chart-' + useId().replace(/:/g, '')
  const isPie = chart.type === 'pie' || chart.type === 'doughnut'
  const pieValues = chart.series[0]?.values || []
  const slices = isPie ? spreadsheetChartSlices(pieValues) : []
  const empty = !chart.series.some(series => series.values.some(value => value !== null))
  const invalidPie = isPie && (!slices.length || chart.series.length !== 1)
  const plotHeight = Math.max(150, height - 46 - (chart.legend ? 34 : 0) - (chart.warnings.length ? 30 : 0))
  const plotWidth = Math.max(280, width)
  const valueScale = spreadsheetChartScale(chart.series.flatMap(series => series.values), chart.type !== 'scatter')
  const xScale = spreadsheetChartScale(chart.series.flatMap(series => series.xValues || []), false)
  const valueLabelWidth = Math.max(...valueScale.ticks.map(tick => valueScale.formatTick(tick).length * 7), 0)
  const xLabelWidth = Math.max(...xScale.ticks.map(tick => xScale.formatTick(tick).length * 7), 0)
  const margin = { left: chart.type === 'bar' ? Math.min(132, plotWidth * 0.27) : Math.min(plotWidth * 0.35, Math.max(60, valueLabelWidth + 12)), right: chart.type === 'scatter' ? Math.min(100, Math.max(22, xLabelWidth / 2 + 6)) : 22, top: 16, bottom: 42 }
  const area = { x: margin.left, y: margin.top, width: Math.max(30, plotWidth - margin.left - margin.right), height: Math.max(30, plotHeight - margin.top - margin.bottom) }
  const count = Math.max(chart.categories.length, ...chart.series.map(series => series.values.length), 1)
  const categoryLabels = Array.from({ length: count }, (_, index) => short(chart.categories[index] || String(index + 1), 9))
  const categoryWidths = categoryLabels.map(label => Array.from(label).reduce((size, character) => size + (character.codePointAt(0)! > 255 ? 12 : 7), 0))
  const categoryX = (index: number) => area.x + (index + 0.5) / count * area.width
  const valueY = (value: number) => area.y + (1 - valueScale.position(value)) * area.height
  const valueX = (value: number) => area.x + valueScale.position(value) * area.width
  const zeroY = valueY(0), zeroX = valueX(0)
  const legend = isPie ? pieValues.map((value, index) => ({ name: chart.categories[index] || `分类 ${index + 1}`, color: color(index, chart.series[0]?.pointColors?.[index]), value }))
    : chart.series.map((series, index) => ({ name: series.name, color: color(index, series.color), value: undefined }))
  const description = `${chartNames[chart.type]}，${chart.series.length} 个系列，${count} 个数据点。可用“查看数据”读取完整数值。`
  return <section className="spreadsheet-chart" role="figure" aria-label={chart.title || chartNames[chart.type]}
    data-spreadsheet-chart={chart.id} data-chart-type={chart.type} style={{ width, height }}>
    <div className="spreadsheet-chart__heading"><strong title={chart.title}>{chart.title || chartNames[chart.type]}</strong>
      <div className="spreadsheet-chart__actions">
        <button type="button" aria-label={`${showData ? '显示图形' : '查看数据'}：${chart.title}`} aria-pressed={showData} onClick={() => setShowData(value => !value)}>{showData ? '图形' : '数据'}</button>
        {onExpand ? <button type="button" aria-label={`查看图表：${chart.title}`} onClick={onExpand}>查看</button> : null}
      </div>
    </div>
    {showData ? <ChartData chart={chart} /> : chart.type === 'unsupported' ? <div className="spreadsheet-chart__empty">此图表的类型或设置暂不支持预览，原图表已保留。</div>
      : empty || invalidPie ? <div className="spreadsheet-chart__empty">{invalidPie ? '饼图与环形图需要一个非负数值系列，且至少有一个正值。' : '图表尚无可显示的数值。'}</div>
        : <>
          <svg className="spreadsheet-chart__plot" viewBox={`0 0 ${plotWidth} ${plotHeight}`} role="img" aria-label={description}>
            <title>{chart.title || chartNames[chart.type]}</title><desc>{description}</desc>
            <defs><clipPath id={clipId}><rect x={area.x - 5} y={area.y - 5} width={area.width + 10} height={area.height + 10} /></clipPath></defs>
            {!isPie && chart.type !== 'bar' ? <>
              {valueScale.ticks.map((tick, index) => <g key={index} className="spreadsheet-chart__axis"><line x1={area.x} x2={area.x + area.width} y1={valueY(tick)} y2={valueY(tick)} /><text x={area.x - 10} y={valueY(tick) + 4} textAnchor="end">{valueScale.formatTick(tick)}</text></g>)}
              {chart.type === 'scatter' ? xScale.ticks.map((tick, index) => {
                const x = area.x + xScale.position(tick) * area.width
                return <g key={index} className="spreadsheet-chart__axis"><line x1={x} x2={x} y1={area.y} y2={area.y + area.height} /><text x={x} y={area.y + area.height + 24} textAnchor="middle">{xScale.formatTick(tick)}</text></g>
              }) : spreadsheetChartLabelIndices(categoryWidths, area.width).map(index => <text className="spreadsheet-chart__category" key={index} x={categoryX(index)} y={area.y + area.height + 24} textAnchor="middle"><title>{chart.categories[index]}</title>{categoryLabels[index]}</text>)}
              <line className="spreadsheet-chart__baseline" x1={area.x} x2={area.x + area.width} y1={zeroY} y2={zeroY} />
            </> : null}
            {chart.type === 'bar' ? <>
              {valueScale.ticks.map((tick, index) => <g key={index} className="spreadsheet-chart__axis"><line x1={valueX(tick)} x2={valueX(tick)} y1={area.y} y2={area.y + area.height} /><text x={valueX(tick)} y={area.y + area.height + 24} textAnchor="middle">{valueScale.formatTick(tick)}</text></g>)}
              {Array.from({ length: count }, (_, index) => index).filter(index => index % Math.max(1, Math.ceil(count / Math.max(1, Math.floor(area.height / 24)))) === 0).map(index => <text className="spreadsheet-chart__category" key={index} x={area.x - 10} y={area.y + (index + 0.5) / count * area.height + 4} textAnchor="end"><title>{chart.categories[index]}</title>{short(chart.categories[index] || String(index + 1))}</text>)}
              <line className="spreadsheet-chart__baseline" x1={zeroX} x2={zeroX} y1={area.y} y2={area.y + area.height} />
            </> : null}
            {isPie ? <g>{slices.map(slice => <path key={slice.index} data-chart-slice={slice.index}
              d={spreadsheetChartArc(slice, plotWidth / 2, plotHeight / 2, Math.min(plotWidth, plotHeight) * 0.42, chart.type === 'doughnut' ? Math.min(plotWidth, plotHeight) * 0.24 : 0)}
              fill={color(slice.index, chart.series[0]?.pointColors?.[slice.index])} stroke="var(--document-paper)" strokeWidth={1.5}>
              <title>{`${chart.categories[slice.index] || slice.index + 1}：${actual(pieValues[slice.index])}（${Math.round(slice.ratio * 1000) / 10}%）`}</title></path>)}</g> : <g clipPath={`url(#${clipId})`}>
              {chart.series.map((series, seriesIndex) => {
                const ink = color(seriesIndex, series.color)
                if (chart.type === 'column' || chart.type === 'bar') {
                  const horizontal = chart.type === 'bar', slot = (horizontal ? area.height : area.width) / count
                  const thickness = slot * 0.72 / Math.max(1, chart.series.length)
                  return <g key={seriesIndex} data-chart-series={series.name}>{series.values.map((value, index) => {
                    if (value === null) return null
                    const position = slot * index + slot * 0.14 + thickness * seriesIndex
                    const x = horizontal ? Math.min(zeroX, valueX(value)) : area.x + position
                    const y = horizontal ? area.y + position : Math.min(zeroY, valueY(value))
                    const w = horizontal ? Math.abs(valueX(value) - zeroX) : Math.max(0.2, thickness - 1)
                    const h = horizontal ? Math.max(0.2, thickness - 1) : Math.abs(valueY(value) - zeroY)
                    return <rect key={index} data-chart-point={index} x={x} y={y} width={w} height={h} fill={ink}><title>{`${series.name} · ${chart.categories[index] || index + 1}：${value}`}</title></rect>
                  })}</g>
                }
                if (chart.type === 'scatter') return <g key={seriesIndex} data-chart-series={series.name}>{series.values.map((value, index) => {
                  const x = series.xValues?.[index]
                  return value === null || x === null || x === undefined ? null : <circle key={index} data-chart-point={index} cx={area.x + xScale.position(x) * area.width} cy={valueY(value)} r={3.5} fill={ink} fillOpacity={0.85}><title>{`${series.name}：(${x}, ${value})`}</title></circle>
                })}</g>
                return <g key={seriesIndex} data-chart-series={series.name}>{spreadsheetChartSegments(series.values, categoryX, valueY).map((points, index) => {
                  const path = points.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
                  return <g key={index}>
                    {chart.type === 'area' ? <path data-chart-area="true" d={`${path} L ${points[points.length - 1].x} ${zeroY} L ${points[0].x} ${zeroY} Z`} fill={ink} fillOpacity={0.2} /> : null}
                    <path data-chart-line="true" d={path} fill="none" stroke={ink} strokeWidth={2} strokeLinejoin="round" />
                    {points.map(point => <circle key={point.index} data-chart-point={point.index} cx={point.x} cy={point.y} r={count > 150 ? 1.5 : 3} fill={ink}><title>{`${series.name} · ${chart.categories[point.index] || point.index + 1}：${point.value}`}</title></circle>)}
                  </g>
                })}</g>
              })}
            </g>}
          </svg>
          {chart.legend ? <ul className="spreadsheet-chart__legend" aria-label="图例">{legend.map((item, index) => <li key={index} title={item.name}><span style={{ backgroundColor: item.color }} />{short(item.name, 22)}</li>)}</ul> : null}
        </>}
    {chart.warnings.length ? <details className="spreadsheet-chart__warnings"><summary>预览说明 · {chart.warnings.length}</summary><ul>{chart.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
  </section>
})
