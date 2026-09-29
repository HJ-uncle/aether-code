import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** A controllable OpenAI endpoint: only the remote LLM is replaced, never the engine or tools. */
export const SUBAGENT_PROBES = {
  model: 'e2e-subagent-model',
  round: '[e2e:subagents:results]',
  cancelRound: '[e2e:subagents:cancel]',
  success: '[child:success]',
  failure: '[child:failure]',
  cancel: '[child:cancel]',
  sibling: '[child:sibling]',
  fileContent: 'SUBAGENT_REAL_FILE_READ_12403',
  successOutput: 'SUBAGENT_SUCCESS_AFTER_REAL_READ',
  siblingOutput: 'SUBAGENT_SIBLING_COMPLETED',
  partialOutput: 'SUBAGENT_CANCEL_PARTIAL_OUTPUT',
  failureReason: 'E2E_SUBAGENT_400_INVALID_REQUEST',
  parentOutput: 'PARENT_HANDLED_BOTH_SUBAGENT_RESULTS',
  cancelParentOutput: 'PARENT_CONTINUED_AFTER_CHILD_CANCEL'
} as const

type JsonRecord = Record<string, unknown>
interface ProviderMessage extends JsonRecord {
  role: string
  content?: unknown
}
interface ProviderRequest extends JsonRecord {
  messages: ProviderMessage[]
  stream?: boolean
  tools?: Array<{ type: 'function'; function: { name: string; parameters?: unknown } }>
}
interface FunctionCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
type Gate = 'success' | 'cancel' | 'sibling'

function tool(id: string, name: string, args: JsonRecord): FunctionCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function messageText(message: ProviderMessage): string {
  if (typeof message.content === 'string') return message.content
  return JSON.stringify(message.content ?? '')
}

