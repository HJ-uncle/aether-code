/** Deterministic upstream responses only. File mutations, receipts, delivery
 * snapshots, rollback and history are executed by the unmodified real engine. */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { dirname } from 'node:path'

export interface LifecycleOperation { kind: 'write' | 'delete'; path: string; content?: string }
export interface LifecycleChange { path: string; oldContent: string | null; newContent: string | null; oldHash: string; newHash: string }
export interface LifecycleRound {
  ordinal: number; prompt: string; operations: LifecycleOperation[]; deliveries: string[]
  files: Record<string, string>; directories: string[]; changes: LifecycleChange[]; net: LifecycleChange[]
}
const write = (path: string, content: string): LifecycleOperation => ({ kind: 'write', path: 'project/' + path, content })
const remove = (path: string): LifecycleOperation => ({ kind: 'delete', path: 'project/' + path })
const game = (round: number, score = round, hint = 'off'): string => `export const stage = 'ROUND_${round}';\nexport const score = ${score};\nexport const hint = '${hint}';\n`
const index = (title: string): string => `<!doctype html>\n<title>${title}</title>\n<main id="game">Five-round lifecycle</main>\n`
export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const version = (text: string | null): string => text === null ? 'missing' : 'sha256:' + sha256(text)

export function lifecycleRounds(): LifecycleRound[] {
  const plans: Array<{ operations: LifecycleOperation[]; deliveries: string[] }> = [
    { operations: [write('index.html', index('ROUND_1')), write('src/game.js', game(1)), write('docs/guide.txt', 'GUIDE_ROUND_1\n'),
      write('recycle.txt', 'RECYCLE_ORIGINAL_ROUND_1\n')], deliveries: ['index.html', 'src/game.js', 'docs/guide.txt', 'recycle.txt'] },
    { operations: [write('index.html', index('ROUND_2')), write('src/game.js', game(2, 1)), write('src/game.js', game(2)),
      remove('recycle.txt'), write('features/score/score.js', 'export const scoreFeature = "SCORE_ROUND_2";\n')],
    deliveries: ['index.html', 'src/game.js', 'features/score/score.js'] },
    { operations: [write('src/game.js', game(3)), write('recycle.txt', 'RECYCLE_RECREATED_ROUND_3\n'), remove('docs/guide.txt'),
      write('features/hints/nested/hints.js', 'export const hintFeature = "HINT_ROUND_3";\n'), write('temporary.txt', 'TEMPORARY_SAME_TURN\n'), remove('temporary.txt')],
    deliveries: ['src/game.js', 'recycle.txt', 'features/hints/nested/hints.js'] },
    { operations: [write('index.html', index('ROUND_4_DRAFT')), write('index.html', index('ROUND_4_FINAL')), write('src/game.js', game(4, 4, 'on')),
      remove('features/score/score.js'), write('docs/guide.txt', 'GUIDE_RECREATED_ROUND_4\n'), write('release/round4.txt', 'RELEASE_ROUND_4\n')],
    deliveries: ['index.html', 'src/game.js', 'docs/guide.txt', 'release/round4.txt'] },
    { operations: [write('src/game.js', game(5, 5, 'on')), remove('docs/guide.txt'), write('recycle.txt', 'RECYCLE_MODIFIED_ROUND_5\n'),
      write('releases/round5/deep/audit.txt', 'AUDIT_ROUND_5\n'), remove('release/round4.txt')],
    deliveries: ['src/game.js', 'recycle.txt', 'releases/round5/deep/audit.txt'] }
  ]
  const files: Record<string, string> = {}, directories = new Set<string>()
  return plans.map((plan, index) => {
    const changes: LifecycleChange[] = []
    for (const operation of plan.operations) {
      const oldContent = files[operation.path] ?? null
      const newContent = operation.kind === 'write' ? operation.content! : null
      changes.push({ path: operation.path, oldContent, newContent, oldHash: version(oldContent), newHash: version(newContent) })
      if (newContent === null) delete files[operation.path]
      else {
        files[operation.path] = newContent
        let parent = dirname(operation.path).replace(/\\/g, '/')
        while (parent !== '.') { directories.add(parent); parent = dirname(parent).replace(/\\/g, '/') }
      }
    }
    const net = new Map<string, LifecycleChange>()
    for (const change of changes) {
      const first = net.get(change.path)
      net.set(change.path, { ...change, oldContent: first ? first.oldContent : change.oldContent, oldHash: first ? first.oldHash : change.oldHash })
    }
    return { ordinal: index + 1, prompt: `LIFECYCLE_ROUND_${index + 1}：执行项目第 ${index + 1} 轮约定的增删改，并交付本轮文件。`,
      operations: plan.operations, deliveries: plan.deliveries.map(path => 'project/' + path),
      files: { ...files }, directories: [...directories].sort(), changes,
      net: [...net.values()].filter(change => change.oldHash !== change.newHash) }
  })
}

