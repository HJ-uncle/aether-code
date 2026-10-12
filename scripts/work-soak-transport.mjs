/** Bounded, importable HTTP/SSE evidence collection for the real-engine soak. */
import crypto from 'node:crypto'
export function scrub(value, secrets = [], key = '') {
  if (/(api[-_]?key|token|secret|password|authorization|credential)/i.test(key)) return '[REDACTED]'
  if (value == null) return value
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets, k)]))
  if (typeof value !== 'string') return value
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
    .replace(/(api[-_]?key|token|secret|password|authorization)\s*[:=]\s*[^,\s}]+/gi, '$1=[REDACTED]')
}

export function endpointSummary(value) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return '' }
}

export function isLocalEndpoint(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
  } catch { return true }
}

export function createCollector({ maxTools = 512 } = {}) {
  const tools = new Map()
  const children = new Map()
  let run = null
  let events = 0
  const errors = []
  const apply = value => {
    events += 1
    if (value.run) run = value.run
    if (value.error || (typeof value.code === 'number' && value.code >= 400)) {
      if (errors.length < 8) errors.push(String(value.error?.message || value.message || value.code).slice(0, 300))
    }
    for (const [kind, tool] of Object.entries(value)) {
      if (!['toolStart', 'toolCall', 'toolEnd', 'toolResult'].includes(kind) || !tool?.toolCallId) continue
      if (!tools.has(tool.toolCallId) && tools.size >= maxTools) throw new Error(`Tool evidence exceeded ${maxTools} entries`)
      const prior = tools.get(tool.toolCallId) || { id: tool.toolCallId }
      let args = tool.args
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
      tools.set(tool.toolCallId, {
        ...prior, name: tool.toolName || tool.name || prior.name,
        ...(typeof tool.success === 'boolean' ? { success: tool.success } : {}),
        ...(typeof args?.path === 'string' ? { path: args.path.slice(0, 1024) } : {}),
        ...((tool.toolName || tool.name || prior.name) === 'subagent' && args ? {
          subagentModel: typeof args.model === 'string' ? args.model.slice(0, 100) : null,
          resumeRunId: typeof args.resumeRunId === 'string' ? args.resumeRunId.slice(0, 100) : null } : {}),
        ...(typeof args?.command === 'string' ? { command: args.command.slice(0, 1024), args: Array.isArray(args.args) ? args.args.map(item => String(item).slice(0, 1024)).slice(0, 20) : [], background: args.background === true } : {})
      })
    }
    const child = value.subagentEvent?.snapshot
    if (child?.runId) {
      if (!children.has(child.runId) && children.size >= maxTools) throw new Error('Subagent evidence limit exceeded')
      const summary = String(child.resultSummary || '')
      children.set(child.runId, { runId: child.runId, status: child.status, modelId: child.modelId,
        childSessionId: child.childSessionId, resumeFromRunId: child.resumeFromRunId || null,
        resultHash: crypto.createHash('sha256').update(summary).digest('hex'),
        resultNonces: [...new Set(summary.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi) || [])].slice(0, 16),
        readPaths: (child.toolCalls || []).filter(tool => tool.name === 'read_file' && tool.status === 'succeeded' && typeof tool.args?.path === 'string').map(tool => tool.args.path.slice(0, 1024)).slice(0, 32) })
    }
  }
  const result = () => ({
    events, sessionId: run?.sessionId || null, runId: run?.runId || null, turnId: run?.turnId || null, terminal: run?.status || null,
    requestedModel: run?.modelId || null, actualModel: run?.actualModelId || null,
    tools: [...tools.values()], children: [...children.values()], errors: [...errors],
    pending: (run?.pending || []).slice(0, 8).map(item => ({ requestId: item.requestId, toolCallId: item.toolCallId, kind: item.kind, toolName: item.toolName, status: item.status, output: item.output, question: item.question?.slice(0, 300) }))
  })
  return { apply, result }
}

