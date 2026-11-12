const readReceiptFields = new Set([
  'path', 'expectedHash', 'encoding', 'lineEnding', 'utf8Bom', 'sha256', 'byteLength', 'trailingLineEnding',
  'startLine', 'endLine', 'totalLines', 'content', 'contentIsComplete', 'numberedContent',
  'requestedEndLine', 'startColumn', 'endColumn', 'columnUnit', 'partialLine',
  'hasMore', 'nextStartLine', 'nextStartColumn', 'rangeIsComplete'
])

function hasFileVersion(fields: Record<string, unknown>): boolean {
  // Restored history may predate the engine's explicit sha256: prefix.
  return typeof fields.path === 'string' && typeof fields.expectedHash === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(fields.expectedHash)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function batchReadPreview(fields: Record<string, unknown>, name: string, metadata?: Record<string, unknown>): { content: string } | null {
  if (fields.batch !== true || !Array.isArray(fields.files) || fields.files.length === 0 || fields.files.length > 16) return null
  const files = fields.files.map(record)
  if (files.some(file => !file || typeof file.path !== 'string' || !file.path.trim() || typeof file.success !== 'boolean'
    || !Object.hasOwn(file, 'output') || Object.keys(file).some(key => !['path', 'success', 'executed', 'output', 'error', 'status', 'metadata'].includes(key)))) return null
  const itemMetadata = Array.isArray(metadata?.files) ? metadata.files : []
  const sections = files.map((item, index) => {
    const file = item!
    const output = record(file.output)
    const text = typeof file.output === 'string' ? file.output : JSON.stringify(file.output) ?? ''
    const cancelled = file.status === 'cancelled' || typeof file.error === 'string' && /CANCELLED|CANCELED/.test(file.error)
    if (!file.success) {
      const state = cancelled ? '已取消' : file.executed === false ? '未执行' : '读取失败'
      const reason = typeof output?.message === 'string' ? output.message : typeof file.output === 'string' ? file.output : ''
      const error = typeof file.error === 'string' && !reason.includes(file.error) ? file.error : ''
      return [`${file.path} · ${state}`, reason, error].filter(Boolean).join('\n')
    }
    if (name === 'office_inspect' && output && hasFileVersion(output) && typeof output.content === 'string'
      && output.contentIncluded === true && record(output.contentPage)) {
      const page = record(output.contentPage)!
      const offset = page.offset, returned = page.returnedChars, total = page.totalPreviewChars
      const valid = [offset, returned, total].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        && Number(offset) + Number(returned) <= Number(total) && returned === output.content.length
        && typeof page.hasMore === 'boolean' && typeof page.sourceTruncated === 'boolean' && page.documentComplete === false
        && (page.hasMore ? page.nextOffset === Number(offset) + Number(returned) && Number(returned) > 0 && Number(page.nextOffset) < Number(total)
          : page.nextOffset === null && Number(offset) + Number(returned) === total)
      if (valid) {
        const range = returned ? `预览字符 ${Number(offset) + 1}–${Number(offset) + Number(returned)} / ${total}` : '本页无文字'
        const warnings = Array.isArray(output.warnings) ? output.warnings.filter((warning): warning is string => typeof warning === 'string') : []
        return [`${file.path} · 已检查`, `${range} · ${page.hasMore ? '还有更多内容 · ' : ''}${page.sourceTruncated ? '提取范围有限 · ' : ''}非全文或版式验收`,
          ...warnings.map(warning => `提示：${warning}`), output.content].filter(Boolean).join('\n')
      }
    }
    const preview = name === 'read_file' ? readActivityPreview({ name, state: 'done', result: text,
      metadata: record(file.metadata) ?? record(itemMetadata[index]) ?? undefined }) : null
    return [`${file.path} · 已读取`, preview?.range?.title,
      preview ? preview.content || '文件内容为空' : formatActivityValue(text)].filter(value => value !== undefined && value !== '').join('\n')
  })
  // Line ranges belong to their individual files, never to the batch row.
  return { content: sections.join('\n\n') }
}

export interface ReadActivityLineRange {
  label: string
  title: string
}

export interface ReadActivityFileSummary {
  path: string
  label: string
  range?: string
  title: string
  state?: 'error' | 'cancelled' | 'pending'
}

interface ReadActivityFileTool {
  name: string
  state: string
  result: string
  args?: string
  error?: string
  metadata?: Record<string, unknown>
}

function validReadPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !!value.trim() && !value.includes('\0')
}

function parsedReadRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value)) } catch { /* Legacy read envelopes carry a version header. */ }
  const header = /^\[读取监控\] [^\r\n]+\r?\n\[文件版本\] (\{[^\r\n]+\})\r?\n\[精确编辑\] [^\r\n]+\r?\n\r?\n/.exec(value)
  try { return header ? record(JSON.parse(header[1])) : null } catch { return null }
}

function matchingReadPath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const a = normalize(left), b = normalize(right)
  const windows = /^[a-z]:\//i.test(a) || /^[a-z]:\//i.test(b) || a.startsWith('//') || b.startsWith('//')
  const first = windows ? a.toLowerCase() : a, second = windows ? b.toLowerCase() : b
  if (first === second) return true
  const absolute = (value: string): boolean => value.startsWith('/') || /^[a-z]:\//i.test(value)
  // A receipt may resolve a relative request to an absolute workspace path.
  // Two different absolute paths (including same basenames) are never aliases.
  if (absolute(first) === absolute(second)) return false
  const full = absolute(first) ? first : second, relative = absolute(first) ? second : first
  return !relative.split('/').includes('..') && full.endsWith('/' + relative)
}

function readFileLabels(files: ReadActivityFileSummary[]): ReadActivityFileSummary[] {
  const parts = files.map(file => file.path.replace(/\\/g, '/').split('/').filter(Boolean))
  const key = (value: string): string => value.toLocaleLowerCase()
  return files.map((file, index) => {
    const base = parts[index].at(-1) ?? file.path
    const peers = parts.flatMap((path, other) => other !== index && key(path.at(-1) ?? '') === key(base) ? [other] : [])
    let label = base
    for (let depth = 2; peers.length && depth <= parts[index].length; depth++) {
      label = parts[index].slice(-depth).join('/')
      if (peers.every(other => key(parts[other].slice(-depth).join('/')) !== key(label))) break
    }
    if (peers.some(other => key(parts[other].join('/')) === key(parts[index].join('/')))) label = `${base}（第 ${index + 1} 项）`
    return { ...file, label }
  })
}

function requestedReadPaths(args: string | undefined): string[] | undefined {
  const fields = parsedReadRecord(args)
  if (!fields) return undefined
  if (Object.hasOwn(fields, 'files')) {
    if (!Array.isArray(fields.files) || !fields.files.length || fields.files.length > 16
      || Object.keys(fields).some(key => key !== 'files')) return undefined
    const paths = fields.files.map(file => record(file)?.path)
    return paths.every(validReadPath) ? paths : undefined
  }
  return validReadPath(fields.path) ? [fields.path] : undefined
}

function readItemState(item: Record<string, unknown>): ReadActivityFileSummary['state'] {
  if (item.status === 'cancelled' || typeof item.error === 'string' && /CANCELLED|CANCELED/.test(item.error)) return 'cancelled'
  if (item.status === 'waiting' || item.executed === false) return 'pending'
  return 'error'
}

/** Display one current receipt per file. Requested line limits are deliberately
 * absent from this projection: they do not prove what actually reached the reader. */
