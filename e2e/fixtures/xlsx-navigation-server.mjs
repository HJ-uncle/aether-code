// New isolated source harness for real Chromium XLSX region/navigation metadata.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = path.join(root, '.e2e-tmp/xlsx-navigation-fixture')
await fs.mkdir(fixture, { recursive: true })
await fs.writeFile(path.join(fixture, 'index.html'), '<!doctype html><html data-platform="other" data-appearance="light" data-accent="blue"><head><meta charset="UTF-8"></head><body><script type="module" src="./main.ts"></script></body></html>')
await fs.writeFile(path.join(fixture, 'main.ts'), `
import '/src/renderer/src/assets/app.css'
import { renderXlsxDocument } from '/src/renderer/src/core/workbench/render-xlsx'
window.renderNavigation = async data => renderXlsxDocument(Uint8Array.from(data).buffer, new AbortController().signal)
document.documentElement.dataset.ready = 'true'
`)
const server = await createServer({ root, configFile: false, plugins: [react()],
  cacheDir: path.join(root, '.e2e-tmp/xlsx-navigation-vite'),
  resolve: { alias: { '@renderer': path.join(root, 'src/renderer/src') } },
  optimizeDeps: { entries: [path.join(fixture, 'main.ts')] },
  server: { host: '127.0.0.1', port: 14631, strictPort: true, watch: { ignored: ['**/.e2e-tmp/**'] } }, logLevel: 'error' })
await server.listen()
const close = async () => { await server.close(); process.exit(0) }
process.on('SIGTERM', close); process.on('SIGINT', close)
