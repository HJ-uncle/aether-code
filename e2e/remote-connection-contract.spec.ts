import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { clearRemoteAttachments, rememberRemoteAttachment, remoteAttachmentsForRequest } from '../src/main/engine/remote-attachments'
import { prepareRemoteChatBody, selectRemoteWorkspacePaths, validateRemoteWorkspaceRoot } from '../src/main/engine/remote-workspace'
import { remoteInstanceToken, remoteRequestError, validateRemoteInstanceToken } from '../src/main/engine/protocol'

test('手动本机开发地址可无token，非本机仍需明确凭据', () => {
  for (const url of ['http://localhost:12323', 'http://127.0.0.1:12323', 'http://[::1]:12323']) {
    expect(remoteInstanceToken(url)).toBe('')
    expect(remoteInstanceToken(url, ' fixture-token ')).toBe('fixture-token')
  }
  for (const url of ['http://192.168.1.10:12323', 'https://engine.example', 'http://localhost.example']) {
    expect(() => remoteInstanceToken(url)).toThrow('AETHER_IDE_REMOTE_INSTANCE_TOKEN')
    expect(remoteInstanceToken(url, 'fixture-token')).toBe('fixture-token')
  }
  expect(() => remoteInstanceToken('http://secret@localhost:12323')).toThrow('不含凭证')
  expect(() => remoteInstanceToken('file:///engine')).toThrow('HTTP(S)')
})

test('远端令牌在保存和环境变量入口使用同一请求头边界', () => {
  expect(validateRemoteInstanceToken(' padded-token ')).toBe('padded-token')
  for (const token of ['a\nb', 'a\rb', 'a\u0000b', 'x'.repeat(4097), '非请求头令牌']) {
    expect(() => validateRemoteInstanceToken(token)).toThrow('远端令牌')
    expect(() => remoteInstanceToken('http://localhost:12323', token)).toThrow('远端令牌')
  }
})

test('远端只开放明确的读取与会话执行接口，未授权修改仍拒绝', () => {
  const reads = [
    '/health', '/meta', '/metrics', '/models', '/tools', '/system-tools', '/external-skills',
    '/conversation/sessions', '/conversation/history?sessionId=fixture', '/conversation/archive?sessionId=fixture',
    '/api/v1/chat/snapshot', '/chat/status', '/chat/runs', '/chat/stream',
    '/changes', '/todos', '/subagent/runs', '/subagent/runs/run-1', '/subagent/runs/run-1/events',
    '/command-jobs', '/command-jobs/job-1', '/command-jobs/job-1/output',
    '/security/mode', '/security/policies', '/models/capability-defs', '/sessions/test/binding'
  ]
  const actions = [
    '/chat', '/chat/cancel', '/utility/chat', '/conversation/compress',
    '/subagent/cancel', '/subagent/runs/run-1/cancel', '/command-jobs/job-1/cancel'
  ]
  for (const path of reads) {
    expect(remoteRequestError('remote', 'GET', path), path).toBeNull()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      if (path === '/models' && method === 'POST') continue
      expect(remoteRequestError('remote', method, path), method + ' ' + path).toBeTruthy()
    }
  }
  for (const path of actions) {
    expect(remoteRequestError('remote', 'POST', path), path).toBeNull()
    expect(remoteRequestError('remote', 'POST', '/api/v1' + path + '?fixture=1'), path).toBeNull()
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(remoteRequestError('remote', method, path), method + ' ' + path).toBeTruthy()
    }
  }
  for (const path of [
    '/workspace/file/content', '/workspace/file', '/lsp/diagnostics', '/changes/revert-batch',
    '/changes/keep-all', '/changes/change-1/keep', '/conversation/truncate', '/conversation/turns/turn-1',
    '/sessions/session-1', '/models/../workspace/file/content', '/conversation/history/extra',
    '/subagent/runs/../cancel', '/command-jobs/%2e%2e/workspace', '/changes/anything', '/unknown'
  ]) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(remoteRequestError('remote', method, path), method + ' ' + path).toBeTruthy()
    }
  }
  for (const path of ['/models', '/models/detect-capabilities', '/models/model-1/test']) {
    expect(remoteRequestError('remote', 'POST', path), path).toBeNull()
    for (const method of ['PATCH', 'DELETE']) expect(remoteRequestError('remote', method, path)).toBeTruthy()
  }
  expect(remoteRequestError('remote', 'PUT', '/models/detect-capabilities')).toBeTruthy()
  expect(remoteRequestError('remote', 'PUT', '/models/model-1')).toBeNull()
  expect(remoteRequestError('remote', 'POST', '/models/model-1')).toBeTruthy()
  expect(remoteRequestError('remote', 'DELETE', '/models/model-1')).toBeTruthy()
  expect(remoteRequestError('remote', 'PUT', '/models/model-1/test')).toBeTruthy()
  expect(remoteRequestError('embedded', 'POST', '/workspace/file')).toBeNull()
})

