// Isolated source-module harness; never starts the application or a model.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = path.join(root, '.e2e-tmp/office-xlsx-render-fixture')
await fs.mkdir(fixture, { recursive: true })
await fs.writeFile(path.join(fixture, 'index.html'), '<!doctype html><html data-platform="other" data-appearance="light" data-accent="blue"><head><meta charset="UTF-8"></head><body><script type="module" src="./main.ts"></script></body></html>')
await fs.writeFile(path.join(fixture, 'main.ts'), `
import '/src/renderer/src/assets/app.css'
import { renderXlsxPages } from '/src/renderer/src/core/workbench/render-xlsx'
window.renderXlsxTest = async (data, options = {}) => {
  const controller = new AbortController()
  if (options.abort) controller.abort()
  const timer = options.abortAfter === undefined ? undefined : setTimeout(() => controller.abort(), options.abortAfter)
  try { return { pages: await renderXlsxPages(Uint8Array.from(data).buffer, controller.signal) } }
  catch (error) { return { error: String(error) } }
  finally { clearTimeout(timer) }
}
document.documentElement.dataset.ready = 'true'
`)
const server = await createServer({ root, configFile: false, plugins: [react()],
  cacheDir: path.join(root, '.e2e-tmp/office-xlsx-render-vite'),
  resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src') } },
  optimizeDeps: { entries: [path.join(fixture, 'main.ts')] },
  // Electron locks its private profile files on Windows; they are not source modules.
  server: { host: '127.0.0.1', port: 14622, strictPort: true, watch: { ignored: ['**/.e2e-tmp/**'] } }, logLevel: 'error' })
await server.listen()
const close = async () => { await server.close(); process.exit(0) }
process.on('SIGTERM', close); process.on('SIGINT', close)
