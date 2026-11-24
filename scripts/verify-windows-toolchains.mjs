import { Arch } from 'electron-builder'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const lock = JSON.parse(readFileSync(new URL('windows-toolchains.lock.json', import.meta.url), 'utf8'))
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Only staged tools + Windows itself are on PATH. All caches, npm prefix, HOME and venv go under the probe, never the developer's profile.
export function verifyWindowsToolchains(nodeDir, pythonDir, scratch) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This check requires Windows x64')
  for (const path of [join(root, '.e2e-tmp'), scratch]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Linked probe directory: ${path}`)
    mkdirSync(path, { recursive: true })
  }
  const parent = realpathSync(scratch)
  const probe = mkdtempSync(join(parent, 'offline smoke '))
  const gitRoot = join(dirname(pythonDir), 'git'), gitCmd = join(gitRoot, 'cmd'), git = join(gitCmd, 'git.exe')
  const sysroot = process.env.SystemRoot
  const env = { SystemRoot: sysroot, WINDIR: sysroot, ComSpec: join(sysroot, 'System32', 'cmd.exe'),
    Path: [nodeDir, pythonDir, gitCmd, join(sysroot, 'System32')].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    HOME: probe, USERPROFILE: probe, APPDATA: probe, LOCALAPPDATA: probe, TEMP: probe, TMP: probe,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ALLOW_PROTOCOL: 'file',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PIP_CONFIG_FILE: 'NUL', PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1',
    NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_CACHE: join(probe, 'npm-cache'), NPM_CONFIG_PREFIX: join(probe, 'npm-prefix'), NPM_CONFIG_UPDATE_NOTIFIER: 'false' }
  function run(file, args) {
    const p = spawnSync(file, args, { cwd: probe, env, windowsHide: true, encoding: 'utf8', timeout: 90_000 })
    if (p.error) throw p.error
    if (p.status !== 0) throw new Error(`[offline toolchains] ${basename(file)}: ${(p.stderr || p.stdout).slice(-2000)}`)
    return p.stdout.trim()
  }
  function contains(actual, expected, what) {
    if (!actual.includes(expected)) throw new Error(`[offline toolchains] Unexpected ${what}: ${actual}`)
  }
  try {
    writeFileSync(join(probe, 'local.js'), 'console.log("aether-node:" + process.versions.node)')
    writeFileSync(join(probe, 'local.py'), 'import sqlite3, ssl, sys\nprint("aether-python:" + sys.version.split()[0])\n')
    contains(run(join(nodeDir, 'node.exe'), ['local.js']), `aether-node:${lock.node.version}`, 'Node script')
    for (const exe of ['python.exe', 'python3.exe']) contains(run(join(pythonDir, exe), ['-IB', 'local.py']), `aether-python:${lock.python.version}`, exe)
    // In particular, PowerShell must resolve the .cmd shims even with script execution restricted, and must not invoke system Node or a global npm.
    const powershell = join(sysroot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const commands = `foreach ($name in @('npm','npx','pip','git')) { $cmd = Get-Command $name -ErrorAction Stop | Select-Object -First 1; $output = & $name --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Write-Output ($cmd.Source + '|' + $output) }`
    const output = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', commands]).toLowerCase()
    for (const name of ['npm', 'npx']) contains(output, `${join(nodeDir, `${name}.cmd`)}|${lock.node.npm}`.toLowerCase(), name)
    contains(output, `${join(pythonDir, 'pip.cmd')}|pip `.toLowerCase(), 'pip shim')
    contains(output, (git + '|git version ' + lock.git.version).toLowerCase(), 'Git launcher')
    // A CLI version alone does not exercise the helpers, templates or file transport of a relocated MinGit.
    for (const name of ['LICENSE.txt', 'etc/package-versions.txt', 'usr/bin/ssh.exe', 'usr/share/licenses/openssh/LICENCE',
      'ucrt64/bin/git-remote-https.exe', 'ucrt64/etc/ssl/certs/ca-bundle.crt', 'ucrt64/bin/git-credential-manager.exe',
      'ucrt64/doc/git-credential-manager/LICENSE', 'ucrt64/doc/git-credential-manager/NOTICE', 'ucrt64/share/git-core/templates/info/exclude']) {
      if (!existsSync(join(gitRoot, name))) throw new Error('[offline toolchains] Missing MinGit component: ' + name)
    }
    run(git, ['init', '--quiet', '--initial-branch=main', 'source'])
    writeFileSync(join(probe, 'source', 'example.txt'), 'offline git\n')
    run(git, ['-C', 'source', 'add', '--', 'example.txt'])
    run(git, ['-C', 'source', '-c', 'user.name=Aether test', '-c', 'user.email=probe@example.invalid', 'commit', '--quiet', '-m', 'Offline commit'])
    run(git, ['clone', '--quiet', '--no-local', 'source', 'copy'])
    const oid = run(git, ['-C', 'source', 'rev-parse', 'HEAD'])
    if (!/^[a-f0-9]{40}$/.test(oid) || run(git, ['-C', 'copy', 'rev-parse', 'HEAD']) !== oid ||
        run(git, ['-C', 'copy', 'show', 'HEAD:example.txt']) !== 'offline git') throw new Error('[offline toolchains] Git file transport failed')
    // Prove that a relocated install has a usable ensurepip wheel, can install outside the app tree and actually imports from that environment.
    const python = join(pythonDir, 'python.exe')
    contains(run(python, ['-IB', '-m', 'pip', '--version']), 'pip ', 'python -m pip')
    run(python, ['-B', '-m', 'venv', '.venv'])
    const venv = join(probe, '.venv')
    const vpython = join(venv, 'Scripts', 'python.exe')
    run(vpython, ['-B', '-m', 'pip', 'install', '--no-index', '--no-cache-dir', '--force-reinstall', '--find-links', join(pythonDir, 'Lib', 'ensurepip', '_bundled'), 'pip'])
    contains(run(vpython, ['-IB', '-c', 'import pathlib, pip, sys; assert sys.prefix != sys.base_prefix and pathlib.Path(pip.__file__).is_relative_to(sys.prefix); print(sys.prefix)']).toLowerCase(), venv.toLowerCase(), 'venv pip')
    console.log(`[toolchains] Offline Windows smoke passed: Node ${lock.node.version}, npm/npx ${lock.node.npm}, Python ${lock.python.version}, pip, venv, Git ${lock.git.version} (commit/clone)`)
  } finally {
    const cleanup = realpathSync(probe)
    if (dirname(cleanup) !== parent || !basename(cleanup).startsWith('offline smoke ') || lstatSync(probe).isSymbolicLink()) throw new Error('Unexpected probe cleanup path')
    rmSync(cleanup, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

function verifyPackagedInventory(engine) {
  // electron-builder may silently omit an entire node_modules tree. Check the copy, not just the valid staging tree.
  // We check presence, not post-copy hashes: release signing may legitimately change the shipped executable bytes.
  const manifest = JSON.parse(readFileSync(join(engine, 'stage-manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32-x64' || !Array.isArray(manifest.files) || !manifest.files.some(file => file.path.startsWith('node_modules/'))) {
    throw new Error('[toolchains] Incomplete engine inventory')
  }
  const copied = new Set(readdirSync(engine, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => relative(engine, join(entry.parentPath, entry.name)).split(sep).join('/')))
  const missing = manifest.files.filter(file => !copied.has(file.path))
  if (missing.length) throw new Error('[toolchains] Engine files missing after packaging (' + missing.length + '): ' + missing.slice(0, 5).map(file => file.path).join(', '))
  console.log('[toolchains] Verified all ' + manifest.files.length + ' engine files in the release directory')
}

function verifyResources(resources) {
  if (existsSync(join(resources, 'app.asar'))) {
    const helper = join(resources, 'app.asar.unpacked', 'out', 'main', 'chunks', 'repository-supervisor.exe')
    const expected = readFileSync(join(root, 'src', 'main', 'git', 'assets', 'repository-supervisor.sha256'), 'utf8').trim()
    if (!existsSync(helper) || createHash('sha256').update(readFileSync(helper)).digest('hex') !== expected) {
      throw new Error('[toolchains] The Git panel requires its hash-verified native supervisor outside app.asar')
    }
  }
  for (const name of ['engine', 'toolchains']) {
    if (existsSync(join(resources, 'app.asar.unpacked', 'resources', name))) throw new Error('Duplicate Windows runtime in app.asar.unpacked: ' + name)
  }
  const engine = join(resources, 'engine', 'win32-x64')
  verifyPackagedInventory(engine)
  verifyWindowsToolchains(join(engine, 'runtime'), join(resources, 'toolchains', 'win32-x64', 'python'), join(root, '.e2e-tmp', 'toolchains'))
}

export function afterPack(context) {
  if (context.electronPlatformName === 'win32' && context.arch === Arch.x64) verifyResources(join(context.appOutDir, 'resources'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyResources(process.argv[2] ? resolve(process.argv[2]) : join(root, 'resources'))
}