test('远端扩展资源管理全部开放到对应引擎', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/mcp/servers'], ['POST', '/mcp/servers'], ['GET', '/mcp/servers/fixture'], ['PUT', '/mcp/servers/fixture'], ['PATCH', '/mcp/servers/fixture'], ['DELETE', '/mcp/servers/fixture'], ['POST', '/mcp/servers/fixture/test'], ['POST', '/mcp/servers/fixture/enable'], ['POST', '/mcp/servers/fixture/disable'],
    ['GET', '/skills'], ['POST', '/skills'], ['GET', '/skills/fixture'], ['PATCH', '/skills/fixture'], ['DELETE', '/skills/fixture'], ['POST', '/skills/imports'], ['GET', '/skills/imports/import-1'], ['POST', '/skills/imports/chunks'], ['POST', '/skills/imports/chunks/merge'], ['GET', '/skills/imports/chunks'],
    ['GET', '/knowledge/bases'], ['POST', '/knowledge/bases'], ['PUT', '/knowledge/bases/base-1'], ['DELETE', '/knowledge/bases/base-1'], ['GET', '/knowledge/documents'], ['POST', '/knowledge/documents'], ['GET', '/knowledge/documents/doc-1'], ['PUT', '/knowledge/documents/doc-1'], ['DELETE', '/knowledge/documents/doc-1'], ['POST', '/knowledge/search']
  ]
  for (const [method, path] of routes) expect(remoteRequestError('remote', method, path), `${method} ${path}`).toBeNull()
})

test('远端目录按服务端语义校验，既有会话目录与空沙箱优先且损坏记录拒绝', () => {
  expect(validateRemoteWorkspaceRoot(' /srv/project ')).toBe('/srv/project')
  expect(validateRemoteWorkspaceRoot('D:\\project')).toBe('D:\\project')
  expect(validateRemoteWorkspaceRoot('')).toBe('')
  for (const value of ['relative/project', 'C:relative', '\\relative-root', '/srv/\nproject', null, 42]) {
    expect(() => validateRemoteWorkspaceRoot(value)).toThrow('远端')
  }
  expect(selectRemoteWorkspacePaths([], '')).toEqual([])
  expect(selectRemoteWorkspacePaths([], '/srv/configured')).toEqual(['/srv/configured'])
  expect(selectRemoteWorkspacePaths([{ workspacePaths: ['/srv/first'] }, { workspacePaths: ['/srv/latest'] }], '/srv/configured')).toEqual(['/srv/latest'])
  expect(selectRemoteWorkspacePaths([{ workspacePaths: [] }], '/srv/configured')).toEqual([])
  for (const runs of [null, {}, [{ workspacePaths: 'invalid' }], [{}], [null], [{ workspacePaths: [''] }], [{ workspacePaths: ['relative'] }]]) {
    expect(() => selectRemoteWorkspacePaths(runs, '/srv/configured')).toThrow('远端')
  }
})

test('远端审批只携带关联标识与回答，原始工作区交给服务端恢复', async () => {
  const clean = await prepareRemoteChatBody({
    sessionId: 'approval-session', runId: 'approval-run', workspacePaths: ['C:/local-only'],
    attachments: [{ name: 'private.txt' }], context: 'local contents',
    toolResponse: {
      runId: 'approval-run', requestId: 'request-1', toolCallId: 'tool-1', name: 'ask_user', output: 'approved',
      workspacePaths: ['C:/local-only'], context: 'local contents', cwd: 'C:/local-only'
    }
  }, { baseUrl: 'not-a-network-url', headers: {}, signal: new AbortController().signal, configuredRoot: '/srv/unrelated' })
  expect(clean).toEqual({
    sessionId: 'approval-session', runId: 'approval-run',
    toolResponse: { runId: 'approval-run', requestId: 'request-1', toolCallId: 'tool-1', name: 'ask_user', output: 'approved' }
  })
})

