import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineRoot = realpathSync(resolve(process.env.AETHER_ENGINE_SOURCE || join(appRoot, '..', 'ai-agent-engine')))
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
const lock = json(join(engineRoot, 'package-lock.json'))
if (lock.lockfileVersion < 2 || !lock.packages) fail('A package-lock v2/v3 and installed dependencies are required')
const manifestFile = join(engineRoot, 'dist', 'runtime', 'build-manifest.json')
const manifest = json(manifestFile)
if (!/^sha256:[a-f0-9]{64}$/.test(manifest.buildId || '') || manifest.protocolVersion !== 1) fail('Invalid engine build manifest')
const { createBuildManifest } = await import(pathToFileURL(join(engineRoot, 'dist/runtime/build-identity.js')).href)
if (createBuildManifest(engineRoot).buildId !== manifest.buildId) fail('Engine source changed since its build. Build the engine before staging')
const nodeInfo = JSON.parse(run(nodeSource, ['-p', 'JSON.stringify({node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch,electron:process.versions.electron})']))
if (nodeInfo.platform !== 'win32' || nodeInfo.arch !== 'x64' || nodeInfo.electron || Number(nodeInfo.node.split('.')[0]) < 22) fail('A standalone Windows x64 Node >=22 is required')

// Only this generated directory may be replaced. Realpath containment is checked before deletion.
if (existsSync(target)) { assertChild(realpathSync(stageParent), realpathSync(target)); rmSync(target, { recursive: true, force: true }) }
mkdirSync(target, { recursive: true })
copyTree(join(engineRoot, 'dist'), join(target, 'dist'), (file, rel) =>
  !rel.split(sep).includes('__tests__') && !/\.(?:test|spec)\./.test(rel) && !/\.map$|\.d\.ts$/.test(rel))
copyFile(join(engineRoot, 'src/terminal/workspace-shell.mjs'), join(target, 'dist/terminal/workspace-shell.mjs'))

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
for (const [packagePath, locked] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!packagePath || locked.dev) continue
  if (locked.link) fail(`linked dependency is not reproducible: ${packagePath}`)
  copyPackage(engineRoot, packagePath, locked)
}
// codegraph's Windows bundle carries its own production dependencies inside lib/node_modules;
// they are deliberately absent from the root lockfile and must travel with that native package.
const codegraphBundleDeps = join(engineRoot, 'node_modules/@colbymchenry/codegraph-win32-x64/lib/node_modules')
if (existsSync(codegraphBundleDeps)) {
  copyTree(codegraphBundleDeps, join(target, 'node_modules/@colbymchenry/codegraph-win32-x64/lib/node_modules'))
}
// TS is needed by engine diagnostics; the IDE's language-server distribution is self-contained.
copyPackage(engineRoot, 'node_modules/typescript', lock.packages['node_modules/typescript'])
const ideLock = json(join(appRoot, 'package-lock.json'))
copyPackage(appRoot, 'node_modules/typescript-language-server', ideLock.packages['node_modules/typescript-language-server'])
const runtimeDependencies = Object.fromEntries(Object.keys(pkg.dependencies).map(name => [name, json(join(target, 'node_modules', name, 'package.json')).version]))
runtimeDependencies.typescript = json(join(target, 'node_modules/typescript/package.json')).version
runtimeDependencies['typescript-language-server'] = json(join(target, 'node_modules/typescript-language-server/package.json')).version
writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true, dependencies: runtimeDependencies }, null, 2) + '\n')

const trackedSkills = run('git', ['-C', engineRoot, 'ls-files', '-z', '--', '.aether/skills']).split('\0').filter(Boolean)
if (!trackedSkills.some(file => file.endsWith('/SKILL.md'))) fail('No tracked bundled skills found')
for (const file of trackedSkills) copyFile(join(engineRoot, file), join(target, 'SKILLs', relative('.aether/skills', file)))
copyFile(nodeSource, join(target, 'runtime/node.exe'))
// Preserve the official Node and component notices when supplied by the distribution.
const license = process.env.AETHER_NODE_LICENSE || [join(dirname(nodeSource), 'LICENSE'), join(appRoot, 'build', 'node-LICENSE')].find(existsSync)
if (!license) fail('Node LICENSE missing; provide AETHER_NODE_LICENSE or build/node-LICENSE from the exact Node release')
copyFile(license, join(target, 'runtime/LICENSE'))
copyFile(join(appRoot, 'scripts', 'verify-engine-runtime.mjs'), join(target, 'verify-runtime.mjs'))

const files = []
function stableStat(file) {
  let last
  for (let attempt = 0; attempt < 20; attempt++) {
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
  engineVersion: manifest.version, node: nodeInfo, lockSha256: sha256(join(engineRoot, 'package-lock.json')),
  dependencies, skillCount: trackedSkills.filter(file => file.endsWith('/SKILL.md')).length, files }, null, 2) + '\n')
console.log(run(join(target, 'runtime/node.exe'), [join(target, 'verify-runtime.mjs')], { cwd: target,
  env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: join(target, 'runtime') } }))
console.log(JSON.stringify({ target, buildId: manifest.buildId, packages: dependencies.length, files: files.length,
  bytes: files.reduce((total, item) => total + item.bytes, 0), node: nodeInfo }))