export async function consumeSse(body, { maxFrameBytes = 1024 * 1024, maxBytes = 64 * 1024 * 1024, expectedModel = '' } = {}) {
  if (!body) throw new Error('Chat response has no SSE body')
  const reader = body.getReader()
  const collector = createCollector()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let bytes = 0
  let ended = false
  let framingComplete = false
  const inspect = frame => {
    const raw = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!raw || raw === '[DONE]') return
    let value
    try { value = JSON.parse(raw) } catch { throw new Error('Malformed JSON in SSE data frame') }
    collector.apply(value)
    const actual = value.run?.actualModelId
    if (expectedModel && actual && actual !== expectedModel) throw new Error(`Actual model mismatch before terminal: requested ${expectedModel}, observed ${actual}`)
  }
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) { ended = true; break }
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error(`SSE response exceeded ${maxBytes} bytes`)
      pending += decoder.decode(chunk.value, { stream: true })
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending)
        if (!match) break
        if (Buffer.byteLength(pending.slice(0, match.index)) > maxFrameBytes) throw new Error('SSE frame limit exceeded')
        inspect(pending.slice(0, match.index))
        pending = pending.slice(match.index + match[0].length)
      }
      if (Buffer.byteLength(pending) > maxFrameBytes) throw new Error('SSE frame limit exceeded')
    }
    pending += decoder.decode()
    if (pending.trim()) inspect(pending)
    framingComplete = true
    const evidence = { bytes, framingComplete, ...collector.result() }
    if (evidence.errors.length) throw new Error(`Chat errors: ${evidence.errors.join('; ')}`)
    if (evidence.terminal !== 'succeeded') {
      const failure = new Error(`Chat ended without succeeded terminal run (${evidence.terminal || 'missing'})`)
      failure.waitingTerminal = evidence.terminal === 'waiting'
      throw failure
    }
    if (!evidence.runId || !evidence.turnId) throw new Error('Terminal run lacks runId/turnId')
    return evidence
  } catch (error) {
    // AbortSignal.any can reject sibling readers with the very same reason
    // object. Attaching evidence to that object cross-contaminates sessions.
    const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error })
    failure.name = error?.name || 'Error'
    failure.waitingTerminal = error?.waitingTerminal === true
    failure.evidence = { bytes, framingComplete, ...collector.result() }
    throw failure
  } finally {
    if (!ended) { try { await reader.cancel() } catch {} }
    reader.releaseLock()
  }
}

async function boundedText(body, maxBytes) {
  if (!body) return ''
  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) { await reader.cancel(); throw new Error(`JSON response exceeded ${maxBytes} bytes`) }
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

export function createClient({ baseUrl, token = '', authToken = '', timeoutMs = 600_000, fetchImpl = fetch }) {
  const headers = (body, accept) => ({ Accept: accept || 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    'X-Aether-Tool-Profile': 'code', ...(token ? { 'x-aether-instance-token': token } : {}), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) })
  const signalFor = (signal, timeout) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  const request = async (route, options = {}) => {
    const response = await fetchImpl(`${baseUrl}${route}`, {
      method: options.method || 'GET', headers: headers(options.body),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: signalFor(options.signal, options.timeoutMs || timeoutMs), redirect: 'error'
    })
    const text = await boundedText(response.body, options.maxBytes || 8 * 1024 * 1024)
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${route} HTTP ${response.status}`)
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error(`Invalid JSON from ${route}`) }
    if (typeof payload?.code === 'number' && ![0, 200].includes(payload.code)) {
      const error = new Error(`${route} code ${payload.code}: ${scrub(payload.message || 'request failed', [token, authToken])}`)
      error.code = payload.code
      throw error
    }
    return payload?.data ?? payload
  }
  const chat = async (sessionId, message, options = {}) => {
    const { signal, timeoutMs: timeout = timeoutMs, expectedModel, ...chatOptions } = options
    const response = await fetchImpl(`${baseUrl}/api/v1/chat`, {
      method: 'POST', headers: headers(true, 'text/event-stream'),
      body: JSON.stringify({ sessionId, message, ...chatOptions }),
      signal: signalFor(signal, timeout), redirect: 'error'
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`POST /api/v1/chat HTTP ${response.status}`) }
    return consumeSse(response.body, { expectedModel: expectedModel || chatOptions.model })
  }
  return { request, chat }
}

export async function settledBatch(items, worker, abort) {
  // Drain every sibling before cleanup; a rejected Promise.all used to delete
  // Agents while another conversation was still writing to its workspace.
  const results = await Promise.allSettled(items.map(async item => {
    try { return await worker(item) } catch (error) { abort?.(error); throw error }
  }))
  const failed = results.find(item => item.status === 'rejected')
  if (failed) throw failed.reason
  return results.map(item => item.value)
}
