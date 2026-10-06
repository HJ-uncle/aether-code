import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { RemoteTerminalService } from '../src/main/terminal/remote-terminal'
import type { EngineSnapshot } from '../src/shared/ipc'

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
    await new Promise(resolve => setTimeout(resolve, 30))
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
