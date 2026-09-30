import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactPath = process.env.AETHER_ENGINE_TGZ ? realpathSync(resolve(process.env.AETHER_ENGINE_TGZ)) : ''
if (artifactPath && process.env.AETHER_ENGINE_SOURCE) throw new Error('[engine-runtime] AETHER_ENGINE_TGZ 与 AETHER_ENGINE_SOURCE 不能同时设置')
let extractedArtifactRoot = ''
let engineRoot
if (artifactPath) {
  if (!existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) throw new Error(`[engine-runtime] 引擎 tgz 不存在：${artifactPath}`)
  extractedArtifactRoot = mkdtempSync(join(tmpdir(), 'aether-engine-artifact-'))
  // The release is an npm-style archive. Validate its member names before
  // extracting so a malformed artifact cannot write outside the temp directory.
  const entries = run('tar', ['-tzf', artifactPath], { maxBuffer: 128 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean)
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (!normalized.startsWith('package/') || normalized.split('/').some(part => part === '..') || isAbsolute(normalized)) {
      throw new Error(`[engine-runtime] 引擎 tgz 包含不安全路径：${entry}`)
    }
  }
  run('tar', ['-xzf', artifactPath, '-C', extractedArtifactRoot])
  engineRoot = realpathSync(join(extractedArtifactRoot, 'package'))
  process.on('exit', () => { try { rmSync(extractedArtifactRoot, { recursive: true, force: true }) } catch {} })
} else {
  engineRoot = realpathSync(resolve(process.env.AETHER_ENGINE_SOURCE || join(appRoot, '..', 'ai-agent-engine')))
}
const stageParent = resolve(appRoot, 'resources', 'engine')
const target = join(stageParent, 'win32-x64')
const nodeSource = realpathSync(process.env.AETHER_NODE_BINARY || process.execPath)
const fail = message => { throw new Error(`[engine-runtime] ${message}`) }
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const sha256 = file => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
function assertChild(parent, child) {
  const suffix = relative(parent, child)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) fail(`unsafe output path: ${child}`)
}
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${binary} failed (${result.status}): ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}
function copyFile(source, destination) {
  if (lstatSync(source).isSymbolicLink()) fail(`symlinks are not packaged: ${source}`)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
}
function copyTree(source, destination, keep = () => true) {
  cpSync(source, destination, { recursive: true, filter(file) {
    const rel = relative(source, file)
    if (lstatSync(file).isSymbolicLink()) fail(`symlinks are not packaged: ${file}`)
    if (rel.split(sep).some(part => part === '.git' || part === '.env' || part.startsWith('.env.'))) return false
    return keep(file, rel)
  } })
}
function platformAllows(values, current) {
  if (!values?.length) return true
  return !values.includes(`!${current}`) && (values.every(value => value.startsWith('!')) || values.includes(current))
}

if (process.platform !== 'win32' || process.arch !== 'x64') fail('Run this Windows x64 preparation on Windows x64')
assertChild(stageParent, target)
for (const directory of [join(appRoot, '.e2e-tmp'), dirname(stageParent), stageParent, target]) {
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) fail(`staging path is a link: ${directory}`)
}
const pkg = json(join(engineRoot, 'package.json'))
const lockPath = join(engineRoot, 'package-lock.json')
const lock = artifactPath ? null : json(lockPath)
if (lock && (lock.lockfileVersion < 2 || !lock.packages)) fail('A package-lock v2/v3 and installed dependencies are required')
const manifestFile = join(engineRoot, 'dist', 'runtime', 'build-manifest.json')
const manifest = json(manifestFile)
if (!/^sha256:[a-f0-9]{64}$/.test(manifest.buildId || '') || manifest.protocolVersion !== 1) fail('Invalid engine build manifest')
if (!artifactPath) {
  const { createBuildManifest } = await import(pathToFileURL(join(engineRoot, 'dist/runtime/build-identity.js')).href)
  if (createBuildManifest(engineRoot).buildId !== manifest.buildId) fail('Engine source changed since its build. Build the engine before staging')
}
const nodeInfo = JSON.parse(run(nodeSource, ['-p', 'JSON.stringify({node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch,electron:process.versions.electron})']))
if (nodeInfo.platform !== 'win32' || nodeInfo.arch !== 'x64' || nodeInfo.electron || Number(nodeInfo.node.split('.')[0]) < 22) fail('A standalone Windows x64 Node >=22 is required')

// Only this generated directory may be replaced. Realpath containment is checked before deletion.
if (existsSync(target)) { assertChild(realpathSync(stageParent), realpathSync(target)); rmSync(target, { recursive: true, force: true }) }
mkdirSync(target, { recursive: true })
copyTree(join(engineRoot, 'dist'), join(target, 'dist'), (file, rel) =>
  !rel.split(sep).includes('__tests__') && !/\.(?:test|spec)\./.test(rel) && !/\.map$|\.d\.ts$/.test(rel))
if (!artifactPath) copyFile(join(engineRoot, 'src/terminal/workspace-shell.mjs'), join(target, 'dist/terminal/workspace-shell.mjs'))

