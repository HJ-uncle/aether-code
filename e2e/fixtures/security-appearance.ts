import { createServer, request as httpRequest, type Server } from 'node:http'
import type { PolicyRule, SecurityMode } from '../../src/renderer/src/core/engine/security'
import { ResourceSettingsFixture, resourceTasks, resourceToken, type ResourceReceipt } from './resource-settings'

export const initialSecurityPolicies: PolicyRule[] = [
  { id: 102, name: '删除构建产物', command: 'rm', argPattern: '^(-rf|--recursive)\\s+(dist|build|out|temporary-generated-artifacts-with-a-long-name)(/[^\\s]+)*$',
    action: 'ask', priority: 30, enabled: true, description: '删除生成文件前询问，避免误删项目内容。' },
  { id: 101, name: '只读检查', command: 'git', argPattern: '^(status|diff|log)(\\s|$)',
    action: 'allow', priority: 10, enabled: true, description: '读取版本状态与差异，不修改工作区。' },
  { id: 103, name: '限制外部脚本', command: 'curl', argPattern: 'https://downloads.example.test/tools/install-production-environment.sh',
    action: 'deny', priority: 20, enabled: false, description: '当前停用的网络脚本规则。' }
]
export const defaultSecurityPolicies: PolicyRule[] = [
  { id: 201, name: '默认命令保护', command: '*', action: 'ask', priority: 100, enabled: true, description: '恢复后的默认询问规则。' }
]
export const securityFailure = '安全设置夹具拒绝此更改'
const envelope = (data: unknown): string => JSON.stringify({ code: 200, message: 'ok', data })
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
type Failure = 'mode' | 'policy' | 'delete' | 'reset'

/** Reuse the authenticated Work bootstrap while checking every security write
 * at its real HTTP boundary. Graphics and appearance keep their real main IPC. */
export class SecurityAppearanceFixture {
  readonly receipts: ResourceReceipt[] = []
  policies = structuredClone(initialSecurityPolicies)
  modes: Record<string, SecurityMode> = { [resourceTasks[0].id]: 'safe', [resourceTasks[1].id]: 'standard' }
  failNext: Failure | null = null
  origin = ''
  private readonly bootstrap = new ResourceSettingsFixture()
  private readonly failures: string[] = []
  private readonly server: Server

  get errors(): string[] { return [...this.failures, ...this.bootstrap.errors] }

  constructor() {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/api/v1/security/')) {
        const upstream = httpRequest(new URL(request.url ?? '/', this.bootstrap.origin), { method: request.method, headers: request.headers }, incoming => {
          response.writeHead(incoming.statusCode ?? 500, incoming.headers)
          incoming.pipe(response)
        })
        upstream.on('error', error => { this.failures.push(String(error)); if (!response.headersSent) response.writeHead(502); response.end('Bootstrap proxy failed') })
        request.pipe(upstream)
        return
      }
      void (async () => {
        response.setHeader('content-type', 'application/json')
        const method = request.method ?? 'GET', path = url.pathname, query = Object.fromEntries(url.searchParams)
        if (request.headers['x-aether-instance-token'] !== resourceToken) throw new Error(`Unauthenticated ${method} ${path}`)
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks), body: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}
        if (!isRecord(body)) throw new Error('Security request must contain a JSON object')
        this.receipts.push({ method, path, query, body })
        const reject = (kind: Failure): boolean => {
          if (this.failNext !== kind) return false
          this.failNext = null
          response.end(JSON.stringify({ code: 40001, message: securityFailure, data: null }))
          return true
        }
        if (path === '/api/v1/security/mode') {
          if (method === 'GET') { response.end(envelope({ sessionId: query.sessionId, mode: this.modes[query.sessionId] ?? 'safe' })); return }
          if (method === 'PUT') {
            if (Object.keys(body).sort().join(',') !== 'mode,sessionId' || typeof body.sessionId !== 'string'
              || !resourceTasks.some(task => task.id === body.sessionId) || !['safe', 'standard', 'full-access'].includes(String(body.mode)))
              throw new Error('Security mode write lost the active Work session or changed its contract')
            if (reject('mode')) return
            this.modes[body.sessionId] = body.mode as SecurityMode
            response.end(envelope({ sessionId: body.sessionId, mode: body.mode })); return
          }
        }
        if (path === '/api/v1/security/policies' && method === 'GET') {
          if (query.current !== '1' || query.pageSize !== '200' || Object.keys(query).length !== 2) throw new Error('Policy search must stay local to the fetched rules')
          response.end(envelope(this.policies)); return
        }
        if (path === '/api/v1/security/policies/reset' && method === 'POST') {
          if (Object.keys(body).length) throw new Error('Unexpected reset payload')
          if (reject('reset')) return
          this.policies = structuredClone(defaultSecurityPolicies)
          response.end(envelope({ reset: true })); return
        }
        const match = /^\/api\/v1\/security\/policies\/(\d+)$/.exec(path)
        if (match) {
          const index = this.policies.findIndex(rule => rule.id === Number(match[1]))
          if (index < 0) throw new Error('Unknown policy mutation')
          if (method === 'PUT') {
            const keys = Object.keys(body)
            if (keys.length !== 1 || !(keys[0] === 'action' && ['allow', 'ask', 'deny'].includes(String(body.action))
              || keys[0] === 'enabled' && typeof body.enabled === 'boolean')) throw new Error('Policy write must patch only the chosen action or switch')
            if (reject('policy')) return
            this.policies[index] = { ...this.policies[index], ...body }
            response.end(envelope(this.policies[index])); return
          }
          if (method === 'DELETE') {
            if (Object.keys(body).length) throw new Error('Unexpected delete payload')
            if (reject('delete')) return
            this.policies.splice(index, 1)
            response.end(envelope({ deleted: true })); return
          }
        }
        throw new Error(`Unexpected security operation: ${method} ${path}`)
      })().catch(error => { this.failures.push(String(error)); if (!response.headersSent) response.writeHead(500); if (!response.writableEnded) response.end('Security fixture failed') })
    })
  }

  reset(): void {
    this.bootstrap.reset()
    this.receipts.length = 0
    this.policies = structuredClone(initialSecurityPolicies)
    this.modes = { [resourceTasks[0].id]: 'safe', [resourceTasks[1].id]: 'standard' }
    this.failNext = null
  }
  async start(): Promise<void> {
    await this.bootstrap.start()
    await new Promise<void>((done, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', done) })
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Missing security fixture port')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> {
    this.server.closeAllConnections()
    if (this.server.listening) await new Promise<void>(done => this.server.close(() => done()))
    await this.bootstrap.close()
  }
}
