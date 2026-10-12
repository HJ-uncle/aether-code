/** Deny-only recovery through the same durable pending API as the Work UI. */

export function mergeTurnEvidence(previous, incoming) {
  if (!previous) return incoming
  for (const key of ['sessionId', 'runId', 'turnId', 'actualModel']) {
    if (!previous[key] || incoming[key] !== previous[key]) throw new Error(`Permission resume changed ${key}`)
  }
  const merge = (key, id) => {
    const entries = new Map(previous[key].map(item => [item[id], item]))
    for (const item of incoming[key]) entries.set(item[id], { ...entries.get(item[id]), ...item })
    return [...entries.values()]
  }
  const tools = merge('tools', 'id')
  const children = merge('children', 'runId')
  const bytes = (previous.bytes || 0) + (incoming.bytes || 0)
  if (tools.length > 512 || children.length > 512 || bytes > 64 * 1024 * 1024) throw new Error('Recovered turn exceeded bounded evidence limits')
  return { ...incoming, bytes, events: previous.events + incoming.events, tools, children, errors: [...previous.errors, ...incoming.errors].slice(0, 8) }
}

function assertIdentity(run, stream, sessionId, model) {
  if (!run || run.sessionId !== sessionId || stream.sessionId !== sessionId || run.runId !== stream.runId || run.turnId !== stream.turnId
    || !run.runId || !run.turnId || run.actualModelId !== model || stream.actualModel !== model) throw new Error('Permission state no longer belongs to this session/run/turn/model')
}