test('远端聊天保留服务端资源选择器，但不泄漏本地内联资源', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ code: 200, data: { runs: [] } }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const context = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers: {}, signal: new AbortController().signal, configuredRoot: '' }
  try {
    const result = await prepareRemoteChatBody({
    sessionId: 'selector-session', message: '查知识库', skills: ['fixture-skill'],
    mcpServers: ['fixture-mcp'], knowledgeBases: ['kb-1'], allowedTools: ['read_file'], ragTopK: 8,
    workspacePaths: ['C:/local-only'], inlineSkills: [{ id: 'secret', promptContent: 'local secret' }],
    inlineMcpServers: [{ id: 'secret-mcp', name: 'secret', transportType: 'http', url: 'http://local' }]
  }, context)
    expect(result).toMatchObject({ sessionId: 'selector-session', message: '查知识库', skills: ['fixture-skill'], mcpServers: ['fixture-mcp'], knowledgeBases: ['kb-1'], allowedTools: ['read_file'], ragTopK: 8 })
    expect(result).toEqual(expect.objectContaining({ workspacePaths: [] }))
    expect(result).not.toHaveProperty('inlineSkills')
    expect(result).not.toHaveProperty('inlineMcpServers')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('远端附件只接受真实上传登记，路径和类型取主进程登记值且拒绝跨源跨会话', () => {
  const target = { mode: 'remote' as const, baseUrl: 'http://fixture.invalid:1234', instanceId: 'instance-1' }
  clearRemoteAttachments()
  try {
    expect(remoteAttachmentsForRequest([{ name: 'C:/local-only/private.txt', type: 'text/plain' }], target, 'session-1')).toEqual([])
    expect(remoteAttachmentsForRequest(null, target, 'session-1')).toEqual([])
    const remoteUploadId = rememberRemoteAttachment(target, 'session-1', '/srv/uploads/registered.txt', 'text/plain')
    const input = [{ remoteUploadId, name: 'C:/forged-local-file', type: 'application/x-forged' }]
    expect(remoteAttachmentsForRequest(input, target, 'session-1')).toEqual([{ name: '/srv/uploads/registered.txt', type: 'text/plain' }])
    expect(() => remoteAttachmentsForRequest(input, target, 'other-session')).toThrow('会话已变化')
    for (const changed of [
      { ...target, mode: 'embedded' as const },
      { ...target, baseUrl: 'http://other-fixture.invalid:1234' },
      { ...target, instanceId: 'restarted-instance' }
    ]) expect(() => remoteAttachmentsForRequest(input, changed, 'session-1')).toThrow('连接或会话已变化')
    expect(() => remoteAttachmentsForRequest([{ remoteUploadId: 'unregistered' }], target, 'session-1')).toThrow('重新选择文件上传')
    clearRemoteAttachments()
    expect(() => remoteAttachmentsForRequest(input, target, 'session-1')).toThrow('重新选择文件上传')
  } finally { clearRemoteAttachments() }
})


test('远端目录查询拒绝跨服务重定向，实例令牌不会送到第二台服务', async () => {
  const redirectedRequests: Array<{ path: string; token: string | string[] | undefined }> = []
  const sourceRequests: Array<{ path: string; token: string | string[] | undefined }> = []
  const destination = createServer((request, response) => {
    redirectedRequests.push({ path: request.url ?? '', token: request.headers['x-aether-instance-token'] })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ code: 200, data: { runs: [] } }))
  })
  let destinationUrl = ''
  const source = createServer((request, response) => {
    sourceRequests.push({ path: request.url ?? '', token: request.headers['x-aether-instance-token'] })
    response.writeHead(307, { Location: destinationUrl + '/redirected-runs' })
    response.end()
  })
  const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  }
  const close = async (server: Server): Promise<void> => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  try {
    destinationUrl = await listen(destination)
    const baseUrl = await listen(source)
    await expect(prepareRemoteChatBody({ sessionId: 'redirect-boundary', message: 'synthetic fixture text' }, {
      baseUrl, headers: { 'X-Aether-Instance-Token': 'synthetic-redirect-contract-token' },
      signal: AbortSignal.timeout(10000), configuredRoot: ''
    })).rejects.toThrow(/fetch failed/i)
    expect(sourceRequests).toEqual([{
      path: '/api/v1/chat/runs?sessionId=redirect-boundary', token: 'synthetic-redirect-contract-token'
    }])
    expect(redirectedRequests).toEqual([])
  } finally { await Promise.all([close(source), close(destination)]) }
})

test('非文本远端消息在联网前被拒绝，结构化文件不能绕过附件登记', async () => {
  const context = { baseUrl: 'not-a-network-url', headers: {}, signal: new AbortController().signal, configuredRoot: '' }
  for (const message of [
    [{ type: 'workspace_file', name: 'C:/local-only/private.txt' }],
    [{ type: 'workspace_image', name: 'C:/local-only/private.png' }],
    [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }],
    { text: 'unexpected object' }, null, 1, true
  ]) {
    await expect(prepareRemoteChatBody({ sessionId: 'message-validation', message }, context)).rejects.toThrow('远端聊天消息必须是文本')
  }
})