export class SubagentProvider {
  readonly requests: ProviderRequest[] = []
  readonly errors: string[] = []
  readonly disconnected = new Set<Gate>()
  private readonly held = new Map<Gate, { response: ServerResponse; request: ProviderRequest }>()
  private readonly server: Server
  baseUrl = ''

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.errors.push(error instanceof Error ? error.message : String(error))
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Fake provider handler failed' } }))
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Provider did not bind a TCP port')
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`
  }

  waiting(gate: Gate): boolean {
    return this.held.has(gate)
  }

  release(gate: Gate): void {
    const held = this.held.get(gate)
    if (!held) throw new Error(`Provider gate ${gate} has no waiting request`)
    this.held.delete(gate)
    const content =
      gate === 'success' ? SUBAGENT_PROBES.successOutput : SUBAGENT_PROBES.siblingOutput
    this.respond(held.response, held.request, content, [], true)
  }

  async close(): Promise<void> {
    for (const { response } of this.held.values()) response.destroy()
    this.held.clear()
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    )
  }

  private chunk(
    response: ServerResponse,
    delta: JsonRecord,
    finishReason: string | null = null
  ): void {
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: SUBAGENT_PROBES.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      })}\n\n`
    )
  }

  private respond(
    response: ServerResponse,
    request: ProviderRequest,
    content: string,
    calls: FunctionCall[] = [],
    alreadyStarted = false
  ): void {
    // Simulated provider usage proves the old implicit 500k ceiling cannot terminate a real child flow.
    const promptTokens = request.messages.some((message) => messageText(message).includes(SUBAGENT_PROBES.success))
      ? 300_000 : 40
    const usage = { prompt_tokens: promptTokens, completion_tokens: 12, total_tokens: promptTokens + 12 }
    const finish = calls.length ? 'tool_calls' : 'stop'
    if (request.stream) {
      if (!alreadyStarted)
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        })
      this.chunk(response, {
        role: 'assistant',
        content,
        ...(calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {})
      })
      this.chunk(response, {}, finish)
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion.chunk',
          created: 1,
          model: SUBAGENT_PROBES.model,
          choices: [],
          usage
        })}\n\n`
      )
      response.end('data: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          created: 1,
          model: SUBAGENT_PROBES.model,
          choices: [
            {
              index: 0,
              finish_reason: finish,
              message: {
                role: 'assistant',
                content,
                ...(calls.length ? { tool_calls: calls } : {})
              }
            }
          ],
          usage
        })
      )
    }
  }

  private hold(gate: Gate, response: ServerResponse, request: ProviderRequest): void {
    if (this.held.has(gate)) throw new Error(`Duplicate provider request at ${gate}`)
    this.held.set(gate, { response, request })
    if (request.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      this.chunk(response, {
        role: 'assistant',
        content: gate === 'cancel' ? SUBAGENT_PROBES.partialOutput : ''
      })
    }
    response.on('close', () => {
      if (!response.writableEnded) this.disconnected.add(gate)
      if (this.held.get(gate)?.response === response) this.held.delete(gate)
    })
  }

  private async handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    let raw = ''
    for await (const chunk of incoming) raw += chunk.toString()
    if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
      this.errors.push(`Unexpected provider endpoint: ${incoming.method} ${incoming.url}`)
      response.writeHead(404).end()
      return
    }
    const request = JSON.parse(raw) as ProviderRequest
    this.requests.push(request)
    const lastUserIndex = request.messages.findLastIndex((message) => message.role === 'user')
    const user = request.messages[lastUserIndex]
    const text = user ? messageText(user) : ''
    const results = request.messages
      .slice(lastUserIndex + 1)
      .filter((message) => message.role === 'tool')

    if (text.includes(SUBAGENT_PROBES.round) || text.includes(SUBAGENT_PROBES.cancelRound)) {
      const cancellation = text.includes(SUBAGENT_PROBES.cancelRound)
      if (results.length) {
        this.respond(
          response,
          request,
          cancellation ? SUBAGENT_PROBES.cancelParentOutput : SUBAGENT_PROBES.parentOutput
        )
      } else {
        this.respond(
          response,
          request,
          '',
          cancellation
            ? [
                tool('call_child_cancel', 'subagent', {
                  task: `${SUBAGENT_PROBES.cancel} Wait for cancellation.`,
                  description: '取消目标',
                  maxSteps: 4
                }),
                tool('call_child_sibling', 'subagent', {
                  task: `${SUBAGENT_PROBES.sibling} Complete independently.`,
                  description: '保留兄弟',
                  maxSteps: 4
                })
              ]
            : [
                tool('call_child_success', 'subagent', {
                  task: `${SUBAGENT_PROBES.success} Read probe.txt relative to the parent workspace and report.`,
                  description: '读取成功',
                  maxSteps: 4
                }),
                tool('call_child_failure', 'subagent', {
                  task: `${SUBAGENT_PROBES.failure} Report the provider failure.`,
                  description: '首请求失败',
                  maxSteps: 4
                })
              ]
        )
      }
    } else if (text.includes(SUBAGENT_PROBES.failure)) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            message: SUBAGENT_PROBES.failureReason,
            type: 'invalid_request_error',
            code: 'invalid_request'
          }
        })
      )
    } else if (text.includes(SUBAGENT_PROBES.success)) {
      if (!results.length) {
        this.respond(response, request, '', [
          tool('call_real_read', 'read_file', { path: 'probe.txt' })
        ])
      } else if (
        results.some((result) => messageText(result).includes(SUBAGENT_PROBES.fileContent))
      ) {
        this.hold('success', response, request)
      } else {
        throw new Error('The real read_file result did not contain the workspace fixture')
      }
    } else if (text.includes(SUBAGENT_PROBES.cancel)) {
      this.hold('cancel', response, request)
    } else if (text.includes(SUBAGENT_PROBES.sibling)) {
      this.hold('sibling', response, request)
    } else {
      // A title/utility call is allowed, but never invent tool results for an unknown task.
      this.respond(response, request, 'E2E 子代理生命周期')
    }
  }
}
