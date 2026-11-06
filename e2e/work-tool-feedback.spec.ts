/** Pure Work-only feedback: explicit test runners, truthful command outcomes,
 * compact operation errors, and immutable legacy receipts. No Electron or commands. */
import { expect, test } from '@playwright/test'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import type { CommandJobSnapshot } from '../src/shared/command-job'
import { workToolFeedback } from '../src/renderer/src/contrib/work/work-tool-feedback'

function tool(patch: Partial<ToolActivity> = {}): ToolActivity {
  return { id: 'step', name: 'execute_cmd', args: JSON.stringify({ command: 'node', args: ['--test', 'test/engine.test.mjs'] }),
    result: 'not ok 1 - engine contract\nAssertionError: expected 4 to equal 5', state: 'error',
    error: 'COMMAND_EXIT_FAILED', metadata: { exitCode: 1 }, ...patch }
}

function invocation(command: string, args: string[], patch: Partial<ToolActivity> = {}): ToolActivity {
  return tool({ args: JSON.stringify({ command, args }), ...patch })
}

test('显式 node --test 退出 1 只报告测试未通过，普通 node 命令报告命令未通过', () => {
  expect(workToolFeedback(tool())).toEqual({ label: '测试未通过', detail: '测试已结束，退出码 1', kind: 'check' })
  expect(workToolFeedback(invocation('node', ['server.mjs']))).toEqual({ label: '命令未通过', detail: '命令已结束，退出码 1', kind: 'command' })
  expect(workToolFeedback(invocation('C:\\Program Files\\nodejs\\node.exe', ['--no-warnings', '--test', 'test.mjs']))?.kind).toBe('check')
  expect(workToolFeedback(tool({ error: undefined, metadata: { exitCode: 2 } }))).toEqual({ label: '测试未通过', detail: '测试已结束，退出码 2', kind: 'check' })
})

test('只从明确 runner 与子命令认定测试，不凭 test 文件名或 failed 日志猜测', () => {
  for (const [command, args] of [
    ['pytest', ['tests/test_engine.py']], ['python3', ['-m', 'pytest', 'tests']], ['python', ['-m', 'unittest']],
    ['npx', ['playwright', 'test']], ['npx', ['vitest', 'run']], ['jest', ['--runInBand']],
    ['npm.cmd', ['test']], ['pnpm', ['run', 'test:e2e']], ['yarn', ['test']], ['go', ['test', './...']],
    ['cargo', ['test']], ['dotnet', ['test']], ['bun', ['test']], ['deno', ['test']]
  ] as Array<[string, string[]]>) expect(workToolFeedback(invocation(command, args))?.kind, `${command} ${args.join(' ')}`).toBe('check')
  for (const [command, args] of [
    ['node', ['test/engine.test.mjs']], ['node', ['server.js', '--test']], ['node', ['--', '--test']],
    ['node', ['-e', 'console.log("--test")', '--test']], ['node', ['--eval=console.log(1)', '--test']], ['node', ['-econsole.log(1)', '--test']],
    ['cmd.exe', ['/c', 'node --test test.mjs']], ['sh', ['-c', 'pytest tests']],
    ['echo', ['tests failed']], ['npm', ['install', 'vitest']], ['npm', ['run', 'contest']],
    ['python', ['test.py']], ['playwright', ['install']], ['vitest', ['list']], ['pytest', ['--version']]
  ] as Array<[string, string[]]>) expect(workToolFeedback(invocation(command, args))?.kind, `${command} ${args.join(' ')}`).toBe('command')
})

test('启动失败、超时和信号终止优先于测试入口与退出 1，不声称断言未通过', () => {
  expect(workToolFeedback(tool({ error: 'COMMAND_SPAWN_FAILED' }))).toEqual({ label: '命令未启动', detail: '未能启动命令', kind: 'command' })
  expect(workToolFeedback(tool({ error: 'COMMAND_TIMEOUT', metadata: { exitCode: 1, signal: 'SIGTERM' } })))
    .toEqual({ label: '命令已超时', detail: '命令超过执行时限，已停止等待', kind: 'command' })
  expect(workToolFeedback(tool({ metadata: { exitCode: 1, signal: 'SIGTERM' } })))
    .toEqual({ label: '命令被终止', detail: '命令被信号 SIGTERM 终止', kind: 'command' })
})

