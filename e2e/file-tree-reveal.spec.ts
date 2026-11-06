/** Pure file-tree reveal contracts: real ancestor authority, platform path
 * aliases, missing targets, read failures and obsolete asynchronous requests.
 * No Electron, workspace mutations or filesystem fixtures. */
import { expect, test } from '@playwright/test'
import type { FsEntry } from '../src/shared/ipc'
import { resolveFileTreeReveal } from '../src/renderer/src/core/workspace/file-tree-reveal'

const entry = (path: string, isDirectory = true): FsEntry => ({
  path, name: path.replace(/\\/g, '/').split('/').at(-1) ?? path, isDirectory, size: 0, mtimeMs: 0
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error('Promise has not been initialized') }
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

test('deep relative and absolute files read actual ancestors in parent-first order', async () => {
  for (const path of ['src/deep/file.ts', '/workspace/src/deep/file.ts']) {
    const reads: string[] = []
    const entries: Record<string, FsEntry[]> = {
      '/workspace': [entry('/workspace/src')],
      '/workspace/src': [entry('/workspace/src/deep')],
      '/workspace/src/deep': [entry('/workspace/src/deep/file.ts', false)]
    }
    const result = await resolveFileTreeReveal({ root: '/workspace', path, readChildren: async directory => { reads.push(directory); return entries[directory] ?? null } })
    expect(result).toEqual({ path: '/workspace/src/deep/file.ts', ancestors: ['/workspace', '/workspace/src', '/workspace/src/deep'] })
    expect(reads).toEqual(['/workspace', '/workspace/src', '/workspace/src/deep'])
  }
})

test('Windows aliases retain the authoritative root and actual entry spelling', async () => {
  const reads: string[] = []
  const result = await resolveFileTreeReveal({ root: 'D:\\Trust-Test\\', path: 'd:/trust-test/DOCS/readme.MD', readChildren: async directory => {
    reads.push(directory)
    return directory === 'D:\\Trust-Test\\' ? [entry('D:/Trust-Test/Docs')] : [entry('D:/Trust-Test/Docs/README.md', false)]
  } })
  expect(result).toEqual({ path: 'D:/Trust-Test/Docs/README.md', ancestors: ['D:\\Trust-Test\\', 'D:/Trust-Test/Docs'] })
  expect(reads).toEqual(['D:\\Trust-Test\\', 'D:/Trust-Test/Docs'])
})

test('drive roots, POSIX roots and UNC roots support direct files', async () => {
  for (const [root, path, actual] of [
    ['C:\\', 'c:/readme.md', 'C:/README.md'],
    ['/', 'readme.md', '/readme.md'],
    ['\\\\Server\\Share', '//server/share/readme.md', '//Server/Share/README.md']
  ]) {
    const reads: string[] = []
    expect(await resolveFileTreeReveal({ root, path, readChildren: async directory => { reads.push(directory); return [entry(actual, false)] } }))
      .toEqual({ path: actual, ancestors: [root] })
    expect(reads).toEqual([root])
  }
})

test('POSIX matching preserves case for the root and every descendant', async () => {
  const reads: string[] = []
  const readChildren = async (directory: string): Promise<FsEntry[]> => { reads.push(directory); return [entry('/Root/Readme.md', false)] }
  expect(await resolveFileTreeReveal({ root: '/Root', path: '/root/Readme.md', readChildren })).toBeNull()
  expect(reads).toEqual([])
  expect(await resolveFileTreeReveal({ root: '/Root', path: 'readme.md', readChildren })).toBeNull()
  expect(await resolveFileTreeReveal({ root: '/Root', path: 'Readme.md', readChildren }))
    .toEqual({ path: '/Root/Readme.md', ancestors: ['/Root'] })
  expect(reads).toEqual(['/Root', '/Root'])
})

test('outside paths, traversal, drive-relative paths and root targets never authorize reads', async () => {
  const reads: string[] = []
  const requests = [
    ['/root', '/root-other/file.md'], ['/root', '/elsewhere/file.md'], ['/root', '../file.md'],
    ['/root', './file.md'], ['/root', 'docs/../file.md'], ['/root', 'docs/./file.md'],
    ['/root', '/root'], ['/root', ''], ['relative/root', 'file.md'], ['/root/../private', 'file.md'],
    ['C:\\Root', 'D:\\Root\\file.md'], ['C:\\Root', 'C:relative.md'], ['C:\\Root', '..\\file.md'],
    ['C:\\Root', 'c:/root'], ['//Server/Share', '//Other/Share/file.md'],
    ['/root', '//Server'], ['//Server', 'file.md']
  ]
  for (const [root, path] of requests) {
    expect(await resolveFileTreeReveal({ root, path, readChildren: async directory => { reads.push(directory); return [] } }), `${root}: ${path}`).toBeNull()
  }
  expect(reads).toEqual([])
})

test('missing ancestors stop traversal before reading a guessed directory', async () => {
  const reads: string[] = []
  expect(await resolveFileTreeReveal({ root: '/root', path: 'missing/file.md', readChildren: async directory => { reads.push(directory); return [entry('/root/other')] } })).toBeNull()
  expect(reads).toEqual(['/root'])
})

test('missing files, directories and files used as ancestors are not reveal targets', async () => {
  const reads: string[] = []
  const readChildren = async (directory: string): Promise<FsEntry[]> => {
    reads.push(directory)
    return directory === '/root' ? [entry('/root/docs'), entry('/root/plain.md', false)] : []
  }
  expect(await resolveFileTreeReveal({ root: '/root', path: 'docs/missing.md', readChildren })).toBeNull()
  expect(await resolveFileTreeReveal({ root: '/root', path: 'docs', readChildren })).toBeNull()
  expect(await resolveFileTreeReveal({ root: '/root', path: 'plain.md/child.md', readChildren })).toBeNull()
  expect(reads).toEqual(['/root', '/root/docs', '/root', '/root'])
})

test('unavailable root and child listings stop without returning a partial reveal', async () => {
  for (const unavailable of ['/root', '/root/docs']) {
    const reads: string[] = []
    const result = await resolveFileTreeReveal({ root: '/root', path: 'docs/file.md', readChildren: async directory => {
      reads.push(directory)
      return directory === unavailable ? null : [entry('/root/docs')]
    } })
    expect(result).toBeNull()
    expect(reads).toEqual(unavailable === '/root' ? ['/root'] : ['/root', '/root/docs'])
  }
})

test('entry names cannot authorize reads outside the requested direct child', async () => {
  const reads: string[] = []
  const result = await resolveFileTreeReveal({ root: '/root', path: 'docs/file.md', readChildren: async directory => {
    reads.push(directory)
    return [
      { ...entry('/elsewhere/docs'), name: 'docs' },
      { ...entry('/root/other/docs'), name: 'docs' },
      { ...entry('/root/../docs'), name: 'docs' }
    ]
  } })
  expect(result).toBeNull()
  expect(reads).toEqual(['/root'])
})

test('an already obsolete request never starts a read', async () => {
  const reads: string[] = []
  expect(await resolveFileTreeReveal({ root: '/root', path: 'file.md', current: () => false, readChildren: async directory => { reads.push(directory); return [entry('/root/file.md', false)] } })).toBeNull()
  expect(reads).toEqual([])
})

test('invalidation after an awaited child read discards its target', async () => {
  const pending = deferred<readonly FsEntry[] | null>()
  const childStarted = deferred<void>()
  let current = true
  const reads: string[] = []
  const result = resolveFileTreeReveal({ root: '/root', path: 'docs/file.md', current: () => current, readChildren: async directory => {
    reads.push(directory)
    if (directory === '/root') return [entry('/root/docs')]
    childStarted.resolve()
    return pending.promise
  } })
  await childStarted.promise
  current = false
  pending.resolve([entry('/root/docs/file.md', false)])
  expect(await result).toBeNull()
  expect(reads).toEqual(['/root', '/root/docs'])
})

test('a rapid replacement wins even when the previous root listing finishes later', async () => {
  const previousRoot = deferred<readonly FsEntry[] | null>()
  const reads: string[] = []
  let generation = 1
  const previous = resolveFileTreeReveal({ root: '/root', path: 'old/file.md', current: () => generation === 1, readChildren: async directory => {
    reads.push(`old:${directory}`)
    return previousRoot.promise
  } })
  generation = 2
  const latest = await resolveFileTreeReveal({ root: '/root', path: 'new.md', current: () => generation === 2, readChildren: async directory => {
    reads.push(`new:${directory}`)
    return [entry('/root/new.md', false)]
  } })
  previousRoot.resolve([entry('/root/old')])
  expect(latest).toEqual({ path: '/root/new.md', ancestors: ['/root'] })
  expect(await previous).toBeNull()
  expect(reads).toEqual(['old:/root', 'new:/root'])
})

test('read exceptions reach the caller instead of masquerading as missing files', async () => {
  const failure = new Error('Remote directory request failed')
  await expect(resolveFileTreeReveal({ root: '/root', path: 'file.md', readChildren: async () => { throw failure } })).rejects.toBe(failure)
})
