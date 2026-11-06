import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = message => { throw new Error(`[dev-engine] ${message}`) }
function ordinary(file, directory = false) {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail(`路径必须为普通${directory ? '目录' : '文件'}：${file}`)
}
function inside(parent, child) {
  const suffix = relative(parent, child)
  if (!suffix || suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix)) fail('隔离构建目录越界')
}
export function runOwned(binary, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit', windowsHide: true, ...options })
    const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM')
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    const cleanup = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', (code, signal) => { cleanup(); code === 0 ? accept() : reject(new Error(`开发进程未完成（${signal ?? code}）`)) })
  })
}
async function manifestReader(engineRoot) {
  const require = createRequire(join(engineRoot, 'package.json'))
  const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href)
  const { createBuildManifest } = await tsImport(pathToFileURL(join(engineRoot, 'src/runtime/build-identity.ts')).href, import.meta.url)
  return () => createBuildManifest(engineRoot)
}
function validateManifest(value) {
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value.buildId) || value.protocolVersion !== 1 || value.subagentSchemaVersion !== 1
    || typeof value.version !== 'string' || !Array.isArray(value.toolProfiles) || !['general', 'code'].every(profile => value.toolProfiles.includes(profile))) fail('引擎构建清单无效')
  return value
}

/** Each launch owns fresh output. Never overwrite sibling dist or restart an existing engine. */
export async function prepareDevEngine({ root = appRoot, env = process.env, run = runOwned, loadManifest = manifestReader, log = console.log } = {}) {
  if (env.AETHER_IDE_ENGINE_ENTRY) {
    const entryPath = realpathSync(resolve(root, env.AETHER_IDE_ENGINE_ENTRY)); ordinary(entryPath)
    const manifest = validateManifest(JSON.parse(readFileSync(join(dirname(entryPath), 'runtime/build-manifest.json'), 'utf8')))
    log(`[dev-engine] 使用显式引擎入口：${entryPath}\n[dev-engine] ${manifest.buildId}`)
    return { entryPath, manifest, source: 'override', environment: { AETHER_IDE_ENGINE_ENTRY: entryPath } }
  }
  const engineRoot = realpathSync(resolve(root, env.AETHER_ENGINE_SOURCE || '../ai-agent-engine'))
  ordinary(engineRoot, true)
  const readManifest = await loadManifest(engineRoot)
  const before = validateManifest(readManifest())
  // Check the installed native patch without rewriting dependencies used by a live engine.
  const patchScript = join(engineRoot, 'scripts/apply-node-pty-patch.mjs')
  const checkPatch = () => run(process.execPath, [patchScript, '--root', engineRoot, '--check'], { cwd: engineRoot, env, stdio: ['ignore', 'ignore', 'inherit'] })
  await checkPatch()
  const parent = join(engineRoot, '.tmp', 'aether-code-dev')
  for (const directory of [join(engineRoot, '.tmp'), parent]) {
    if (!existsSync(directory)) mkdirSync(directory)
    ordinary(directory, true)
    inside(engineRoot, realpathSync(directory))
  }
  const output = mkdtempSync(join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-`)), dist = join(output, 'dist')
  inside(parent, output)
  log(`[dev-engine] 正在构建当前引擎源码：${before.buildId}`)
  // A copied package boundary keeps NodeNext output ESM; dependency lookup ascends to engineRoot/node_modules.
  copyFileSync(join(engineRoot, 'package.json'), join(output, 'package.json'))
  await run(process.execPath, [join(engineRoot, 'node_modules/typescript/bin/tsc'), '--project', join(engineRoot, 'tsconfig.json'), '--noEmitOnError', '--outDir', dist], { cwd: engineRoot, env })
  for (const name of ['terminal/workspace-shell.mjs', 'workspace/assets/repository-supervisor.exe', 'workspace/assets/repository-supervisor.sha256', 'workspace/assets/repository-supervisor.cs']) {
    const source = join(engineRoot, 'src', name), destination = join(dist, name)
    ordinary(source); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination)
  }
  cpSync(join(engineRoot, 'src/skills/builtin'), join(dist, 'skills/builtin'), { recursive: true, filter: source => {
    if (lstatSync(source).isSymbolicLink()) fail('内置技能资源不能包含链接')
    return true
  } })
  await checkPatch()
  const after = validateManifest(readManifest())
  if (after.buildId !== before.buildId) fail('编译期间引擎源码发生变化；本次不启动。请重新运行 npm run dev。')
  const runtime = join(dist, 'runtime'); mkdirSync(runtime, { recursive: true })
  copyFileSync(join(engineRoot, 'node_modules/node-pty/.aether-node-pty-patch.json'), join(runtime, 'dependency-patches.json'))
  const entryPath = join(dist, 'main.js'); ordinary(entryPath)
  // The authoritative manifest is published last; partial output is never launchable by this command.
  writeFileSync(join(runtime, 'build-manifest.json'), JSON.stringify(after, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(output, 'dev-runtime.json'), JSON.stringify({ sourceRoot: engineRoot, buildId: after.buildId, builtAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' })
  const environment = { AETHER_IDE_ENGINE_ENTRY: entryPath }
  if (!env.SKILLS_ROOT && readdirSync(engineRoot, { withFileTypes: true }).some(entry => entry.name === 'SKILLs' && entry.isDirectory())) environment.SKILLS_ROOT = join(engineRoot, 'SKILLs')
  log(`[dev-engine] 独立引擎已就绪：${entryPath}\n[dev-engine] 本次运行固定使用这份快照。修改引擎后，请等任务结束，再重新运行 npm run dev。`)
  return { entryPath, manifest: after, source: 'built', environment }
}

export async function startDev({ root = appRoot, env = process.env, args = process.argv.slice(2), run = runOwned, prepare = prepareDevEngine } = {}) {
  const runtime = await prepare({ root, env, run })
  if (args.includes('--prepare-only')) return runtime
  const cli = join(root, 'node_modules/electron-vite/bin/electron-vite.js'); ordinary(cli)
  await run(process.execPath, [cli, 'dev', ...args], { cwd: root, env: { ...env, ...runtime.environment } })
  return runtime
}
const invoked = new URL(import.meta.url)
if (!invoked.search && !invoked.hash && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(invoked)) {
  startDev().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
