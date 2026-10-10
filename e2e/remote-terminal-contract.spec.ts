import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { RemoteTerminalService } from '../src/main/terminal/remote-terminal'
import type { EngineSnapshot, TerminalExitInfo } from '../src/shared/ipc'

// Pure transport contracts: real HTTP/WS fixtures, without launching Electron or a user engine.

const targetSnapshot = (baseUrl: string): EngineSnapshot => ({
  mode: 'remote', phase: 'ready', baseUrl, port: Number(new URL(baseUrl).port), pid: null,
  adopted: false, entryPath: null, runtimeSource: null, version: 'test', buildId: null,
  protocolVersion: 1, instanceId: 'fixture-instance', dataDir: null, error: null, updatedAt: Date.now()
})

test('远程终端在主进程携带令牌建立 WS，并隔离输入、输出和销毁', async () => {
  const http = createServer((request, response) => {
    if (request.url === '/api/v1/terminal/create') {
      expect(request.headers['x-aether-instance-token']).toBe('fixture-token')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 200, data: { terminalId: 'remote-pty-1' } }))
      return
    }
    if (request.url === '/api/v1/terminal/remote-pty-1') {
      expect(request.headers['x-aether-instance-token']).toBe('fixture-token')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 200, data: { success: true } }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  const wss = new WebSocketServer({ noServer: true })
  const wsMessages: string[] = []
  http.on('upgrade', (request, socket, head) => {
    expect(request.headers['x-aether-instance-token']).toBe('fixture-token')
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request))
  })
  wss.on('connection', client => {
    client.on('message', value => {
      const message = JSON.parse(value.toString()) as { type: string }
      wsMessages.push(message.type)
      if (message.type === 'input') client.send(JSON.stringify({ type: 'output', data: 'echo\r\n' }))
    })
    client.send(JSON.stringify({ type: 'output', data: 'ready\r\n' }))
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const snapshot = targetSnapshot(baseUrl)
  const controller = new AbortController()
  const service = new RemoteTerminalService(() => ({ snapshot, headers: { 'X-Aether-Instance-Token': 'fixture-token' }, signal: controller.signal }), () => 'fixture-session')
  const chunks: string[] = []
  const exits: number[] = []
  try {
    const created = await service.create({ cols: 80, rows: 24 }, { onData: (_id, chunk) => chunks.push(chunk), onExit: info => exits.push(info.exitCode) })
    expect(created.id.startsWith('remote:')).toBeTruthy()
    service.write(created.id, 'hello')
    service.resize(created.id, 100, 30)
    await expect.poll(() => chunks.join('')).toContain('echo')
    expect(wsMessages).toEqual(expect.arrayContaining(['input', 'resize']))
    await service.dispose(created.id)
    expect(exits).toEqual([])
  } finally {
    controller.abort()
    await service.disposeAll()
    wss.close()
    http.close()
  }
})

async function reconnectFixture() {
  const creates: string[] = []
  const deletes: string[] = []
  const deleteTokens: Array<string | undefined> = []
  const upgrades: Array<{ path: string; token: string | undefined }> = []
  const sockets: WebSocket[] = []
  const alive = new Set<string>()
  let acknowledge = true
  let rejectNextConnection = false
  let deleteReply: { status: number; body: unknown } | undefined
  let holdDelete = false
  let releaseDelete: (() => void) | undefined
  const wsKills: string[] = []
  const http = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.method === 'POST' && request.url === '/api/v1/terminal/create') {
      const id = `pty-${creates.length + 1}`
      creates.push(id); alive.add(id)
      response.end(JSON.stringify({ code: 200, data: { terminalId: id } }))
    } else if (request.method === 'DELETE' && request.url?.startsWith('/api/v1/terminal/')) {
      const id = request.url.split('/').at(-1)!
      deletes.push(id); deleteTokens.push(request.headers.authorization)
      const finish = (): void => {
        if (deleteReply) { response.statusCode = deleteReply.status; response.end(JSON.stringify(deleteReply.body)); return }
        alive.delete(id)
        response.end(JSON.stringify({ code: 200, data: { success: true } }))
      }
      if (holdDelete) releaseDelete = finish
      else finish()
    } else { response.statusCode = 404; response.end() }
  })
  const wss = new WebSocketServer({ noServer: true, autoPong: false })
  http.on('upgrade', (request, socket, head) => {
    upgrades.push({ path: request.url!, token: request.headers.authorization })
    wss.handleUpgrade(request, socket, head, client => {
      sockets.push(client)
      const id = request.url!.split('/').at(-1)!
      if (rejectNextConnection) {
        rejectNextConnection = false
        client.send(JSON.stringify({ type: 'error', message: 'Too many terminal connections' }))
        client.close(1013)
        return
      }
      if (!alive.has(id)) {
        client.send(JSON.stringify({ type: 'error', message: `Terminal ${id} not found` }))
        client.close()
        return
      }
      client.on('ping', data => { if (acknowledge) client.pong(data) })
      client.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: string }
        if (message.type === 'input') client.send(JSON.stringify({ type: 'output', data: `same:${id}:${message.data}` }))
        if (message.type === 'kill') { wsKills.push(id); alive.delete(id) }
      })
    })
  })
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  let controller = new AbortController()
  let snapshot = { ...targetSnapshot(baseUrl), accountId: 'account-1' }
  let headers = { Authorization: 'Bearer original' }
  const service = new RemoteTerminalService(() => ({ snapshot, headers, signal: controller.signal }), () => 'conversation-1')
  const exits: TerminalExitInfo[] = []
  const chunks: string[] = []
  const { id } = await service.create({ cols: 80, rows: 24 }, { onData: (_id, chunk) => chunks.push(chunk), onExit: info => exits.push(info) })
  return {
    service, id, exits, chunks, creates, deletes, deleteTokens, upgrades, sockets, alive, wsKills,
    holdDelete(): void { holdDelete = true },
    releaseDelete(): void { holdDelete = false; releaseDelete?.(); releaseDelete = undefined },
    setDeleteReply(value?: { status: number; body: unknown }): void { deleteReply = value },
    setSnapshot(next: Partial<EngineSnapshot>): void { snapshot = { ...snapshot, ...next } },
    refreshCredentials(): void { headers = { Authorization: 'Bearer refreshed' } },
    disconnectEngine(): void { controller.abort(); snapshot = { ...snapshot, phase: 'starting' } },
    restoreEngine(): void { controller = new AbortController(); snapshot = { ...snapshot, phase: 'ready' } },
    stopAcknowledging(): void { acknowledge = false },
    rejectNextConnection(): void { rejectNextConnection = true },
    async close(): Promise<void> {
      await service.disposeAll()
      for (const socket of sockets) socket.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => http.close(() => resolve()))
    }
  }
}