export async function chatWithDeniedPermissions(client, sessionId, message, options, { emit = () => {}, maxDenials = 2, timeoutMs = 600_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  const remaining = () => {
    options.signal?.throwIfAborted()
    const value = deadline - Date.now()
    if (value <= 0) throw Object.assign(new Error('Engineering turn timeout including permission recovery'), { requestTimedOut: true })
    return value
  }
  const records = []
  const answered = new Set()
  let merged = null
  let nextMessage = message
  let nextOptions = options
  let awaitingAcknowledgement = null
  let submitted = 0
  try {
    for (;;) {
      let failure = null
      let incoming
      try { incoming = await client.chat(sessionId, nextMessage, { ...nextOptions, signal: options.signal, timeoutMs: remaining(), expectedModel: options.model }) }
      catch (error) {
        failure = error
        incoming = error.evidence
        if (!incoming) throw error
      }
      merged = mergeTurnEvidence(merged, incoming)
      let state = null
      const readState = async () => {
        state ||= await client.request(`/api/v1/chat/status?sessionId=${encodeURIComponent(sessionId)}`, { signal: options.signal, timeoutMs: Math.min(30_000, remaining()) })
        assertIdentity(state.run, merged, sessionId, options.model)
        return state.run
      }
      if (awaitingAcknowledgement) {
        const run = await readState()
        const accepted = run.pending?.find(item => item.requestId === awaitingAcknowledgement.requestId)
        const deniedTool = merged.tools.find(tool => tool.id === awaitingAcknowledgement.toolCallId)
        if (accepted?.status !== 'answered' || accepted.output !== 'rejected' || accepted.toolCallId !== awaitingAcknowledgement.toolCallId
          || accepted.toolName !== 'execute_cmd' || accepted.kind !== 'permission' || deniedTool?.success !== false) throw new Error('Permission denial was not durably acknowledged with an unsuccessful tool result')
        records.push(awaitingAcknowledgement)
        emit({ type: 'permission-denied', sessionId, runId: merged.runId, turnId: merged.turnId, ...awaitingAcknowledgement, output: 'rejected' })
        awaitingAcknowledgement = null
      }
      if (!failure) {
        if (submitted) emit({ type: 'permission-recovered', sessionId, runId: merged.runId, turnId: merged.turnId, actualModel: merged.actualModel, denialCount: records.length })
        return { ...merged, permissionRecovery: { submitted, denied: records.length, records } }
      }
      if (merged.terminal !== 'waiting' || !failure.waitingTerminal || merged.errors.length) {
        if (merged.framingComplete && merged.runId && merged.turnId && merged.sessionId === sessionId && merged.requestedModel === options.model
          && merged.actualModel === options.model && ['failed', 'cancelled', 'interrupted'].includes(merged.terminal)) {
          const run = await readState()
          if (run.status !== merged.terminal) throw new Error('Failed stream terminal no longer matches its durable run')
          failure.taskFailure = true
        }
        throw failure
      }
      emit({ type: 'permission-waiting', sessionId, stream: merged, denialCount: records.length })
      const run = await readState()
      if (run.status !== 'waiting') throw new Error('Permission run is no longer waiting')
      const active = (run.pending || []).filter(item => item.status === 'pending')
      if (active.length !== 1) throw new Error('Only a single execute_cmd permission request can be denied automatically')
      const pending = active[0]
      if (!pending.requestId || !pending.toolCallId || answered.has(pending.requestId)) throw new Error('Missing or repeated permission request identity')
      const observed = merged.pending?.find(item => item.requestId === pending.requestId && item.toolCallId === pending.toolCallId && item.kind === pending.kind && item.toolName === pending.toolName && item.status === 'pending')
      if (!observed) throw new Error('Durable permission does not match the waiting stream')
      if (pending.kind === 'ask') throw Object.assign(new Error(`Task requested user input; no answer was invented: ${String(pending.question || '').slice(0, 300)}`), { taskFailure: true })
      if (pending.kind !== 'permission' || pending.toolName !== 'execute_cmd') throw new Error('Only a single execute_cmd permission request can be denied automatically')
      if (submitted >= maxDenials) throw Object.assign(new Error(`Permission recovery exceeded ${maxDenials} denials for this turn`), { taskFailure: true })
      answered.add(pending.requestId); submitted += 1
      awaitingAcknowledgement = { requestId: pending.requestId, toolCallId: pending.toolCallId, attempt: submitted,
        command: typeof pending.args?.command === 'string' ? pending.args.command.slice(0, 1024) : null,
        args: Array.isArray(pending.args?.args) ? pending.args.args.map(value => String(value).slice(0, 1024)).slice(0, 20) : [] }
      emit({ type: 'permission-denial-submitted', sessionId, runId: run.runId, turnId: run.turnId, ...awaitingAcknowledgement, output: 'rejected' })
      nextMessage = ''
      // The engine restores the original model, workspace and thinking config.
      // Only the durable identity and literal rejection are sent on resumption.
      nextOptions = { runId: run.runId, toolResponse: { runId: run.runId, requestId: pending.requestId,
        toolCallId: pending.toolCallId, name: 'execute_cmd', output: 'rejected' } }
    }
  } catch (error) {
    const failure = new Error(error.message, { cause: error })
    failure.evidence = merged ? { ...merged, permissionRecovery: { submitted, denied: records.length, records } } : error.evidence
    let timeoutCause = error
    while (timeoutCause && !timeoutCause.requestTimedOut && !['AbortError', 'TimeoutError'].includes(timeoutCause.name)) timeoutCause = timeoutCause.cause
    const timedOut = Date.now() >= deadline && !options.signal?.aborted && Boolean(timeoutCause)
    failure.taskFailure = error.taskFailure === true
    if (timedOut && merged?.runId && merged?.turnId && merged?.sessionId === sessionId && merged?.actualModel === options.model) {
      // A transport timeout can stop before the terminal frame. Only a durable
      // match permits exact-run cancellation; a replacement run stays untouched.
      try {
        const state = await client.request(`/api/v1/chat/status?sessionId=${encodeURIComponent(sessionId)}`, { signal: options.signal, timeoutMs: 10_000 })
        assertIdentity(state.run, merged, sessionId, options.model)
        failure.taskFailure = true
      } catch (identityError) { throw Object.assign(new Error(`Timed-out task identity could not be verified: ${identityError.message}`, { cause: failure }), { evidence: failure.evidence }) }
    }
    throw failure
  }
}
