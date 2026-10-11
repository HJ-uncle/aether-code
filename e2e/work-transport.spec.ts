/** Work transport boundary: a new Work task cannot silently inherit the Code
 * workspace, while an existing task retains its server-recorded workspace. */
import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { prepareRemoteChatBody } from '../src/main/engine/remote-workspace'

test('新 Work 任务使用独立沙箱，Code 会话仍使用配置目录，已有 Work 保留引擎记录', async () => {
  const requested: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    requested.push(url.searchParams.get('sessionId') ?? '')
    const runs =
      url.searchParams.get('sessionId') === 'work-existing'
        ? [{ workspacePaths: ['/srv/work-reports'] }]
        : url.searchParams.get('sessionId') === 'work-sandbox-existing'
          ? [{ workspacePaths: [] }]
          : []
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ code: 200, data: { runs } }))
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Work transport fixture has no port')
  const context = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    configuredRoot: '/srv/code-project',
    headers: {},
    signal: new AbortController().signal
  }
  try {
    const fresh = await prepareRemoteChatBody(
      {
        sessionId: 'work-new',
        message: '调研',
        memoryScope: 'off',
        workspacePaths: ['C:/code-project']
      },
      context
    )
    expect(fresh).toEqual({
      sessionId: 'work-new',
      message: '调研',
      memoryScope: 'off',
      workspacePaths: []
    })
    expect(
      await prepareRemoteChatBody(
        { sessionId: 'code-existing-selection', message: '修改代码' },
        context
      )
    ).toMatchObject({ workspacePaths: ['/srv/code-project'] })
    expect(
      await prepareRemoteChatBody({ sessionId: 'work-existing', message: '继续报告' }, context)
    ).toMatchObject({ workspacePaths: ['/srv/work-reports'] })
    expect(
      await prepareRemoteChatBody(
        { sessionId: 'work-sandbox-existing', message: '继续沙箱任务' },
        context
      )
    ).toMatchObject({ workspacePaths: [] })
    expect(requested).toEqual([
      'work-new',
      'code-existing-selection',
      'work-existing',
      'work-sandbox-existing'
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

test('Work 回答只回传关联信息，不能利用回答改写原任务目录', async () => {
  const clean = await prepareRemoteChatBody(
    {
      sessionId: 'work-waiting',
      runId: 'run-waiting',
      workspacePaths: ['C:/other-project'],
      toolResponse: {
        requestId: 'ask-1',
        runId: 'run-waiting',
        toolCallId: 'tool-1',
        name: 'ask_user',
        output: '简短报告',
        cwd: 'C:/other-project'
      }
    },
    {
      baseUrl: 'not-a-network-url',
      configuredRoot: '/srv/code-project',
      headers: {},
      signal: new AbortController().signal
    }
  )
  expect(clean).toEqual({
    sessionId: 'work-waiting',
    runId: 'run-waiting',
    toolResponse: {
      requestId: 'ask-1',
      runId: 'run-waiting',
      toolCallId: 'tool-1',
      name: 'ask_user',
      output: '简短报告'
    }
  })
})
