import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { build, project, destination } from './build.mjs'

build()
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? 4177 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535')
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }
const server = createServer((request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const filename = path.resolve(destination, relative)
    if (!filename.startsWith(destination + path.sep) || relative.split(/[\\/]/).some(part => part.startsWith('.')) || !types[path.extname(filename)] || !fs.existsSync(filename) || fs.lstatSync(filename).isSymbolicLink() || !fs.statSync(filename).isFile()) { response.writeHead(404).end('Not found'); return }
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(request.method === 'HEAD' ? undefined : fs.readFileSync(filename))
  } catch { response.writeHead(400).end('Bad request') }
})
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`))
const watchers = []
let timer
if (process.argv.includes('--watch')) {
  for (const target of ['content', 'assets', 'template.html']) watchers.push(fs.watch(path.join(project, target), () => {
    clearTimeout(timer)
    timer = setTimeout(() => { try { build() } catch (error) { console.error(error.message) } }, 120)
  }))
  console.log('正在监听 HTML、样式与脚本；修改后刷新浏览器。导航配置变更后重新启动。')
}
function close() { clearTimeout(timer); watchers.forEach(watcher => watcher.close()); server.close() }
process.on('SIGINT', close)
process.on('SIGTERM', close)
