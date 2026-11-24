// Installer inputs are content-pinned. The first preparation can download them; users never need network access to run Python, Node or Git.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(new URL('windows-toolchains.lock.json', import.meta.url), 'utf8'))
const scratch = join(root, '.e2e-tmp', 'toolchains')
const archives = join(scratch, 'downloads')

// Staging/cleanup is confined to real directories owned by this checkout, including when a parent path has been replaced with a junction.
function ownedPath(path) {
  const rel = relative(root, path)
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error(`Unexpected staging path: ${path}`)
  let next = root
  for (const segment of rel.split(sep)) {
    next = join(next, segment)
    if (existsSync(next) && lstatSync(next).isSymbolicLink()) throw new Error(`Linked staging path: ${next}`)
  }
  return path
}
function ownedDir(path) {
  mkdirSync(ownedPath(path), { recursive: true })
  return path
}
function removeOwned(path) {
  if (existsSync(ownedPath(path))) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
function run(file, args, options = {}) {
  const p = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options })
  if (p.error) throw p.error
  if (p.status !== 0) throw new Error(`${basename(file)} failed (${p.status}): ${(p.stderr || p.stdout).slice(-2000)}`)
  return p.stdout.trim()
}
async function artifact(spec, override) {
  const filename = decodeURIComponent(basename(new URL(spec.url).pathname))
  const path = override ? realpathSync(resolve(override)) : ownedPath(join(ownedDir(archives), filename))
  let data
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).size !== spec.bytes) throw new Error(`Unexpected archive size: ${path}`)
    data = readFileSync(path)
  } else {
    console.log(`[toolchains] Downloading ${filename}`)
    const res = await fetch(spec.url, { signal: AbortSignal.timeout(180_000) })
    if (!res.ok || !res.url.startsWith('https://')) throw new Error(`[toolchains] Download failed: ${res.status} (${spec.url})`)
    data = Buffer.from(await res.arrayBuffer())
  }
  if (data.length !== spec.bytes || createHash('sha256').update(data).digest('hex') !== spec.sha256) {
    throw new Error(`[toolchains] Archive does not match the release lock: ${path}`)
  }
  // Do not cache a partial or corrupt download and do not overwrite an operator's offline archive.
  if (!override && !existsSync(path)) writeFileSync(path, data, { flag: 'wx' })
  return path
}

// `tar.exe` is the Windows libarchive executable. Never run archive-supplied scripts or fetch packages during installation.
export async function prepareWindowsToolchains() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows toolchain preparation requires Windows x64')
  const [nodeArchive, pythonArchive, gitArchive] = await Promise.all([
    artifact(lock.node, process.env.AETHER_NODE_ARCHIVE), artifact(lock.python, process.env.AETHER_PYTHON_ARCHIVE),
    artifact(lock.git, process.env.AETHER_GIT_ARCHIVE)
  ])
  const work = mkdtempSync(join(ownedDir(scratch), 'stage-'))
  const nodeDir = join(work, 'node')
  const appTools = join(work, 'toolchains')
  const pythonDir = join(appTools, 'python'), gitDir = join(appTools, 'git')
  const toolsTarget = join(root, 'resources', 'toolchains', 'win32-x64')
  try {
    ownedDir(nodeDir)
    ownedDir(pythonDir)
    ownedDir(gitDir)
    const tar = join(process.env.SystemRoot, 'System32', 'tar.exe')
    // MinGit is a relocatable distribution. Keep the official ZIP intact, including transport helpers, licenses and component versions.
    run(tar, ['-xf', gitArchive, '-C', gitDir])
    if (run(join(gitDir, 'cmd', 'git.exe'), ['--version']) !== `git version ${lock.git.version}`) throw new Error('Unexpected Git for Windows version')
    const nodeTop = `node-v${lock.node.version}-win-x64`
    // Omitting the .ps1 shims lets npm/npx run under PowerShell's Restricted execution policy. Git Bash still needs the extensionless shims.
    run(tar, ['-xf', nodeArchive, '-C', nodeDir, '--strip-components', '1',
      ...['node.exe', 'LICENSE', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'node_modules/npm'].map(name => `${nodeTop}/${name}`)])
    // The full upstream build includes the component notices. Keep the relocatable install tree and notices; omit only debug symbols.
    run(tar, ['-xf', pythonArchive, '-C', pythonDir, '--strip-components', '2', '--exclude', '*.pdb', 'python/install'])
    run(tar, ['-xf', pythonArchive, '-C', pythonDir, '--strip-components', '1', 'python/licenses'])
    // Many portable skill scripts use python3; the Windows distribution only names its launcher python.exe.
    copyFileSync(join(pythonDir, 'python.exe'), join(pythonDir, 'python3.exe'))
    // Standalone CPython includes pip and ensurepip but no relocatable pip.exe. Resolve the interpreter relative to the shim, even in a path with spaces.
    writeFileSync(join(pythonDir, 'pip.cmd'), '@echo off\r\n"%~dp0python.exe" -m pip %*\r\n')
    const packageJson = JSON.parse(readFileSync(join(nodeDir, 'node_modules/npm/package.json'), 'utf8'))
    if (packageJson.version !== lock.node.npm || !existsSync(join(nodeDir, 'node_modules/npm/LICENSE'))) throw new Error('Invalid bundled npm package')
    if (!existsSync(join(pythonDir, 'licenses/LICENSE.openssl-3.txt')) || !existsSync(join(pythonDir, 'LICENSE.txt'))) throw new Error('Incomplete Python notices')
    if (run(join(nodeDir, 'node.exe'), ['-p', 'process.version']) !== `v${lock.node.version}` ||
        run(join(pythonDir, 'python.exe'), ['-IB', '-c', 'import platform; print(platform.python_version())']) !== lock.python.version) throw new Error('Unexpected runtime version')
    if (process.env.AETHER_NODE_BINARY && !readFileSync(realpathSync(resolve(process.env.AETHER_NODE_BINARY))).equals(readFileSync(join(nodeDir, 'node.exe')))) {
      throw new Error(`AETHER_NODE_BINARY must match the locked Windows Node ${lock.node.version}; use AETHER_NODE_ARCHIVE for an offline build`)
    }
    writeFileSync(join(appTools, 'toolchains.json'), JSON.stringify({ platform: 'win32-x64', ...lock }, null, 2) + '\n')
    // Node belongs to the paired engine; Python and Git remain available when a user switches engine versions.
    ownedDir(dirname(toolsTarget))
    removeOwned(toolsTarget)
    renameSync(appTools, toolsTarget)
    return { nodeDir, nodeBinary: join(nodeDir, 'node.exe'), pythonDir: join(toolsTarget, 'python'), gitDir: join(toolsTarget, 'git'), cleanup() { removeOwned(work) } }
  } catch (error) {
    removeOwned(work)
    throw error
  }
}
