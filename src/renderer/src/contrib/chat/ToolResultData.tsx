import { useState, type JSX } from 'react'
import { parseToolResultData, toolResultFieldLabel, type ToolResultData as ResultData } from './tool-result-data'

/** Keep ordinary bracketed logs and quoted prose while hiding unreadable JSON. */
export function looksLikeStructuredResult(text: string): boolean {
  return /^(?:\{\s*(?:"|}|$)|\[\s*(?:\{|\[|"|]|$)|\[\s*(?:-?\d[\d.eE+-]*|true|false|null)\s*(?:,|\]$)|"[\s\\]*[\[{])/.test(text.trim())
}

function WorkValue({ value, depth = 0 }: { value: unknown; depth?: number }): JSX.Element {
  const [expanded, setExpanded] = useState(depth < 2)
  const [limit, setLimit] = useState(12)
  // Some tools wrap their actual result in a JSON string inside a text block.
  // Decode that layer too so it does not escape the readable Work presentation.
  const nestedData = typeof value === 'string' ? parseToolResultData(value) : null
  if (nestedData && depth < 32) return <WorkValue value={nestedData} depth={depth} />
  if (typeof value === 'string' && looksLikeStructuredResult(value)) return <span className="tool-result-data__empty">内容暂无法整理</span>
  if (value === null) return <span className="tool-result-data__empty">未提供</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (typeof value !== 'object') return <span className="tool-result-data__value">{String(value)}</span>
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value)
  if (!entries.length) return <span className="tool-result-data__empty">无</span>
  if (depth >= 32) return <span className="tool-result-data__empty">内容层级过多，暂无法展示</span>
  return <>
    {depth >= 2 ? <button type="button" className="tool-result-data__expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? '收起' : '查看'} {entries.length} 项
    </button> : null}
    {expanded ? <dl className="tool-result-data__fields">
      {entries.slice(0, limit).map(([key, item]) => <div key={key}>
        <dt>{toolResultFieldLabel(key)}</dt><dd><WorkValue value={item} depth={depth + 1} /></dd>
      </div>)}
      {entries.length > limit ? <div className="tool-result-data__more"><dt>更多</dt><dd>
        <button type="button" className="tool-result-data__expand" onClick={() => setLimit(limit + 12)}>再显示 {Math.min(12, entries.length - limit)} 项</button>
      </dd></div> : null}
    </dl> : null}
  </>
}

function Value({ value, depth = 0 }: { value: unknown; depth?: number }): JSX.Element {
  if (value === null) return <span className="tool-result-data__empty">未提供</span>
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>
  if (typeof value !== 'object') return <span className="tool-result-data__value">{String(value)}</span>
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value)
  if (!entries.length) return <span className="tool-result-data__empty">无</span>
  if (depth >= 2) return <span className="tool-result-data__empty">{entries.length} 项，展开原始输出查看</span>
  return <dl className="tool-result-data__fields">
    {entries.slice(0, 12).map(([key, item]) => <div key={key}>
      <dt title={key}>{toolResultFieldLabel(key)}</dt><dd><Value value={item} depth={depth + 1} /></dd>
    </div>)}
    {entries.length > 12 ? <div className="tool-result-data__more"><dt>更多</dt><dd>另有 {entries.length - 12} 项，可展开原始输出查看</dd></div> : null}
  </dl>
}

/** Work reads values directly; Code retains the exact receipt for inspection. */
export function ToolResultData({ data, raw, surfaceMode = 'code' }: { data: ResultData; raw: string; surfaceMode?: 'code' | 'work' }): JSX.Element {
  if (surfaceMode === 'work') return <div className="tool-result-data tool-result-data--work"><WorkValue value={data} /></div>
  return <div className="tool-result-data">
    <Value value={data} />
    <details className="tool-result__metadata"><summary>原始输出</summary><pre>{raw}</pre></details>
  </div>
}
