import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { buildSync } from 'esbuild'

/** A single self-contained worker asset avoids unpinned shared chunk imports.
 * The runtime descriptor is compiled into main, rather than trusted from a
 * writable sidecar manifest at startup. */
function queueWorkerBundle() {
  const built = buildSync({ entryPoints: [resolve('src/main/next-turn-queue-sqlite-worker-entry.ts')], bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, outfile: 'queue-storage-worker.cjs' })
  const source = built.outputFiles[0].contents
  const sha256 = createHash('sha256').update(source).digest('hex')
  const virtualId = '\0virtual:aether-queue-worker'
  return { name: 'aether-queue-worker-bundle',
    resolveId(id: string) { return id === 'virtual:aether-queue-worker' ? virtualId : undefined },
    load(id: string) { return id === virtualId ? `export const BUNDLED_QUEUE_WORKER = Object.freeze(${JSON.stringify({ relativePath: 'queue-storage-worker.cjs', sha256 })});` : undefined },
    generateBundle(this: import('rollup').PluginContext) {
      this.emitFile({ type: 'asset' as const, fileName: 'queue-storage-worker.cjs', source })
      this.emitFile({ type: 'asset' as const, fileName: 'queue-storage-worker-build.json', source: JSON.stringify({ schemaVersion: 1, relativePath: 'queue-storage-worker.cjs', sha256, selfContained: true }) + '\n' })
    }
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    // 主进程只有 electron 与 Node 内置模块保持外部化
    plugins: [externalizeDepsPlugin(), queueWorkerBundle()]
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    server: {
      port: 5180,
      strictPort: true
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