export function readActivityFiles(tool: ReadActivityFileTool): ReadActivityFileSummary[] | undefined {
  if (!['read_file', 'office_inspect'].includes(tool.name)
    || !['running', 'done', 'error', 'unknown', 'cancelled', 'waiting', 'interrupted'].includes(tool.state)) return undefined
  const requested = requestedReadPaths(tool.args)
  const requestedBatch = !!requested && Object.hasOwn(parsedReadRecord(tool.args) ?? {}, 'files')
  const fallbackState: ReadActivityFileSummary['state'] = tool.state === 'running' ? undefined
    : tool.state === 'cancelled' ? 'cancelled' : tool.metadata?.executed === false ? 'pending'
      : tool.state === 'error' || tool.state === 'interrupted' || tool.error ? 'error' : 'pending'
  const namesOnly = (paths: string[], state = fallbackState): ReadActivityFileSummary[] => readFileLabels(paths.map(path => ({ path, label: '',
    title: path + (state === 'error' ? '\n读取未完成' : state === 'cancelled' ? '\n读取已取消' : state === 'pending' ? '\n尚未收到读取结果' : ''),
    ...(state ? { state } : {}) })))
  if (tool.state === 'running') return requested ? namesOnly(requested) : undefined

  const result = parsedReadRecord(tool.result), metadata = tool.metadata
  const outputBatch = result?.batch === true && Object.hasOwn(result, 'files')
  const metadataBatch = metadata?.batch === true && Object.hasOwn(metadata, 'files')
  const batchRows = outputBatch ? result.files : metadataBatch ? metadata.files : undefined
  if (outputBatch || metadataBatch) {
    if (!Array.isArray(batchRows) || !batchRows.length || batchRows.length > 16) return undefined
    const rows = batchRows.map(record)
    if (rows.some(row => !row || !validReadPath(row.path) || typeof row.success !== 'boolean')) return undefined
    const metadataRows = Array.isArray(metadata?.files) && metadata.files.length <= 16 ? metadata.files.map(record).filter((value): value is Record<string, unknown> => !!value) : []
    const summaries = rows.map(row => {
      const item = row!, path = item.path as string
      if (!item.success) {
        const state = readItemState(item), failure = parsedReadRecord(item.output)
        const detail = typeof failure?.message === 'string' ? failure.message : typeof item.error === 'string' ? item.error : ''
        return { path, label: '', title: [path, state === 'cancelled' ? '读取已取消' : state === 'pending' ? '尚未读取' : '读取失败', detail].filter(Boolean).join('\n'), state }
      }
      const candidates = [...new Set([record(item.metadata), ...metadataRows, ...(metadataBatch && !outputBatch ? [item] : [])])]
        .filter((value): value is Record<string, unknown> => !!value)
      return completedReadFile(path, item.output, candidates, tool.name)
    })
    return readFileLabels(summaries)
  }
  // A batch without its result can still name each requested file. A single
  // receipt must never donate its range to all files in that request.
  if (requested && (requestedBatch || requested.length > 1)) return namesOnly(requested)
  const path = validReadPath(result?.path) ? result.path : validReadPath(metadata?.path) ? metadata.path : requested?.[0]
  if (!path) return undefined
  if (tool.state !== 'done' || tool.error) return namesOnly([path])
  if (!tool.result && !metadata) return namesOnly([path])
  return readFileLabels([completedReadFile(path, tool.result, metadata ? [metadata] : [], tool.name)])
}

function completedReadFile(path: string, output: unknown, candidates: Record<string, unknown>[], name: string): ReadActivityFileSummary {
  const fields = parsedReadRecord(output)
  const corresponding = !validReadPath(fields?.path) || matchingReadPath(path, fields.path)
  const version = (value: unknown): string | undefined => typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value)
    ? value.replace(/^sha256:/i, '').toLowerCase() : undefined
  const currentVersion = version(fields?.expectedHash)
  const matching = corresponding ? candidates.filter(candidate => validReadPath(candidate.path) && matchingReadPath(path, candidate.path)
    && candidate.success !== false && !candidate.error && (!currentVersion || version(candidate.expectedHash) === currentVersion)) : []
  // More than one same-path page is ambiguous; use only the current result, not
  // a guessed metadata index or a previous page's line boundaries.
  const metadata = matching.length === 1 ? matching[0] : undefined
  const actualPath = corresponding && validReadPath(fields?.path) ? fields.path : validReadPath(metadata?.path) ? metadata.path : path
  const text = typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output)
  const preview = name === 'read_file' && corresponding ? readActivityPreview({ name, state: 'done', result: text, metadata }) : null
  const range = preview?.range
  return { path: actualPath, label: '', title: actualPath + (range ? `\n${range.title}` : name === 'office_inspect' ? '\n文档预览，不提供实读行号' : '\n未提供已确认的行范围'),
    ...(range ? { range: range.label.slice('引用行数：'.length) } : {}) }
}