const dependencies = []
function copyPackage(sourceRoot, packagePath, locked) {
  if (!packagePath.startsWith('node_modules/') || packagePath.split('/').includes('..')) fail(`invalid locked package path ${packagePath}`)
  const source = join(sourceRoot, packagePath)
  if (!platformAllows(locked.os, 'win32') || !platformAllows(locked.cpu, 'x64')) return
  if (!existsSync(join(source, 'package.json'))) {
    if (locked.optional) return
    fail(`required installed package missing: ${packagePath}`)
  }
  const installed = json(join(source, 'package.json'))
  if (installed.version !== locked.version) fail(`installed version differs from lock: ${packagePath}`)
  const destination = join(target, packagePath)
  copyTree(source, destination, (_file, rel) => !rel.split(sep).includes('node_modules'))
  dependencies.push({ path: packagePath.replaceAll('\\', '/'), name: installed.name, version: installed.version,
    integrity: locked.integrity, license: installed.license })
}
if (artifactPath) {
  const bundledDependencies = join(engineRoot, 'node_modules')
  if (!existsSync(bundledDependencies)) fail('引擎 tgz 缺少 node_modules')
  copyTree(bundledDependencies, join(target, 'node_modules'))
} else {
  for (const [packagePath, locked] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!packagePath || locked.dev) continue
    if (locked.link) fail(`linked dependency is not reproducible: ${packagePath}`)
    copyPackage(engineRoot, packagePath, locked)
  }
}
// codegraph's Windows bundle carries its own production dependencies inside lib/node_modules;
// they are deliberately absent from the root lockfile and must travel with that native package.
const codegraphBundleDeps = join(engineRoot, 'node_modules/@colbymchenry/codegraph-win32-x64/lib/node_modules')
if (existsSync(codegraphBundleDeps)) {
  copyTree(codegraphBundleDeps, join(target, 'node_modules/@colbymchenry/codegraph-win32-x64/lib/node_modules'))
}
// TS is needed by engine diagnostics; the IDE's language-server distribution is self-contained.
if (!artifactPath) copyPackage(engineRoot, 'node_modules/typescript', lock.packages['node_modules/typescript'])
const ideLock = json(join(appRoot, 'package-lock.json'))
copyPackage(appRoot, 'node_modules/typescript-language-server', ideLock.packages['node_modules/typescript-language-server'])
const runtimeDependencies = Object.fromEntries(Object.keys(pkg.dependencies ?? {}).map(name => [name, json(join(target, 'node_modules', name, 'package.json')).version]))
runtimeDependencies.typescript = json(join(target, 'node_modules/typescript/package.json')).version
runtimeDependencies['typescript-language-server'] = json(join(target, 'node_modules/typescript-language-server/package.json')).version
writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true, dependencies: runtimeDependencies }, null, 2) + '\n')

const trackedSkills = artifactPath
  ? readdirSync(join(engineRoot, 'SKILLs'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name === 'SKILL.md').map(entry => entry.name)
  : run('git', ['-C', engineRoot, 'ls-files', '-z', '--', '.aether/skills']).split('\0').filter(Boolean)
if (!trackedSkills.some(file => file.endsWith('SKILL.md'))) fail('No bundled skills found')
if (artifactPath) copyTree(join(engineRoot, 'SKILLs'), join(target, 'SKILLs'))
else for (const file of trackedSkills) copyFile(join(engineRoot, file), join(target, 'SKILLs', relative('.aether/skills', file)))
copyFile(nodeSource, join(target, 'runtime/node.exe'))
// Preserve the official Node and component notices when supplied by the distribution.
const license = process.env.AETHER_NODE_LICENSE || [join(dirname(nodeSource), 'LICENSE'), join(appRoot, 'build', 'node-LICENSE')].find(existsSync)
if (!license) fail('Node LICENSE missing; provide AETHER_NODE_LICENSE or build/node-LICENSE from the exact Node release')
copyFile(license, join(target, 'runtime/LICENSE'))
copyFile(join(appRoot, 'scripts', 'verify-engine-runtime.mjs'), join(target, 'verify-runtime.mjs'))

const files = []
function stableStat(file) {
  let last
  // Large archives can still be materializing through Windows filesystem
  // filters after cpSync returns; allow the final inventory to settle.
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return lstatSync(file) } catch (error) { last = error; if (error?.code !== 'ENOENT') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50) }
  }
  throw last
}
function inventory(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(directory, item.name)
    if (item.isDirectory()) inventory(full)
    else { const stat = stableStat(full); files.push({ path: relative(target, full).replaceAll('\\', '/'), bytes: stat.size, sha256: sha256(full) }) }
  }
}
inventory(target)
writeFileSync(join(target, 'stage-manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'win32-x64', buildId: manifest.buildId,
  engineVersion: manifest.version, node: nodeInfo, lockSha256: sha256(artifactPath || lockPath),
  dependencies, skillCount: trackedSkills.filter(file => file.endsWith('SKILL.md')).length, files }, null, 2) + '\n')
console.log(run(join(target, 'runtime/node.exe'), [join(target, 'verify-runtime.mjs')], { cwd: target,
  env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: join(target, 'runtime') } }))
console.log(JSON.stringify({ target, buildId: manifest.buildId, packages: dependencies.length, files: files.length,
  bytes: files.reduce((total, item) => total + item.bytes, 0), node: nodeInfo }))
