/** Pure Work receipt target regression: project roots show a recognizable name,
 * descendants stay relative, and outside/ambiguous/non-path values stay intact.
 * This isolated config does not launch Electron or execute existing E2E. */
import { expect, test } from '@playwright/test'
import type { ToolActivity } from '../src/renderer/src/core/engine/useChat'
import { sessionToolTarget } from '../src/renderer/src/features/conversation/message-timeline'

const windowsRoot = 'C:\\Users\\x\\test01'
const pathFields = ['path', 'filePath', 'file_path', 'file'] as const
function tool(field: string, value: string, name = 'list_directory'): ToolActivity {
  return { id: 'project-target', name, args: JSON.stringify({ [field]: value }), result: '', state: 'done' }
}

test('项目根和当前目录用项目名显示，四种路径字段与 Windows 大小写混斜杠一致', () => {
  for (const field of pathFields) {
    for (const value of [windowsRoot, `${windowsRoot}\\`, 'c:/USERS/x/test01/', '.', './']) {
      expect(sessionToolTarget(tool(field, value), `${windowsRoot}\\`), `${field}: ${value}`).toBe('test01')
    }
  }
})

test('项目内文件保留完整相对目录，不只剩下文件名', () => {
  for (const field of pathFields) {
    expect(sessionToolTarget(tool(field, 'c:/users/X/test01\\src/main.ts'), windowsRoot), field).toBe('src/main.ts')
    expect(sessionToolTarget(tool(field, `${windowsRoot}\\src\\components\\MainView.tsx`), `${windowsRoot}/`), field)
      .toBe('src/components/MainView.tsx')
  }
})

test('项目外文件与相似前缀目录保持原路径，不误认成当前项目', () => {
  for (const value of ['C:\\Users\\x\\other\\main.ts', `${windowsRoot}-copy\\src\\main.ts`, 'D:\\Users\\x\\test01\\main.ts']) {
    expect(sessionToolTarget(tool('path', value), windowsRoot), value).toBe(value)
  }
  expect(sessionToolTarget(tool('path', 'C:'), 'C:/')).toBe('C:')
  expect(sessionToolTarget(tool('path', 'C:/'), 'C:/')).toBe('C:/')
  expect(sessionToolTarget(tool('path', '//server/share/file'), '/')).toBe('//server/share/file')
  expect(sessionToolTarget(tool('path', '/'), '/')).toBe('/')
  expect(sessionToolTarget(tool('path', '/src/main.ts'), '/')).toBe('src/main.ts')
})

test('POSIX 项目只对大小写完全匹配的根和后代缩短', () => {
  const root = '/srv/projects/test01'
  for (const [value, expected] of [[root, 'test01'], [`${root}/`, 'test01'], ['./', 'test01'],
    [`${root}/src/main.ts`, 'src/main.ts'], ['/srv/Projects/test01/src/main.ts', '/srv/Projects/test01/src/main.ts'],
    ['/srv/projects/Test01', '/srv/projects/Test01']] as const) {
    expect(sessionToolTarget(tool('file_path', value), `${root}/`), value).toBe(expected)
  }
})

test('UNC 共享根显示共享名，内部文件相对显示，其他共享保持原文', () => {
  const root = '\\\\server\\share'
  expect(sessionToolTarget(tool('path', '//SERVER/share/'), `${root}\\`)).toBe('share')
  expect(sessionToolTarget(tool('filePath', '\\\\SERVER\\SHARE\\src\\main.ts'), root)).toBe('src/main.ts')
  const otherShare = '\\\\server\\share-copy\\src\\main.ts'
  const otherServer = '\\\\another-server\\share\\src\\main.ts'
  expect(sessionToolTarget(tool('path', otherShare), root)).toBe(otherShare)
  expect(sessionToolTarget(tool('path', otherServer), root)).toBe(otherServer)
})

test('含父级跳转的绝对路径保守保留，完整详情始终保留原始路径', () => {
  for (const [root, value] of [[windowsRoot, `${windowsRoot}\\..\\secret.txt`],
    ['/srv/projects/test01', '/srv/projects/test01/src/../main.ts']] as const) {
    expect(sessionToolTarget(tool('path', value), root), value).toBe(value)
  }
  for (const field of pathFields) {
    for (const value of [windowsRoot, `${windowsRoot}\\src\\main.ts`, '.', './']) {
      expect(sessionToolTarget(tool(field, value), windowsRoot, true), `${field}: ${value}`).toBe(value)
    }
  }
})

test('搜索词、命令和 URL 等非路径参数即使与项目路径相似也不缩短', () => {
  const descendant = `${windowsRoot}/src/main.ts`
  for (const field of ['query', 'pattern', 'command', 'url', 'description', 'task', 'title', 'skill', 'name']) {
    expect(sessionToolTarget(tool(field, descendant, 'inspect_resource'), windowsRoot), field).toBe(descendant)
  }
  expect(sessionToolTarget(tool('command', `${windowsRoot}\\runner.exe`, 'execute_cmd'), windowsRoot))
    .toBe(`${windowsRoot}\\runner.exe`)
  expect(sessionToolTarget(tool('url', 'https://example.test/test01/src/main.ts', 'fetch_url'), windowsRoot))
    .toBe('https://example.test/test01/src/main.ts')
})