test('持久命令及前台 metadata 的结构化状态优先，保留未提供退出码的事实', () => {
  const job: CommandJobSnapshot = { schemaVersion: 1, jobId: 'job', sessionId: 'session', ownerSessionId: 'session', version: 1,
    status: 'failed', command: 'node', args: ['--test', 'engine.test.mjs'], cwd: 'D:/project', background: true,
    createdAt: 1, updatedAt: 2, finishedAt: 2, exitCode: 7, signal: null,
    error: { code: 'COMMAND_EXIT_FAILED', message: 'Command exited with code 7' }, cursor: 1, earliestCursor: 0 }
  expect(workToolFeedback(tool({ args: '{', commandJob: job }))).toEqual({ label: '测试未通过', detail: '测试已结束，退出码 7', kind: 'check' })
  expect(workToolFeedback(tool({ args: '{}', commandJob: undefined, metadata: { commandJob: { ...job, background: false } } })))
    .toEqual({ label: '测试未通过', detail: '测试已结束，退出码 7', kind: 'check' })
  expect(workToolFeedback(tool({ commandJob: { ...job, status: 'timed_out', error: undefined, exitCode: null } })))
    .toEqual({ label: '命令已超时', detail: '命令超过执行时限，已停止等待', kind: 'command' })
  expect(workToolFeedback(invocation('node', ['script.js'], { metadata: undefined })))
    .toEqual({ label: '命令未通过', detail: '命令已结束，返回非零退出码', kind: 'command' })
  expect(workToolFeedback(tool({ metadata: { exitCode: '1' }, error: undefined }))?.label).toBe('未完成')
})

test('普通操作只给简短人类原因，不将机器枚举或输出中的测试关键词当标题', () => {
  const input = tool({ name: 'edit_file', error: 'EDIT_VERSION_CONFLICT', result: '文件已改变，请读取最新内容。\n后续诊断', metadata: undefined })
  expect(workToolFeedback(input)).toEqual({ label: '未完成', detail: '这一步未完成', kind: 'operation' })
  expect(workToolFeedback({ ...input, error: '无法读取目标文件', result: 'tests failed; timeout; COMMAND_EXIT_FAILED' }))
    .toEqual({ label: '未完成', detail: '无法读取目标文件', kind: 'operation' })
  expect(workToolFeedback({ ...input, result: '{"code":"EDIT_VERSION_CONFLICT"}' }))
    .toEqual({ label: '未完成', detail: '这一步未完成', kind: 'operation' })
  expect(workToolFeedback({ ...input, error: 'Error: EDIT_VERSION_CONFLICT', result: '{\n  "code": "EDIT_VERSION_CONFLICT"\n}' })?.detail)
    .toBe('这一步未完成')
  expect(workToolFeedback({ ...input, metadata: { error: { code: 'VERSION_CONFLICT', message: '文件版本已经变化' } }, result: '正常输出的首行' })?.detail)
    .toBe('文件版本已经变化')
  expect(workToolFeedback({ ...input, result: '已读取配置\nError: test failed' })?.detail).toBe('这一步未完成')
  expect(workToolFeedback({ ...input, error: '{"error":{"code":"VERSION_CONFLICT","message":"文件版本已经变化"}}' })?.detail)
    .toBe('文件版本已经变化')
  expect(workToolFeedback({ ...input, error: 'x'.repeat(300) })?.detail).toHaveLength(138)
})

test('成功、未知、等待、取消和运行中不生成失败提示，中断不推断重试结果', () => {
  for (const state of ['done', 'unknown', 'waiting', 'cancelled', 'running'] as const) {
    expect(workToolFeedback(tool({ state, result: 'failed timeout assertion error' }))).toBeNull()
  }
  expect(workToolFeedback(tool({ name: 'read_file', state: 'interrupted' })))
    .toEqual({ label: '已中断', detail: '这一步已中断，执行结果尚未确认', kind: 'operation' })
  expect(workToolFeedback(tool({ state: 'done' }), 'error')?.label).toBe('测试未通过')
  expect(workToolFeedback(tool(), 'done')).toBeNull()
  expect(workToolFeedback(tool({ state: 'interrupted', metadata: { signal: 'SIGTERM' } })))
    .toEqual({ label: '已中断', detail: '命令已中断，信号 SIGTERM', kind: 'command' })
})

test('展示计算不修改旧回执的 state、error、result、args 或元数据', () => {
  const input = tool({ result: '[COMMAND_EXIT_FAILED] status=failed; exitCode=1\nstdout\nstderr\n' })
  const before = structuredClone(input)
  Object.freeze(input.metadata)
  Object.freeze(input)
  expect(workToolFeedback(input)?.label).toBe('测试未通过')
  expect(input).toEqual(before)
  expect(input.state).toBe('error')
  expect(input.error).toBe('COMMAND_EXIT_FAILED')
  expect(input.result).toBe(before.result)
})
