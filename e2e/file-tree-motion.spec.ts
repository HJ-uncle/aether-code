/** Pure virtual-tree motion: expanded children never receive an offset; only
 * real visible successors of a collapsed branch can settle into place. */
import { expect, test } from '@playwright/test'
import { fileTreeSettlingPaths, type FileTreeMotionRow } from '../src/renderer/src/contrib/explorer/file-tree-motion'

const row = (path: string, index: number, directory = false): FileTreeMotionRow => ({ path, index, directory, expanded: false })

test('展开或普通虚拟滚动都不为子项生成二次位移', () => {
  const expanded = [row('/root/docs', 0, true), row('/root/docs/a.md', 1), row('/root/docs/b.md', 2), row('/root/next.md', 3)]
  expect([...fileTreeSettlingPaths(expanded, [])]).toEqual([])
  expect([...fileTreeSettlingPaths([row('/root/docs/item-80.md', 80)], [])]).toEqual([])
})

test('收起仅轻移边界后实际挂载的行，没有后续行时不制造动画', () => {
  const after = [row('/root/first.md', 0), row('/root/docs', 1, true), row('/root/next.md', 2), row('/root/notes.md', 3)]
  expect([...fileTreeSettlingPaths(after, ['/root/docs'])]).toEqual(['/root/next.md', '/root/notes.md'])
  expect([...fileTreeSettlingPaths(after.slice(0, 2), ['/root/docs'])]).toEqual([])
})

test('Windows 路径写法不影响收起边界，其他目录关闭不误触发', () => {
  const after = [row('d:/root/docs', 0, true), row('d:/root/notes.md', 1)]
  expect([...fileTreeSettlingPaths(after, ['D:\\Root\\Docs'])]).toEqual(['d:/root/notes.md'])
  expect([...fileTreeSettlingPaths(after, ['d:/other/docs'])]).toEqual([])
})
