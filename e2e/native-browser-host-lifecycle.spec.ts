/** Native manager lifecycle contract with a deterministic HTTP transport.
 * Exercises real asynchronous demand/command/status/cleanup paths; no Electron or provider. */
import { expect, test } from '@playwright/test'
import { NativeBrowserHostManager } from '../src/main/browser/native-host-manager'

function fixture(initialStatus: string, initialRunId: string | null = 'root') {
  const execution = { rootSessionId: 'session', rootRunId: 'root', ownerRunId: 'root' }
  const controller = new AbortController()
  let rootStatus = initialStatus, runId = initialRunId, demands = 0, commands = 0
  let executions = 0, results = 0, rootReleases = 0, statusReads = 0
  const waiting = (signal: AbortSignal | null | undefined): Promise<Response> => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Fixture request aborted', 'AbortError'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
  const reply = (data: unknown) => new Response(JSON.stringify({ code: 200, data }), { status: 200 })
  const http: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const path = url.pathname.replace('/api/v1', ''), method = init?.method ?? 'GET'
    if (method === 'POST' && path === '/browser/hosts') return reply({ hostId: 'host', hostToken: 'fixture-host',
      protocolVersion: 1, authority: { kind: 'account' }, capabilities: { nativeHostDemand: 1 }, leaseMs: 65000 })
    if (path === '/browser/hosts/host/demands') return demands++ === 0
      ? reply({ demands: [{ demandId: 'demand', demandToken: 'fixture-demand', execution, expiresAt: Date.now() + 30000 }] })
      : waiting(init?.signal)
    if (path === '/browser/hosts/host/demands/demand/state') return reply({ active: true, execution })
    if (path === '/browser/hosts/host/demands/demand/client') return reply({ clientId: 'client', clientToken: 'fixture-client',
      sessionId: 'session', protocolVersion: 2, capabilities: { requestWatch: true, executionIdentity: 1, resultMetadata: 1 } })
    if (path === '/chat/status') { statusReads++; return reply({ running: false, finished: true,
      ...(runId === null ? {} : { run: { runId, status: rootStatus } }) }) }
    if (path === '/browser/clients/client/commands') return commands++ === 0
      ? reply({ commands: [{ requestId: 'command', sessionId: 'session', action: 'snapshot', args: { tabId: 'tab' }, execution, expiresAt: null }] })
      : waiting(init?.signal)
    if (path === '/browser/clients/client/requests/command/state') return url.searchParams.get('wait') === 'true'
      ? waiting(init?.signal) : reply({ active: true, execution })
    if (path === '/browser/clients/client/results') { results++; return reply({ accepted: true }) }
    if (method === 'DELETE' && path === '/browser/hosts/host/roots/session/runs/root') { rootReleases++; return reply({}) }
    if (method === 'DELETE' && path === '/browser/hosts/host') return reply({})
    throw new Error(`Unexpected lifecycle request: ${method} ${path}`)
  }
  const manager = new NativeBrowserHostManager({
    getSettings: () => ({ aiEnabled: true }),
    execute: async () => { executions++; return { success: true, output: '{}', metadata: { code: 'BROWSER_OPERATION_SUCCEEDED', operationPerformed: true } } },
  }, async () => [{ engineId: 'fixture-instance', baseUrl: 'http://fixture.invalid', authorityKind: 'account',
    signal: controller.signal, headers: async () => ({}) }], http)
  return { manager, counters: () => ({ executions, results, rootReleases, statusReads }),
    terminal: (status = 'succeeded') => { rootStatus = status },
    close: async () => { controller.abort(); const failure = await manager.disconnectAndWait(); expect(failure).toBeNull() } }
}

for (const state of ['running', 'waiting']) {
  test(`${state} root retains browser when observation stream has finished, then releases on durable completion`, async () => {
    const f = fixture(state)
    try {
      await f.manager.refresh()
      await expect.poll(() => f.counters().results).toBe(1)
      expect(f.counters()).toMatchObject({ executions: 1, rootReleases: 0 })
      expect(f.manager.getSnapshot().roots).toBe(1)
      f.terminal()
      await expect.poll(() => f.counters().rootReleases).toBe(1)
      expect(f.manager.getSnapshot().roots).toBe(0)
    } finally { await f.close() }
  })
}

for (const state of ['succeeded', 'failed', 'cancelled', 'interrupted']) {
  test(`${state} root releases browser without dispatching a new page command`, async () => {
    const f = fixture(state)
    try {
      await f.manager.refresh()
      await expect.poll(() => f.counters().rootReleases).toBe(1)
      expect(f.counters()).toMatchObject({ executions: 0, results: 0 })
    } finally { await f.close() }
  })
}

for (const identity of [null, 'replacement']) {
  test(`${identity ?? 'missing'} root identity releases browser without lending it to a new run`, async () => {
    const f = fixture('running', identity)
    try {
      await f.manager.refresh()
      await expect.poll(() => f.counters().rootReleases).toBe(1)
      expect(f.counters()).toMatchObject({ executions: 0, results: 0 })
    } finally { await f.close() }
  })
}
