/** Pure contracts: copied tool failures retain actual diagnostics, command argv and honest exit status. */
import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { finishTool, replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { toolStatusLabel } from '../src/renderer/src/core/engine/subagent-state'
import { boundToolOutput, commandInvocation, exportToolDiagnostics, toolFailureMessage } from '../src/renderer/src/core/engine/tool-feedback'

function tool(patch: Partial<ToolActivity> = {}): ToolActivity {
  return { id: 'verify-gomoku', name: 'execute_cmd', args: JSON.stringify({ command: 'cmd.exe', args: ['/d', '/c', 'node .ae/tmp/test-gomoku.mjs'] }),
    result: '', state: 'running', ...patch }
}

test('普通前台命令的真实断言失败保留 stdout、stderr、退出码和具体调用', () => {
  const executed = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import assert from "node:assert/strict"; console.log("gomoku: checking diagonal win"); assert.equal(4, 5, "winning line must contain five stones");'],
  { encoding: 'utf8', windowsHide: true })
  expect(executed.error).toBeUndefined()
  expect(executed.status).toBe(1)
  const output = [executed.stdout, executed.stderr].join('\n')
  const finished = finishTool(tool(), { success: false, status: 'failed', output, error: 'COMMAND_EXIT_FAILED', metadata: { exitCode: executed.status } })
  expect(toolStatusLabel(finished)).toBe('命令退出码 1')
  expect(toolFailureMessage(finished)).toBe('命令退出码 1（COMMAND_EXIT_FAILED）')
  const report = exportToolDiagnostics(finished)
  expect(report).toContain('cmd.exe /d /c "node .ae/tmp/test-gomoku.mjs"')
  expect(report).toContain('退出码：1')
  expect(report).toContain('COMMAND_EXIT_FAILED')
  expect(report).toContain('gomoku: checking diagonal win')
  expect(report).toContain('AssertionError')
  expect(report).toContain('winning line must contain five stones')
  expect(report).not.toContain('命令未启动')
})

test('历史回放导出保留启动失败原因而非只复制错误码', () => {
  const messages = replayMessages([
    { role: 'assistant', id: 'assistant', conversationId: 'turn', toolCall: { id: 'missing-node', name: 'execute_cmd', args: { command: 'node -v', cwd: 'D:/project' } } },
    { role: 'tool', toolCallId: 'missing-node', content: 'spawn node -v ENOENT', metadata: { success: false, status: 'failed', error: 'COMMAND_SPAWN_FAILED', exitCode: null } }
  ])
  const failed = messages[0].tools[0]
  expect(toolStatusLabel(failed)).toBe('命令未启动')
  const report = exportToolDiagnostics(failed)
  expect(report).toContain('COMMAND_SPAWN_FAILED')
  expect(report).toContain('spawn node -v ENOENT')
  expect(report).toContain('工作目录：D:/project')
  expect(report).not.toContain('退出码：null')
})

test('前台任务从保留元数据取得退出状态，未被误判成后台卡片', () => {
  const failed = tool({ state: 'error', error: 'COMMAND_EXIT_FAILED', metadata: { commandJob: {
    background: false, exitCode: 7, signal: null, cwd: 'D:/project',
    error: { code: 'COMMAND_EXIT_FAILED', message: 'Command exited with code 7' }
  } }, result: 'SyntaxError: Unexpected token at index.html:32' })
  expect(toolStatusLabel(failed)).toBe('命令退出码 7')
  expect(exportToolDiagnostics(failed)).toContain('工作目录：D:/project')
  expect(exportToolDiagnostics(failed)).toContain('SyntaxError: Unexpected token at index.html:32')
  expect(toolFailureMessage(failed)).toContain('Command exited with code 7')
})

test('普通工具错误导出保留可恢复建议，成功读取不倾倒整份源码', () => {
  const failed = tool({ name: 'edit_file', state: 'error', error: 'EDIT_VERSION_CONFLICT', result: '文件已改变，请重新读取 .ae/tmp/test-gomoku.mjs 后使用最新版本重试。' })
  expect(exportToolDiagnostics(failed)).toContain('EDIT_VERSION_CONFLICT')
  expect(exportToolDiagnostics(failed)).toContain('使用最新版本重试')
  expect(exportToolDiagnostics(tool({ name: 'read_file', state: 'done', result: 'private project source' }))).toBe('')
})

test('命令摘要展示全部 argv，空参数及带空格路径保留边界', () => {
  expect(commandInvocation(JSON.stringify({ command: 'node', args: ['D:/my project/check.mjs', '', '--name', 'a "quoted" value'] })))
    .toBe('node "D:/my project/check.mjs" "" --name "a \\"quoted\\" value"')
  expect(commandInvocation('{')).toBeUndefined()
  expect(commandInvocation(JSON.stringify({ path: 'index.html' }))).toBeUndefined()
  expect(commandInvocation(JSON.stringify({ command: 'node --version' }))).toBe('node --version')
})

test('超长输出显式限长，首尾错误证据和内含 Markdown 围栏仍可阅读', () => {
  const report = exportToolDiagnostics(tool({ state: 'error', error: 'COMMAND_EXIT_FAILED', result: 'FIRST_FAILURE\n```js\n' + 'middle log '.repeat(5000) + '\nFINAL_ASSERTION' }))
  expect(report).toContain('FIRST_FAILURE')
  expect(report).toContain('FINAL_ASSERTION')
  expect(report).toContain('中间内容已省略')
  expect(report).toContain('````text')
  expect(report.length).toBeLessThan(12500)
  expect(boundToolOutput('short diagnostic')).toBe('short diagnostic')
})

test('退出、信号、取消及未知结果只根据返回证据显示，不推测成功', () => {
  expect(toolStatusLabel(tool({ state: 'error', error: 'COMMAND_EXIT_FAILED' }))).toBe('命令退出非零')
  expect(toolStatusLabel(tool({ state: 'error', error: 'COMMAND_EXIT_FAILED', metadata: { signal: 'SIGTERM' } }))).toBe('命令被信号 SIGTERM 终止')
  expect(toolStatusLabel(tool({ state: 'error', error: 'COMMAND_TIMEOUT', metadata: { exitCode: 1 } }))).toBe('命令已超时')
  expect(toolStatusLabel(tool({ state: 'cancelled', error: 'COMMAND_CANCELLED' }))).toBe('已取消')
  expect(toolStatusLabel(tool({ state: 'unknown' }))).toBe('状态未知')
  expect(toolStatusLabel(tool({ state: 'done', result: '28 passed' }))).toBe('成功')
  expect(toolStatusLabel(tool({ name: 'code_diagnose', state: 'error', error: 'No adapter supports index.html' }))).toBe('失败')
})
