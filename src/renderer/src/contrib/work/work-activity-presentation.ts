/** Decode only the engine's documented read envelopes; unfamiliar output stays intact. */
export function readActivityPreview(tool: { name: string; state: string; result: string }): { content: string } | null {
  if (tool.name !== 'read_file' || tool.state !== 'done' || !tool.result) return null
  try {
    const parsed: unknown = JSON.parse(tool.result)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>
      const allowed = new Set(['path', 'expectedHash', 'encoding', 'lineEnding', 'utf8Bom', 'startLine', 'endLine', 'totalLines', 'content'])
      if (typeof fields.path === 'string' && typeof fields.expectedHash === 'string' && /^[a-f0-9]{64}$/i.test(fields.expectedHash) && typeof fields.content === 'string' &&
          ['startLine', 'endLine', 'totalLines'].every(key => typeof fields[key] === 'number' && Number.isInteger(fields[key]) && Number(fields[key]) >= 1) &&
          Number(fields.startLine) <= Number(fields.endLine) && Number(fields.endLine) <= Number(fields.totalLines) &&
          Object.keys(fields).every(key => allowed.has(key))) return { content: fields.content }
    }
  } catch { /* Formatted reads have a textual envelope rather than JSON. */ }
  const prefix = /^\[读取监控\] [^\r\n]+\r?\n\[文件版本\] (\{[^\r\n]+\})\r?\n\[精确编辑\] [^\r\n]+\r?\n\r?\n/.exec(tool.result)
  if (!prefix) return null
  try {
    const version: unknown = JSON.parse(prefix[1])
    if (!version || typeof version !== 'object' || Array.isArray(version)) return null
    const fields = version as Record<string, unknown>
    if (typeof fields.path !== 'string' || typeof fields.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(fields.expectedHash)) return null
    return { content: tool.result.slice(prefix[0].length) }
  } catch { return null }
}

/** Pretty printing is display-only; callers always copy the untouched receipt. */
export function formatActivityValue(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) ?? value } catch { return value }
}
