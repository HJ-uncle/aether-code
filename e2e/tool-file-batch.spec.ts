/** Pure batch/command target presentation and open-target safety; no browser or Electron window. */
import { expect, test } from '@playwright/test'
import { batchFileSummary } from '../src/renderer/src/features/conversation/shared/tool-file-args'
import { toolParamSummary, toolPathArg } from '../src/renderer/src/features/conversation/shared/tool-names'
import { sessionToolTarget } from '../src/renderer/src/features/conversation/message-timeline'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'

function tool(args: unknown, name = 'read_file'): ToolActivity {
  return { id: 'batch', name, args: JSON.stringify(args), state: 'done', result: '' }
}

test('batch targets summarize their first filename and count without creating a single-file action', () => {
  const args = { files: [{ path: 'D:\\workspace\\a.txt' }, { path: '/workspace/b.txt' }, { path: 'c.txt' }] }
  for (const name of ['read_file', 'write_file', 'office_inspect']) {
    const item = tool(args, name)
    expect(sessionToolTarget(item, 'D:/workspace')).toBe('a.txt 等 3 个文件')
    expect(toolParamSummary(item.args)).toBe('a.txt 等 3 个文件')
    expect(toolPathArg(item.args)).toBeNull()
  }
  expect(batchFileSummary({ files: [{ path: '文档/说明.docx' }] })).toBe('说明.docx（1 个文件）')
  expect(toolPathArg(JSON.stringify({ ...args, path: 'misleading.txt' }))).toBeNull()
})

test('invalid or incomplete batches never expose a misleading path or count', () => {
  for (const files of [null, [], ['a.txt'], [{ path: null }], [{ path: ' ' }], [{ path: 'a.txt' }, {}]]) {
    const args = { files }, item = tool(args)
    expect(batchFileSummary(args)).toBeNull()
    expect(sessionToolTarget(item)).toBe('')
    expect(toolParamSummary(item.args)).toBe('')
    expect(toolPathArg(item.args)).toBeNull()
  }
  expect(sessionToolTarget({ ...tool({}), args: '{"files":[' })).toBe('')
  expect(toolPathArg('{"files":[')).toBeNull()
})

test('single-file and command summaries retain their existing behavior', () => {
  const item = tool({ path: 'D:/workspace/a.txt' })
  expect(sessionToolTarget(item, 'D:/workspace')).toBe('a.txt')
  expect(toolParamSummary(item.args)).toBe('D:/workspace/a.txt')
  expect(toolPathArg(item.args)).toBe('D:/workspace/a.txt')
  expect(toolPathArg('{"filePath":"nested/file.ts"}')).toBe('nested/file.ts')
  expect(toolPathArg('{"url":"https://example.com"}')).toBeNull()
  expect(sessionToolTarget(tool({ command: 'npm test' }, 'execute_cmd'))).toBe('npm test')
})

test('long filenames keep the file count visible in a compact label', () => {
  const label = batchFileSummary({ files: [{ path: `${'a'.repeat(150)}.txt` }, { path: 'b.txt' }] })
  expect(label).toContain('… 等 2 个文件')
  expect(label!.length).toBeLessThan(96)
})

test('Work command aliases show the executable and ordered arguments instead of only cmd.exe', () => {
  for (const name of ['execute_cmd', 'execute_command', 'run_command']) {
    const item = tool({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm test -- --runInBand'] }, name)
    expect(sessionToolTarget(item)).toBe('cmd.exe /d /s /c "npm test -- --runInBand"')
    expect(sessionToolTarget(item, undefined, true)).toBe('cmd.exe /d /s /c "npm test -- --runInBand"')
    expect(toolParamSummary(item.args)).toBe('cmd.exe /d /s /c "npm test -- --runInBand"')
  }
  const partial = { ...tool({}, 'execute_cmd'), args: '{"command":"cmd.exe","args":[' }
  expect(sessionToolTarget(partial)).toBe('')
  expect(sessionToolTarget(partial, undefined, true)).toBe('')
})

test('command targets retain empty, spaced and quoted arguments without changing the receipt', () => {
  const item = tool({ command: 'node', args: ['--label', '', 'two words', 'say "hi"', "it's"] }, 'execute_cmd')
  const original = structuredClone(item)
  const expected = ['node', '--label', '""', '"two words"', String.raw`"say \"hi\""`, '"it\'s"'].join(' ')
  expect(sessionToolTarget(item)).toBe(expected)
  expect(sessionToolTarget(item, undefined, true)).toBe(expected)
  expect(item).toEqual(original)
})

test('canonical command jobs override stale invocation arguments even before argument JSON is complete', () => {
  const item: ToolActivity = { ...tool({ command: 'cmd.exe', args: ['/c', 'stale-request'] }, 'execute_cmd'),
    commandJob: { schemaVersion: 1, jobId: 'canonical-job', sessionId: 'task', ownerSessionId: 'task', version: 1,
      status: 'succeeded', command: 'node', args: ['scripts/real task.js', '--verified'], cwd: 'D:/workspace', background: false,
      createdAt: 1, updatedAt: 2, exitCode: 0, signal: null, cursor: 0, earliestCursor: 0 } }
  const original = structuredClone(item)
  expect(sessionToolTarget(item)).toBe('node "scripts/real task.js" --verified')
  expect(sessionToolTarget(item, undefined, true)).toBe('node "scripts/real task.js" --verified')
  expect(sessionToolTarget({ ...item, args: '{"command":' })).toBe('node "scripts/real task.js" --verified')
  expect(item).toEqual(original)
})

test('compact commands stop at the display limit while hover detail keeps the complete argument tail', () => {
  const script = `npm test -- ${'--project=full-command-evidence '.repeat(12)}COMMAND_ARGUMENT_TAIL`
  const item = tool({ command: 'cmd.exe', args: ['/d', '/s', '/c', script], cwd: 'D:/workspace' }, 'execute_cmd')
  const expected = `cmd.exe /d /s /c ${JSON.stringify(script)}`, original = structuredClone(item)
  expect(sessionToolTarget(item, 'D:/workspace')).toBe(expected.slice(0, 177) + '…')
  expect(sessionToolTarget(item, 'D:/workspace', true)).toBe(expected)
  expect(sessionToolTarget(item, undefined, true)).toContain('COMMAND_ARGUMENT_TAIL')
  expect(item).toEqual(original)
})