function readLineRange(fields: Record<string, unknown>): ReadActivityLineRange | undefined {
  if (!hasFileVersion(fields) || !positiveInteger(fields.startLine) || !positiveInteger(fields.endLine) || !positiveInteger(fields.totalLines) ||
      fields.startLine > fields.endLine || fields.endLine > fields.totalLines) return undefined
  if (fields.hasMore !== undefined && (typeof fields.hasMore !== 'boolean' ||
      (fields.hasMore && (!positiveInteger(fields.nextStartLine) || !positiveInteger(fields.nextStartColumn))) ||
      (!fields.hasMore && (fields.nextStartLine != null || fields.nextStartColumn != null)))) return undefined
  const range = fields.startLine === fields.endLine ? `${fields.startLine}` : `${fields.startLine}–${fields.endLine}`
  return {
    label: `引用行数：${range}`,
    title: `本次读取第 ${range} 行${fields.partialLine === true ? '（含不完整行）' : ''} · 文件共 ${fields.totalLines} 行`
  }
}

/** Decode only the engine's documented read envelopes; unfamiliar output stays intact. */
export function readActivityPreview(tool: {
  name: string; state: string; result: string; error?: string; metadata?: Record<string, unknown>
}): { content: string; range?: ReadActivityLineRange } | null {
  if ((tool.name === 'read_file' || tool.name === 'office_inspect')
    && ['done', 'error', 'cancelled', 'interrupted', 'waiting'].includes(tool.state)) {
    try {
      const fields = record(JSON.parse(tool.result))
      if (fields?.batch === true) return batchReadPreview(fields, tool.name, tool.metadata)
    } catch { /* A streaming or unknown envelope stays visible through the normal fallback. */ }
  }
  if (tool.name !== 'read_file' || tool.state !== 'done' || tool.error) return null
  // Paginated reads also return their actual boundaries as metadata; requested
  // arguments can extend beyond the page and must never be used for this label.
  const metadataRange = tool.metadata ? readLineRange(tool.metadata) : undefined
  try {
    const parsed: unknown = JSON.parse(tool.result)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>
      const range = readLineRange(fields)
      if (range && Object.keys(fields).every(key => readReceiptFields.has(key))) {
        if (typeof fields.numberedContent === 'string') {
          if (typeof fields.hasMore !== 'boolean') return null
          return { content: fields.numberedContent, range }
        }
        if (typeof fields.content === 'string') return { content: fields.content, range }
      }
    }
  } catch { /* Formatted reads have a textual envelope rather than JSON. */ }
  const prefix = /^\[读取监控\] [^\r\n]+\r?\n\[文件版本\] (\{[^\r\n]+\})\r?\n\[精确编辑\] [^\r\n]+\r?\n\r?\n/.exec(tool.result)
  const fallback = metadataRange ? { content: tool.result, range: metadataRange } : null
  if (!prefix) return fallback
  try {
    const version: unknown = JSON.parse(prefix[1])
    if (!version || typeof version !== 'object' || Array.isArray(version)) return fallback
    const fields = version as Record<string, unknown>
    if (!hasFileVersion(fields)) return fallback
    const range = readLineRange(fields) ?? metadataRange
    return { content: tool.result.slice(prefix[0].length), ...(range ? { range } : {}) }
  } catch { return fallback }
}

/** Pretty printing is display-only; callers always copy the untouched receipt. */
export function formatActivityValue(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) ?? value } catch { return value }
}