test('断线保留 PTY，重连复用原 ID、更新凭据且并发重连只建立一个连接', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.sockets[0].terminate()
    await expect.poll(() => fixture.exits.map(info => info.status)).toEqual(['disconnected'])
    expect(fixture.deletes).toEqual([])
    expect(fixture.alive.has('pty-1')).toBe(true)
    fixture.refreshCredentials()
    await Promise.all([fixture.service.reconnect(fixture.id), fixture.service.reconnect(fixture.id)])
    fixture.service.write(fixture.id, 'after-reconnect')
    await expect.poll(() => fixture.chunks).toEqual(['same:pty-1:after-reconnect'])
    expect(fixture.creates).toEqual(['pty-1'])
    expect(fixture.deletes).toEqual([])
    expect(fixture.upgrades).toEqual([
      { path: '/api/v1/terminal/ws/pty-1', token: 'Bearer original' },
      { path: '/api/v1/terminal/ws/pty-1', token: 'Bearer refreshed' }
    ])
  } finally { await fixture.close() }
})

test('并发关闭共享一次 HTTP 确认，不发送 WS kill，确认完成前保留归属', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.holdDelete()
    const requests = Array.from({ length: 10 }, () => fixture.service.dispose(fixture.id))
    for (const request of requests) expect(request).toBe(requests[0])
    await expect.poll(() => fixture.deletes.length).toBe(1)
    expect(fixture.service.owns(fixture.id)).toBe(true)
    expect(fixture.wsKills).toEqual([])
    fixture.releaseDelete()
    await Promise.all(requests)
    expect(fixture.service.owns(fixture.id)).toBe(false)
    expect(fixture.alive.has('pty-1')).toBe(false)
  } finally { fixture.releaseDelete(); await fixture.close() }
})

test('HTTP 或业务清理失败保留原目标，404和缺少确认均不可冒充成功', async () => {
  const fixture = await reconnectFixture()
  try {
    for (const response of [
      { status: 500, body: { code: 50000, message: 'PTY_CLEANUP_FAILED: native close' } },
      { status: 200, body: { code: 50000, message: 'PTY_EXIT_TIMEOUT' } },
      { status: 404, body: { code: 40400, message: 'Terminal not found' } },
      { status: 200, body: { code: 200, data: {} } }
    ]) {
      fixture.setDeleteReply(response)
      await expect(fixture.service.dispose(fixture.id)).rejects.toThrow()
      expect(fixture.service.owns(fixture.id)).toBe(true)
      expect(fixture.alive.has('pty-1')).toBe(true)
    }
    fixture.setDeleteReply()
    await fixture.service.dispose(fixture.id)
    expect(fixture.service.owns(fixture.id)).toBe(false)
    expect(fixture.wsKills).toEqual([])
  } finally { fixture.setDeleteReply(); await fixture.close() }
})

