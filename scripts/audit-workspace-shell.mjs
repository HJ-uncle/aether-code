/**
 * Isolated adversarial audit of the engine's Workspace Shell, never production data.
 * node scripts/audit-workspace-shell.mjs [absolute engine workspace-shell.mjs]
 * Exit 2 means a demonstrated vulnerability; 1 means the harness itself failed.
 * All writes/deletes stay in a newly-created .e2e-tmp/audit-workspace-shell-* tree.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.resolve(process.argv[2] ?? path.join(repo, '../ai-agent-engine/src/terminal/workspace-shell.mjs'))
if (!fs.existsSync(target)) throw new Error(`Workspace Shell not found: ${target}`)
const temp = path.join(repo, '.e2e-tmp')
fs.mkdirSync(temp, { recursive: true })
const fixture = fs.mkdtempSync(path.join(temp, 'audit-workspace-shell-'))
function confined(value) {
  const absolute = path.resolve(value)
  const relative = path.relative(fixture, absolute)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error(`Refusing an audit mutation outside its fixture: ${absolute}`)
  }
  return absolute
}
function write(file, content) { fs.writeFileSync(confined(file), content) }
function mkdir(dir) { fs.mkdirSync(confined(dir), { recursive: true }) }
const baselineEnv = {}
// Only operating-system essentials are inherited. HOME, caches and fake credentials are private.
for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'LD_LIBRARY_PATH']) {
  if (process.env[key]) baselineEnv[key] = process.env[key]
}
baselineEnv.PATH = path.dirname(process.execPath) + path.delimiter + (baselineEnv.PATH ?? '')
const stripAnsi = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
const results = []
const activeChildren = new Set()
function context(id) {
  const dir = path.join(fixture, id)
  const root = path.join(dir, 'workspace')
  const outside = path.join(dir, 'outside')
  const home = path.join(dir, 'home')
  const cache = path.join(dir, 'cache')
  for (const value of [root, outside, home, cache]) mkdir(value)
  const token = 'AUDIT_CANARY_' + randomUUID()
  write(path.join(outside, 'canary.txt'), token)
  write(path.join(root, 'inside.txt'), token)
  const env = { ...baselineEnv, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TEMP: cache, TMP: cache, TMPDIR: cache, npm_config_cache: cache,
    npm_config_userconfig: path.join(home, 'npmrc'), npm_config_globalconfig: path.join(home, 'global-npmrc'),
    WORKSPACE_ROOT: root, WORKSPACE_ROOTS: JSON.stringify([root]),
    DEFAULT_SECURITY_MODE: 'safe', AUDIT_FAKE_ENGINE_TOKEN: token }
  write(path.join(home, 'npmrc'), '')
  write(path.join(home, 'global-npmrc'), '')
  return { dir, root, outside, token, env }
}
async function shell(ctx, input, { timeoutMs = 12000, done } = {}) {
  const child = spawn(process.execPath, [target], { cwd: ctx.root, env: ctx.env, windowsHide: true, stdio: 'pipe' })
  activeChildren.add(child)
  let output = '', error, exitCode = null, exited = false
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', data => { output += data.toString() })
  child.on('error', value => { error = value; exited = true })
  child.on('exit', code => { exitCode = code; exited = true; activeChildren.delete(child) })
  const until = async (predicate, timeout) => {
    const end = Date.now() + timeout
    while (!predicate()) {
      if (exited || Date.now() >= end) return false
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return true
  }
  const ready = await until(() => stripAnsi(output).endsWith('$ '), 6000)
  if (!ready) { child.kill(); throw new Error(`Shell did not become ready: ${error?.message ?? stripAnsi(output).slice(-1000)}`) }
  const offset = output.length
  child.stdin.write(input + '\r')
  const completed = await until(() => {
    const fresh = stripAnsi(output.slice(offset))
    return done ? done(fresh) : fresh.length > input.length && fresh.endsWith('$ ')
  }, timeoutMs)
  if (!exited) {
    child.stdin.end()
    await until(() => exited, 600)
  }
  if (!exited) { child.kill(); await until(() => exited, 1000) }
  return { output: stripAnsi(output.slice(offset)), completed, exitCode, error: error?.message }
}
function record(id, status, description, evidence, run) {
  const result = { id, status, description, evidence,
    ...(run ? { exitCode: run.exitCode, completed: run.completed, outputTail: run.output.slice(-1800) } : {}) }
  results.push(result)
  console.log(`${status.padEnd(10)} ${id}: ${description}`)
}
async function audit(id, description, execute) {
  const ctx = context(id)
  try { await execute(ctx) } catch (error) { record(id, 'error', description, error.message) }
}
const nodeRead = "console.log(require('node:fs').readFileSync('../outside/canary.txt','utf8'))"
const nodeWrite = "require('node:fs').writeFileSync('../outside/changed.txt','audit-write');console.log('AUDIT_WRITE_DONE')"
function scripts(ctx) {
  write(path.join(ctx.root, 'read.cjs'), nodeRead)
  write(path.join(ctx.root, 'write.cjs'), nodeWrite)
}
function readResult(ctx, id, description, run, expectedAllowed = false) {
  const leaked = run.output.includes(ctx.token)
  const status = leaked ? (expectedAllowed ? 'pass' : 'vulnerable') : (run.completed ? 'blocked' : 'error')
  record(id, status, description, { canaryRead: leaked }, run)
}
function writeResult(ctx, id, description, run, file = path.join(ctx.outside, 'changed.txt')) {
  const changed = fs.existsSync(file)
  record(id, changed ? 'vulnerable' : (run.completed ? 'blocked' : 'error'), description, { outsideFixtureFileCreated: changed }, run)
}

await audit('builtin-inside-read', '正常读取工作区文件', async ctx => {
  readResult(ctx, 'builtin-inside-read', '正常读取工作区文件', await shell(ctx, 'cat inside.txt'), true)
})
for (const [id, getInput] of [
  ['builtin-dotdot-read', () => 'cat ../outside/canary.txt'],
  ['builtin-absolute-read', ctx => `cat "${path.join(ctx.outside, 'canary.txt')}"`],
  ['builtin-sibling-prefix', ctx => { const sibling = path.join(ctx.dir, 'workspace-other'); mkdir(sibling); write(path.join(sibling, 'canary.txt'), ctx.token); return 'cat ../workspace-other/canary.txt' }],
]) await audit(id, '内置 cat 路径边界', async ctx => readResult(ctx, id, '内置 cat 路径边界', await shell(ctx, getInput(ctx))))

await audit('node-script-read', 'Node 脚本读取工作区外 canary', async ctx => {
  scripts(ctx); readResult(ctx, 'node-script-read', 'Node 脚本读取工作区外 canary', await shell(ctx, 'node read.cjs'))
})
await audit('node-inline-read', 'Node 单行解释器读取工作区外 canary', async ctx => {
  readResult(ctx, 'node-inline-read', 'Node 单行解释器读取工作区外 canary', await shell(ctx, `node -e "${nodeRead}"`))
})
await audit('node-script-write', 'Node 脚本写入工作区外文件', async ctx => {
  scripts(ctx); writeResult(ctx, 'node-script-write', 'Node 脚本写入工作区外文件', await shell(ctx, 'node write.cjs'))
})
await audit('native-shell-read', '原生系统命令读取工作区外 canary', async ctx => {
  const command = process.platform === 'win32'
    ? `cmd.exe /d /c type "${path.join(ctx.outside, 'canary.txt')}"`
    : '/bin/cat ../outside/canary.txt'
  readResult(ctx, 'native-shell-read', '原生系统命令读取工作区外 canary', await shell(ctx, command))
})
await audit('python-read-write', 'Python 脚本越界读写（未安装则报告 blocked-by-environment）', async ctx => {
  const python = ['python3', 'python'].find(bin => spawnSync(bin, ['--version'], { env: ctx.env, windowsHide: true, timeout: 4000 }).status === 0)
  if (!python) { record('python-read-write', 'unverified', 'Python 不可用，未验证此路径', { blockedByEnvironment: true }); return }
  write(path.join(ctx.root, 'probe.py'), "from pathlib import Path\nprint(Path('../outside/canary.txt').read_text())\nPath('../outside/changed.txt').write_text('audit-write')\n")
  const run = await shell(ctx, `${python} probe.py`)
  record('python-read-write', run.output.includes(ctx.token) || fs.existsSync(path.join(ctx.outside, 'changed.txt')) ? 'vulnerable' : 'blocked', 'Python 脚本越界读写', { canaryRead: run.output.includes(ctx.token), canaryWritten: fs.existsSync(path.join(ctx.outside, 'changed.txt')) }, run)
})
await audit('compound-command-write', '&& 组合命令执行并越界写入', async ctx => {
  scripts(ctx); writeResult(ctx, 'compound-command-write', '&& 组合命令执行并越界写入', await shell(ctx, 'node --version && node write.cjs'))
})
await audit('redirect-outside-write', '输出重定向写入工作区外文件', async ctx => {
  const run = await shell(ctx, 'node --version > ../outside/changed.txt')
  writeResult(ctx, 'redirect-outside-write', '输出重定向写入工作区外文件', run)
})
await audit('pipe-outside-write', '管道执行越界写入脚本', async ctx => {
  scripts(ctx); writeResult(ctx, 'pipe-outside-write', '管道执行越界写入脚本', await shell(ctx, 'node --version | node write.cjs'))
})
await audit('npm-script-write', 'npm 项目脚本越界写入（无安装、无网络）', async ctx => {
  scripts(ctx)
  write(path.join(ctx.root, 'package.json'), JSON.stringify({ name: 'private-sandbox-audit', version: '1.0.0', private: true, scripts: { probe: 'node write.cjs' } }))
  writeResult(ctx, 'npm-script-write', 'npm 项目脚本越界写入（无安装、无网络）', await shell(ctx, 'npm run probe --ignore-scripts', { timeoutMs: 20000 }))
})
await audit('builtin-env-canary', 'env 命令读取假引擎凭据', async ctx => {
  readResult(ctx, 'builtin-env-canary', 'env 命令读取假引擎凭据', await shell(ctx, 'env AUDIT_FAKE_ENGINE_TOKEN'))
})
await audit('child-env-canary', '子进程继承假引擎凭据', async ctx => {
  write(path.join(ctx.root, 'env.cjs'), 'console.log(process.env.AUDIT_FAKE_ENGINE_TOKEN)')
  readResult(ctx, 'child-env-canary', '子进程继承假引擎凭据', await shell(ctx, 'node env.cjs'))
})

for (const action of ['cat', 'touch', 'mkdir', 'cp', 'rm']) {
  const id = `junction-${action}`
  await audit(id, `目录链接下的内置 ${action} 越界`, async ctx => {
    const link = confined(path.join(ctx.root, 'linked'))
    try { fs.symlinkSync(confined(ctx.outside), link, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
      record(id, 'unverified', '环境不允许建立目录链接，未验证', { blockedByEnvironment: true, message: error.message }); return
    }
    const input = { cat: 'cat linked/canary.txt', touch: 'touch linked/changed.txt', mkdir: 'mkdir linked/changed.txt', cp: 'cp inside.txt linked/changed.txt', rm: 'rm linked/canary.txt' }[action]
    const run = await shell(ctx, input)
    if (action === 'cat') readResult(ctx, id, '内置 cat 通过目录链接读取工作区外 canary', run)
    else if (action === 'rm') record(id, fs.existsSync(path.join(ctx.outside, 'canary.txt')) ? 'blocked' : 'vulnerable', '内置 rm 通过目录链接删除工作区外 canary', { outsideCanaryDeleted: !fs.existsSync(path.join(ctx.outside, 'canary.txt')) }, run)
    else writeResult(ctx, id, `内置 ${action} 通过目录链接写入工作区外路径`, run)
  })
}
await audit('root-delete', '删除当前工作区根目录（仅一次性夹具）', async ctx => {
  // Both the lexical and physical target must be inside this newly-created audit tree.
  confined(ctx.root); confined(fs.realpathSync(ctx.root))
  const run = await shell(ctx, 'rm -rf .')
  const deleted = !fs.existsSync(ctx.root)
  record('root-delete', deleted ? 'vulnerable' : 'unverified', '工作区根目录删除探测；OS 拒绝不等于产品提供保护', { workspaceDeleted: deleted, insideFileStillExists: fs.existsSync(path.join(ctx.root, 'inside.txt')) }, run)
})
await audit('loopback-canary-transfer', '仅向 127.0.0.1 测试监听器发送假凭据', async ctx => {
  let received = ''
  const server = http.createServer(async (request, response) => {
    for await (const part of request) received += part.toString()
    response.end('audit-ok')
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    write(path.join(ctx.root, 'network.cjs'), `const http=require('node:http');const req=http.request({host:'127.0.0.1',port:${port},path:'/audit',method:'POST'},r=>{r.resume();r.on('end',()=>console.log('AUDIT_NETWORK_DONE'))});req.on('error',()=>process.exitCode=1);req.end(process.env.AUDIT_FAKE_ENGINE_TOKEN)`)
    const run = await shell(ctx, 'node network.cjs')
    record('loopback-canary-transfer', received === ctx.token ? 'vulnerable' : (run.completed ? 'blocked' : 'error'), '子进程可绕过引擎网络策略向 loopback 发送假凭据', { receivedCanary: received === ctx.token, destination: '127.0.0.1 only' }, run)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
await audit('invalid-regex', '畸形 grep 正则不应使终端进程退出', async ctx => {
  const run = await shell(ctx, 'grep [ inside.txt')
  record('invalid-regex', run.exitCode !== 0 && run.exitCode !== null ? 'vulnerable' : (run.completed ? 'pass' : 'error'), '未捕获正则构造异常导致终端退出', { unexpectedExit: run.exitCode !== 0 && run.exitCode !== null }, run)
})
await audit('concurrent-lines', '连续粘贴的命令是否保持顺序', async ctx => {
  write(path.join(ctx.root, 'slow.cjs'), "setTimeout(()=>{require('node:fs').writeFileSync('finished.txt','done');console.log('AUDIT_SLOW_DONE')},350)")
  write(path.join(ctx.root, 'check.cjs'), "console.log(require('node:fs').existsSync('finished.txt')?'AUDIT_ORDER_OK':'AUDIT_ORDER_RACE')")
  const run = await shell(ctx, 'node slow.cjs\rnode check.cjs', { done: output => output.includes('AUDIT_SLOW_DONE') && /AUDIT_ORDER_(OK|RACE)/.test(output) })
  record('concurrent-lines', run.output.includes('AUDIT_ORDER_RACE') ? 'vulnerable' : (run.output.includes('AUDIT_ORDER_OK') ? 'pass' : 'error'), 'readline 异步 line 回调存在命令并发、currentChild 覆盖风险', { orderRace: run.output.includes('AUDIT_ORDER_RACE') }, run)
})

for (const child of activeChildren) child.kill()
const counts = Object.fromEntries(['vulnerable', 'blocked', 'pass', 'unverified', 'error'].map(status => [status, results.filter(result => result.status === status).length]))
const report = { target, fixture, platform: process.platform, nodeVersion: process.version, generatedAt: new Date().toISOString(),
  scope: 'Fresh isolated fixtures only; synthetic credential; loopback only; no production APIs or credentials.',
  caveat: 'blockedByEnvironment is not a security pass. Root deletion and concurrency are robustness risks, distinct from an isolation escape.', counts, results }
write(path.join(fixture, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: path.join(fixture, 'report.json'), counts }, null, 2))
process.exitCode = counts.error ? 1 : counts.vulnerable ? 2 : 0
