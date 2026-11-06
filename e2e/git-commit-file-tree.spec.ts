/** Pure history-tree contracts: real ancestry, root files, compact paths and stable diff targets. */
import { expect, test } from '@playwright/test'
import type { GitCommitFileChange } from '../src/shared/git-types'
import { buildCommitFileTree } from '../src/renderer/src/core/git/git-commit-file-tree'

const change = (path: string): GitCommitFileChange => ({ path, code: 'M' })

test('历史树直接显示根文件，共同目录只出现一次且兄弟目录归属正确', () => {
  const tree = buildCommitFileTree([
    change('package.json'), change('src/main/codemap/service.ts'),
    change('src/preload/api.ts'), change('src/renderer/code/Panel.tsx'), change('docs/guide.md')
  ])
  expect(tree.map(node => [node.path, node.name, !!node.children])).toEqual([
    ['docs', 'docs', true], ['src', 'src', true], ['package.json', 'package.json', false]
  ])
  expect(tree[1].children?.map(node => [node.path, node.name])).toEqual([
    ['src/main/codemap', 'main/codemap'], ['src/preload', 'preload'], ['src/renderer/code', 'renderer/code']
  ])
  expect(tree[1].children?.[1].children?.map(node => node.file?.path)).toEqual(['src/preload/api.ts'])
  expect(tree[2].file?.path).toBe('package.json')
})

test('历史树仅压缩单子目录链，保留包含文件或分支的目录', () => {
  const tree = buildCommitFileTree([
    change('src/index.ts'), change('src/features/auth/ui/Login.tsx'),
    change('src/features/auth/api/login.ts'), change('tools/scripts/build.ts')
  ])
  expect(tree.map(node => node.name)).toEqual(['src', 'tools/scripts'])
  expect(tree[0].children?.map(node => node.name)).toEqual(['features/auth', 'index.ts'])
  expect(tree[0].children?.[0].children?.map(node => node.name)).toEqual(['api', 'ui'])
  expect(tree[1].children?.[0].path).toBe('tools/scripts/build.ts')
})

test('历史树目录优先并自然排序，重复文件名仍保留各自完整路径', () => {
  const tree = buildCommitFileTree([
    change('item10.ts'), change('module10/index.ts'), change('item2.ts'),
    change('module2/index.ts'), change('item1.ts')
  ])
  expect(tree.map(node => node.name)).toEqual(['module2', 'module10', 'item1.ts', 'item2.ts', 'item10.ts'])
  expect(tree.slice(0, 2).map(node => node.children?.[0].file?.path)).toEqual(['module2/index.ts', 'module10/index.ts'])
})

test('历史树保留空格、中文与重命名源路径，不修改输入记录', () => {
  const renamed = Object.freeze({ path: '目录 with space/new file.ts', oldPath: '旧目录/old file.ts', code: 'R100' })
  const rootFile = Object.freeze(change('root file.txt'))
  const files = Object.freeze([rootFile, renamed])
  const before = JSON.stringify(files)
  const tree = buildCommitFileTree(files)
  expect(tree[0].name).toBe('目录 with space')
  expect(tree[0].children?.[0].name).toBe('new file.ts')
  expect(tree[0].children?.[0].file).toBe(renamed)
  expect(tree[0].children?.[0].file?.oldPath).toBe('旧目录/old file.ts')
  expect(JSON.stringify(files)).toBe(before)
})

test('历史树空提交为空，重复路径只生成一个稳定节点', () => {
  expect(buildCommitFileTree([])).toEqual([])
  const file = change('src/a.ts')
  const tree = buildCommitFileTree([file, file])
  expect(tree).toEqual([{ path: 'src', name: 'src', children: [{ path: 'src/a.ts', name: 'a.ts', file }] }])
})