type Message = { role?: string; content?: unknown; tool_call_id?: string }
type Tool = { function?: { name?: string } }
type WireBody = { model?: string; stream?: boolean; messages?: Message[]; tools?: Tool[] }
export interface DeterministicProvider {
  server: Server; requests: Array<Record<string, unknown>>; errors: string[]; origin: string
  heldFinalRounds: Set<number>; releaseFinal: (ordinal: number) => void
}
function textContent(value: unknown): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('\n') : ''
}
export async function startLifecycleProvider(rounds: LifecycleRound[], modelId: string, options: { holdFinalRounds?: number[] } = {}): Promise<DeterministicProvider> {
  const requests: Array<Record<string, unknown>> = [], errors: string[] = []
  const heldFinalRounds = new Set<number>(), released = new Set<number>(), gates = new Map<number, Array<() => void>>()
  const releaseFinal = (ordinal: number): void => {
    released.add(ordinal); heldFinalRounds.delete(ordinal)
    for (const done of gates.get(ordinal) ?? []) done()
    gates.delete(ordinal)
  }
  const server = createServer((request, response) => { void (async () => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') throw new Error(`Unexpected upstream route ${request.method} ${request.url}`)
    let raw = ''; for await (const bytes of request) { raw += bytes.toString(); if (raw.length > 8_000_000) throw new Error('Fixture request too large') }
    const body = JSON.parse(raw) as WireBody
    if (body.model !== modelId) throw new Error('Unexpected upstream model')
    const messages = body.messages ?? []
    const prompt = [...messages].reverse().find(message => message.role === 'user' && /LIFECYCLE_ROUND_[1-5]/.test(textContent(message.content)))
    const match = /LIFECYCLE_ROUND_([1-5])/.exec(textContent(prompt?.content))
    // Unrelated utility title/summary requests receive text, never mutate files.
    const round = match && body.stream ? rounds[Number(match[1]) - 1] : undefined
    let tool: { id: string; name: string; args: Record<string, unknown> } | undefined
    if (round) {
      const visible = new Set((body.tools ?? []).map(item => item.function?.name)), completed = new Set(messages.filter(item => item.role === 'tool').map(item => item.tool_call_id))
      const required = ['write_file', 'delete_file', 'deliver_files'], missing = required.filter(name => !visible.has(name))
      // A successful delivery closes tool execution for the final response.
      // The real engine intentionally supplies no tools at that boundary.
      if (completed.has(`lifecycle-${round.ordinal}-deliver`)) {
        tool = undefined
      } else if (missing.length) {
        if (!visible.has('load_tools')) throw new Error('Real registry did not expose a way to load required tools')
        tool = { id: `lifecycle-${round.ordinal}-load-${missing.join('-')}`, name: 'load_tools', args: { names: missing } }
        if (completed.has(tool.id)) throw new Error('Loaded tool schemas did not reach the following model request')
      } else {
        const index = round.operations.findIndex((_operation, i) => !completed.has(`lifecycle-${round.ordinal}-operation-${i}`))
        if (index >= 0) {
          const operation = round.operations[index]
          tool = { id: `lifecycle-${round.ordinal}-operation-${index}`, name: operation.kind === 'delete' ? 'delete_file' : 'write_file',
            args: operation.kind === 'delete' ? { path: operation.path } : { path: operation.path, data: operation.content!, expectedHash: round.changes[index].oldHash } }
        } else if (!completed.has(`lifecycle-${round.ordinal}-deliver`)) {
          tool = { id: `lifecycle-${round.ordinal}-deliver`, name: 'deliver_files', args: { items: round.deliveries.map(path => ({ path })) } }
        }
      }
    }
    const content = round ? `第 ${round.ordinal} 轮文件已交付。LIFECYCLE_DONE_${round.ordinal}` : '五轮项目生命周期验收'
    requests.push({ ordinal: round?.ordinal ?? null, stream: body.stream === true, tool: tool?.name, toolCallId: tool?.id,
      messageCount: messages.length, visibleToolCount: body.tools?.length ?? 0 })
    if (round && !tool && options.holdFinalRounds?.includes(round.ordinal) && !released.has(round.ordinal)) {
      heldFinalRounds.add(round.ordinal)
      await new Promise<void>(done => gates.set(round.ordinal, [...(gates.get(round.ordinal) ?? []), done]))
    }
    const id = 'fixture-' + requests.length
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
        : { role: 'assistant', content }
      response.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', model: modelId, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', model: modelId, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, object: 'chat.completion', model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: String(error) } })) }) })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No deterministic provider port')
  return { server, requests, errors, origin: `http://127.0.0.1:${address.port}`, heldFinalRounds, releaseFinal }
}
