/** Pure chat path parsing: Windows/UNC/POSIX roots, line/column suffixes and literal filenames. */
import { expect, test } from '@playwright/test'
import { resolveChatPath } from '../src/renderer/src/contrib/chat/chat-file-path'

for (const filePath of [
  'C:\\project\\file.ts',
  'D:/project/file.ts',
  '\\\\server\\share\\file.ts',
  '//server/share/file.ts',
  '/project/file.ts'
]) {
  test(`absolute reference preserves its path and extracts line/column: ${filePath}`, () => {
    expect(resolveChatPath(filePath, null)).toEqual({ filePath, line: undefined, column: undefined })
    expect(resolveChatPath(`${filePath}:15`, null)).toEqual({ filePath, line: 15, column: undefined })
    expect(resolveChatPath(`${filePath}:15:2`, '/unrelated')).toEqual({ filePath, line: 15, column: 2 })
  })
}

test('relative references use the explicit workspace and preserve separator semantics', () => {
  expect(resolveChatPath('src/file.ts:15:2', 'C:\\project')).toEqual({ filePath: 'C:\\project/src/file.ts', line: 15, column: 2 })
  expect(resolveChatPath('src\\file.ts:15', '\\\\server\\share\\')).toEqual({ filePath: '\\\\server\\share/src\\file.ts', line: 15, column: undefined })
  expect(resolveChatPath('./src/file.ts', '/project/')).toEqual({ filePath: '/project/./src/file.ts', line: undefined, column: undefined })
  expect(resolveChatPath('file.ts', '/')).toEqual({ filePath: '/file.ts', line: undefined, column: undefined })
  expect(resolveChatPath('file.ts', 'C:\\')).toEqual({ filePath: 'C:/file.ts', line: undefined, column: undefined })
})

test('quotes, spaces, Chinese, percent escapes and hashes stay literal filename characters', () => {
  const windowsPath = 'C:\\my project\\中文 100% #tag%23.ts'
  expect(resolveChatPath(`  \`${windowsPath}:12:3\`  `, null)).toEqual({ filePath: windowsPath, line: 12, column: 3 })
  expect(resolveChatPath('"src/中文 100% #tag%23.ts:7"', '/my project')).toEqual({ filePath: '/my project/src/中文 100% #tag%23.ts', line: 7, column: undefined })
  expect(resolveChatPath('</my project/中文#100%.ts>', null)).toEqual({ filePath: '/my project/中文#100%.ts', line: undefined, column: undefined })
  expect(resolveChatPath("'src/中文.ts:9:4'", '/project')).toEqual({ filePath: '/project/src/中文.ts', line: 9, column: 4 })
})

test('relative references need an absolute workspace root', () => {
  for (const workspaceRoot of [null, '', 'relative-root', 'C:']) {
    expect(resolveChatPath('src/file.ts:15:2', workspaceRoot)).toBeNull()
  }
  for (const empty of ['', '  ', '``', '<>']) expect(resolveChatPath(empty, '/project')).toBeNull()
})

test('bare drive letters and drive-relative paths cannot become workspace-relative filenames', () => {
  for (const drive of ['C:', 'd:', '<C:>', 'C:15', 'C:15:2', 'C:relative.ts:15']) {
    expect(resolveChatPath(drive, null)).toBeNull()
    expect(resolveChatPath(drive, 'D:\\workspace')).toBeNull()
  }
})
