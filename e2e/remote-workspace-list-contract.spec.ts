import { expect, test } from '@playwright/test'
import { listAllFiles } from '../src/renderer/src/core/workspace/fs-client'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'
import { publishWorkspaceSelection } from '../src/renderer/src/core/workspace/connection'
import { DEFAULT_SETTINGS } from '../src/shared/ipc'

test('远端工作区文件列表供快速打开与 @ 引用使用会话相对路径', async () => {
  // Playwright's pure-function workers may leave a read-only `window` descriptor
  // behind after another spec restores its environment.  Replacing the global by
  // assignment then throws before the contract is exercised.  Keep the exact
  // descriptor so cleanup is symmetric with the other bridge-contract specs.
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const directories: Record<string, Array<{ name: string; path: string; isDirectory: boolean; size: number; mtimeMs: number }>> = {
    '.': [
      { name: 'src', path: 'src', isDirectory: true, size: 0, mtimeMs: 0 },
      { name: 'README.md', path: 'README.md', isDirectory: false, size: 12, mtimeMs: 1 },
      { name: 'node_modules', path: 'node_modules', isDirectory: true, size: 0, mtimeMs: 0 }
    ],
    src: [{ name: 'main.ts', path: 'src/main.ts', isDirectory: false, size: 20, mtimeMs: 2 }]
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    aether: {
      engine: {
        request: async (input: { method: string; path: string; query?: { path?: string } }) => {
          if (input.path !== '/workspace/directory') throw new Error(`unexpected ${input.path}`)
          const key = input.query?.path || '.'
          return { ok: true, code: 200, message: '', data: { root: '/remote/project', entries: directories[key] ?? [] } }
        }
      }
    }
  } })
  publishEngineSource({ mode: 'remote', baseUrl: 'http://engine.test', instanceId: 'fixture', phase: 'ready' })
  publishWorkspaceSelection({ ...DEFAULT_SETTINGS, lastSessionId: 'session-1', remoteWorkspaceRoot: '' }, 'remote:http://engine.test')
  try {
    await expect(listAllFiles('/remote/project')).resolves.toEqual(['README.md', 'src/main.ts'])
  } finally {
    publishEngineSource({ mode: 'embedded', baseUrl: '', instanceId: undefined, phase: 'idle' })
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