test('引擎临时掉线后可重连同一实例，尚未就绪时给出可重试错误', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.disconnectEngine()
    expect(fixture.exits.map(info => info.status)).toEqual(['disconnected'])
    await expect(fixture.service.reconnect(fixture.id)).rejects.toThrow('请先恢复远端引擎连接')
    expect(fixture.deletes).toEqual([])
    fixture.restoreEngine()
    await fixture.service.reconnect(fixture.id)
    fixture.service.write(fixture.id, 'restored-engine')
    await expect.poll(() => fixture.chunks).toEqual(['same:pty-1:restored-engine'])
    expect(fixture.creates).toHaveLength(1)
  } finally { await fixture.close() }
})

for (const [label, change] of [
  ['账号', { accountId: 'account-2' }],
  ['实例', { instanceId: 'other-instance' }],
  ['服务地址', { baseUrl: 'http://127.0.0.1:1' }]
] as const) {
  test(`重连拒绝切换${label}，不会把旧终端请求发到新身份`, async () => {
    const fixture = await reconnectFixture()
    try {
      fixture.sockets[0].terminate()
      await expect.poll(() => fixture.exits.length).toBe(1)
      fixture.setSnapshot(change)
      await expect(fixture.service.reconnect(fixture.id)).rejects.toThrow('引擎实例或账号已变化')
      expect(fixture.upgrades).toHaveLength(1)
      expect(fixture.creates).toHaveLength(1)
    } finally { await fixture.close() }
  })
}

test('进程退出与网络断线不同，退出后不能伪装成重连成功', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.sockets[0].send(JSON.stringify({ type: 'exit', code: 7 }))
    await expect.poll(() => fixture.exits.map(info => [info.status, info.exitCode])).toEqual([['exited', 7]])
    await expect(fixture.service.reconnect(fixture.id)).rejects.toThrow('终端进程已退出')
    expect(fixture.upgrades).toHaveLength(1)
    expect(fixture.creates).toHaveLength(1)
  } finally { await fixture.close() }
})

test('断线期间进程已消失时重连如实失败，不偷偷创建替代进程', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.sockets[0].terminate()
    await expect.poll(() => fixture.exits.length).toBe(1)
    fixture.alive.delete('pty-1')
    await expect(fixture.service.reconnect(fixture.id)).rejects.toThrow('not found')
    expect(fixture.exits.map(info => info.status)).toEqual(['disconnected', 'exited'])
    expect(fixture.creates).toEqual(['pty-1'])
    expect(fixture.deletes).toEqual([])
  } finally { await fixture.close() }
})

test('关闭正在重连的终端会取消等待，并显式清理远端 PTY', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.sockets[0].terminate()
    await expect.poll(() => fixture.exits.length).toBe(1)
    fixture.stopAcknowledging()
    const reconnect = fixture.service.reconnect(fixture.id)
    const rejected = expect(reconnect).rejects.toThrow('终端已关闭')
    await expect.poll(() => fixture.upgrades.length).toBe(2)
    await fixture.service.dispose(fixture.id)
    await rejected
    expect(fixture.deletes).toEqual(['pty-1'])
    expect(fixture.alive.has('pty-1')).toBe(false)
    expect(fixture.service.owns(fixture.id)).toBe(false)
  } finally { await fixture.close() }
})

test('重连被服务暂时拒绝后可再次重试，不删除仍运行的进程', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.sockets[0].terminate()
    await expect.poll(() => fixture.exits.length).toBe(1)
    fixture.rejectNextConnection()
    await expect(fixture.service.reconnect(fixture.id)).rejects.toThrow('Too many terminal connections')
    expect(fixture.exits.map(info => info.status)).toEqual(['disconnected', 'disconnected'])
    expect(fixture.deletes).toEqual([])
    await fixture.service.reconnect(fixture.id)
    fixture.service.write(fixture.id, 'second-attempt')
    await expect.poll(() => fixture.chunks).toEqual(['same:pty-1:second-attempt'])
    expect(fixture.creates).toEqual(['pty-1'])
  } finally { await fixture.close() }
})


test('账号切换清理保留旧凭据，失败不会抛出且留有可见诊断与重试归属', async () => {
  const fixture = await reconnectFixture()
  try {
    fixture.setDeleteReply({ status: 500, body: { code: 50000, message: 'injected cleanup failure' } })
    const failures = await fixture.service.disposeForIdentityChange()
    expect(failures).toEqual(['injected cleanup failure'])
    expect(fixture.service.owns(fixture.id)).toBe(true)
    expect(fixture.exits.at(-1)?.cleanupError).toMatchObject({ code: 'PTY_CLEANUP_FAILED', message: 'injected cleanup failure' })
    fixture.refreshCredentials(); fixture.setSnapshot({ accountId: 'account-2' })
    fixture.setDeleteReply()
    expect(await fixture.service.disposeForIdentityChange()).toEqual([])
    expect(fixture.deleteTokens).toEqual(['Bearer original', 'Bearer original'])
    expect(fixture.service.owns(fixture.id)).toBe(false)
  } finally { fixture.setDeleteReply(); await fixture.close() }
})
