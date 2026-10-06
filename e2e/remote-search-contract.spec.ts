import { expect, test } from '@playwright/test'
import { flattenRemoteFiles, previewRemoteReplace, replaceRemoteWorkspace, searchRemoteWorkspace, type RemoteSearchTransport, type RemoteWorkspaceItem } from '../src/renderer/src/contrib/search/remote-search'

function transport(tree: RemoteWorkspaceItem, files: Record<string, string>): RemoteSearchTransport {
  let current = true
  return {
    assertCurrent: () => { if (!current) throw new Error('切换') },
    listFiles: async () => tree,
    readFile: async (path) => ({ content: files[path] ?? '', isBinary: false, totalSize: files[path]?.length ?? 0, originalLength: files[path]?.length ?? 0 }),
    writeFile: async (path, content) => { files[path] = content }
  }
}

const options = { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' }

test.describe('远程搜索/替换契约', () => {
  test('展平目录保留每一层相对路径并忽略会话根标签', () => {
    expect(flattenRemoteFiles({ name: 'session', type: 'dir', children: [
      { name: 'src', type: 'dir', children: [{ name: 'main.ts', type: 'file' }] },
      { name: 'README.md', type: 'file' }
    ] })).toEqual(['src/main.ts', 'README.md'])
  })

  test('按真实换行搜索，文件筛选和美元替换保持字面量', async () => {
    const files = { 'src/a.txt': 'one\ntwo\none', 'skip.txt': 'one' }
    const t = transport({ name: 's', type: 'dir', children: [
      { name: 'src', type: 'dir', children: [{ name: 'a.txt', type: 'file' }] },
      { name: 'skip.txt', type: 'file' }
    ] }, files)
    const searched = await searchRemoteWorkspace(t, 'one', options, {})
    expect(searched.hits.map(hit => [hit.path, hit.line])).toEqual([['src/a.txt', 1], ['src/a.txt', 3], ['skip.txt', 1]])
    const preview = await previewRemoteReplace(t, 'one', options, '$1', {})
    expect(preview.files[0].lines[0].after).toBe('$1')
    const replaced = await replaceRemoteWorkspace(t, 'one', options, '$1', {})
    expect(replaced.replacements).toBe(3)
    expect(files['src/a.txt']).toBe('$1\ntwo\n$1')
  })

  test('连接切换会中止后续文件请求而不是静默混合结果', async () => {
    let first = true
    const t = transport({ name: 's', type: 'dir', children: [{ name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }] }, { 'a.txt': 'x', 'b.txt': 'x' })
    const original = t.readFile
    t.readFile = async (path) => { const value = await original(path); first = false; return value }
    t.assertCurrent = () => { if (!first) throw new Error('连接已切换') }
    await expect(searchRemoteWorkspace(t, 'x', options, {})).rejects.toThrow('连接已切换')
  })
})
