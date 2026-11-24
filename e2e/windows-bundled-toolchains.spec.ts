/** Installed Windows x64 app: real PowerShell, source control and MCP in an isolated user profile.
 * Set AETHER_E2E_PACKAGED_EXE to an unpacked release executable after packaging.
 * This opt-in suite never falls back to the development Electron or host tools. */
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type { EngineRequestInput } from '../src/shared/ipc'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp', 'bundled-toolchains-e2e')
const installed = process.env.AETHER_E2E_PACKAGED_EXE, probeSource = join(__dirname, 'fixtures', 'bundled-toolchain-probe.mjs')
const lock = JSON.parse(readFileSync(join(root, 'scripts', 'windows-toolchains.lock.json'), 'utf8')) as { node: { version: string; npm: string }; python: { version: string }; git: { version: string } }
const canonical = (path: string): string => resolve(path).toLowerCase()
let fixture = '', project = '', profile = '', venv = '', nodeDir = '', pythonDir = '', selectedNode = '', aliasMarker = ''
let gitRoot = '', selectedGitRoot = ''
let app: ElectronApplication | undefined, page: Page
interface Receipt { node: string; nodeVersion: string; python: { executable: string; prefix: string; basePrefix: string; version: number[] }; gitExecPath: string; gitVersion: string; npm?: string; npx?: string }

function environment(selected: boolean): Record<string, string> {
  const system = process.env.SystemRoot || 'C:\\Windows', home = join(fixture, 'home'), temp = join(fixture, 'temp')
  const appData = join(home, 'AppData', 'Roaming'), local = join(home, 'AppData', 'Local')
  const aliases = join(local, 'Microsoft', 'WindowsApps'), nodeCache = join(fixture, 'npm-cache')
  const programs = join(fixture, 'programs'), programs32 = join(fixture, 'programs32'), programData = join(fixture, 'program-data')
  for (const folder of [appData, aliases, temp, nodeCache, programs, programs32, programData]) mkdirSync(folder, { recursive: true })
  // The OS input method may keep TEMP/LOG/APP/SGTool_*.log open even after Electron exits.
  // Reserve only its private subdirectory in this disposable TEMP; keep the application's normal temp directory writable.
  const imeLogs = join(temp, 'LOG', 'APP')
  if (!existsSync(imeLogs)) { mkdirSync(dirname(imeLogs), { recursive: true }); writeFileSync(imeLogs, '', { flag: 'wx' }) }
  // A .cmd store stand-in must never open in PowerShell even if WindowsApps was originally first on PATH.
  aliasMarker = join(fixture, 'unexpected-store-alias.txt')
  writeFileSync(join(aliases, 'python.cmd'), '@echo off\r\necho wrong > "%AETHER_E2E_ALIAS_MARKER%"\r\nexit /b 9\r\n')
  const names = ['SYSTEMDRIVE', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USERDOMAIN', 'USERNAME']
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && names.includes(entry[0].toUpperCase()))),
    SystemRoot: system, WINDIR: system, ComSpec: join(system, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ProgramFiles: programs, 'ProgramFiles(x86)': programs32, ProgramW6432: programs, ProgramData: programData,
    Path: ['', '.', 'relative-tools', aliases, ...(selected ? [dirname(selectedNode), join(selectedGitRoot, 'cmd')] : []), join(system, 'System32'), system].join(delimiter),
    TEMP: temp, TMP: temp, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: local,
    AETHER_E2E_ALIAS_MARKER: aliasMarker, AETHER_GLOBAL_DIR: join(fixture, 'engine-config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'unused.gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Offline QA', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'Offline QA', GIT_COMMITTER_EMAIL: 'qa@example.invalid',
    GIT_CEILING_DIRECTORIES: fixture, GIT_TRACE: join(fixture, 'git.trace'),
    PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_CONFIG_FILE: 'nul', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_CACHE: nodeCache,
    ...(selected ? { VIRTUAL_ENV: venv } : {})
  }
}

async function startDesktop(selected: boolean, engine: boolean): Promise<void> {
  const probe = createServer()
  await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done) })
  const port = probe.address()
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()))
  if (!port || typeof port === 'string') throw new Error('Could not obtain test engine port')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, engineMode: 'embedded', preferredPort: port.port }))
  const env = environment(selected)
  app = await electron.launch({ executablePath: installed, args: [`--user-data-dir=${profile}`], cwd: root, artifactsDir: test.info().outputPath('electron'), env })
  const state = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), resources: process.resourcesPath, path: process.env.PATH }))
  expect(state.packaged).toBe(true)
  expect(canonical(state.profile)).toBe(canonical(profile))
  expect(canonical(state.resources)).toBe(canonical(join(dirname(installed!), 'resources')))
  expect(state.path).toBe(env.Path)
  page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.aether?.terminal?.create === 'function')
  if (engine) {
    const { snapshot, logs } = await page.evaluate(async () => {
      // The bridge already redacts child output before broadcasting it. Keep only a bounded tail for failures.
      const logs: string[] = []
      const off = window.aether.engine.onLog(({ level, line }) => {
        logs.push(`[${level}] ${line.slice(0, 400)}`)
        if (logs.length > 20) logs.shift()
      })
      try { return { snapshot: await window.aether.engine.start(), logs } }
      catch (error) { throw new Error([String(error), ...logs].join('\n')) }
      finally { off() }
    })
    expect(snapshot, [snapshot.error ?? 'embedded engine must own its runtime', ...logs].join('\n')).toMatchObject({ mode: 'embedded', phase: 'ready', runtimeSource: 'bundled', adopted: false })
    if (!snapshot.pid || !Number.isSafeInteger(snapshot.pid) || snapshot.pid < 1) throw new Error('The running embedded engine must report its own PID')
    const engineExecutable = execFileSync(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-Process -Id ([int]$env:AETHER_E2E_ENGINE_PID) -ErrorAction Stop).Path'
    ], { env: { ...env, AETHER_E2E_ENGINE_PID: String(snapshot.pid) }, cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim()
    expect(canonical(engineExecutable), 'the engine host must run the packaged Node even when the project selects a different Node').toBe(canonical(join(nodeDir, 'node.exe')))
  }
}
async function ipc(input: EngineRequestInput): Promise<unknown> {
  const result = await page.evaluate(request => window.aether.engine.request(request), input)
  expect(result.ok, input.method + ' ' + input.path + ': ' + result.message).toBe(true)
  return result.data
}

async function checkEngineSourceControl(): Promise<void> {
  const sessionId = 'bundled-git-acceptance'
  const value = await ipc({ method: 'GET', path: '/git/binding', query: { sessionId } })
  if (!value || typeof value !== 'object' || !('root' in value) || typeof value.root !== 'string' ||
      !('epoch' in value) || typeof value.epoch !== 'string') throw new Error('Missing engine workspace binding')
  expect(isAbsolute(value.root) && canonical(value.root).startsWith(canonical(profile) + '\\')).toBe(true)
  // A binding can describe a new scratch workspace before anything has created its directory.
  mkdirSync(value.root, { recursive: true })
  const cwd = realpathSync(value.root)
  expect(canonical(cwd).startsWith(canonical(profile) + '\\'), 'only write inside the disposable engine profile').toBe(true)
  const binding = { sessionId, expectedRoot: value.root, bindingEpoch: value.epoch }
  expect(await ipc({ method: 'POST', path: '/git/action', body: { ...binding, op: 'init' } })).toMatchObject({ success: true })
  expect(readFileSync(join(cwd, '.git', 'HEAD'), 'utf8')).toMatch(/^ref: refs\/heads\//)
  writeFileSync(join(cwd, 'engine-git.txt'), 'engine git\n', { flag: 'wx' })
  expect(await ipc({ method: 'GET', path: '/git/status', query: binding })).toMatchObject({
    success: true, isRepo: true, files: expect.arrayContaining([expect.objectContaining({ path: 'engine-git.txt', staged: false })])
  })
}

function gitExecPath(selected: boolean): string {
  const prefix = selected ? selectedGitRoot : gitRoot
  // Ask the official executable for its layout; newer Git for Windows can use ucrt64 instead of mingw64.
  const raw = execFileSync(join(prefix, 'cmd', 'git.exe'), ['--exec-path'], {
    cwd: fixture, env: { ...environment(selected), GIT_TRACE: '0' }, encoding: 'utf8', windowsHide: true, timeout: 15_000
  }).trim()
  expect(canonical(raw).startsWith(canonical(prefix) + '\\')).toBe(true)
  return raw
}

async function checkSourceControl(selected: boolean): Promise<void> {
  // One disposable repo, distinct from the shell fixtures. The only caller issuing Git commands in this interval is the desktop Git bridge.
  const repo = join(project, 'Git 工作区'), file = '验收 文件.txt', contents = 'offline commit\n', message = '离线提交验收'
  mkdirSync(repo); writeFileSync(join(repo, file), contents)
  const trace = join(fixture, 'git.trace'), offset = existsSync(trace) ? readFileSync(trace).length : 0
  await page.evaluate(cwd => window.aether.fs.allowRoot(cwd), repo)
  const init = await page.evaluate(cwd => window.aether.git.init(cwd), repo)
  expect(init, init.error).toMatchObject({ success: true })
  const status = () => page.evaluate(cwd => window.aether.git.status(cwd), repo)
  const before = await status()
  expect(before, before.error).toMatchObject({ success: true, isRepo: true, files: [{ path: file, staged: false, unstagedChange: 'untracked' }] })
  const stage = await page.evaluate(([cwd, path]) => window.aether.git.stage(cwd, path), [repo, file])
  expect(stage, stage.error).toMatchObject({ success: true })
  const staged = await status()
  expect(staged, staged.error).toMatchObject({ success: true, files: [{ path: file, staged: true, stagedChange: 'added' }] })
  const commit = await page.evaluate(([cwd, msg]) => window.aether.git.commit(cwd, msg), [repo, message])
  expect(commit, commit.error).toMatchObject({ success: true })
  const log = await page.evaluate(cwd => window.aether.git.log(cwd, 2), repo)
  expect(log, log.error).toMatchObject({ success: true, commits: [{ subject: message, author: 'Offline QA' }] })
  const saved = await page.evaluate(([cwd, path]) => window.aether.git.getHeadFile(cwd, path), [repo, file])
  expect(saved, saved.error).toMatchObject({ success: true, content: contents })
  const head = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim()
  expect(head).toMatch(/^ref: refs\/heads\/[\w.-]+$/)
  const hash = log.commits?.[0]?.hash
  expect(hash).toMatch(/^[\da-f]{40,64}$/)
  expect(readFileSync(join(repo, '.git', head.slice(5)), 'utf8').trim()).toBe(hash)
  const clean = await status()
  expect(clean, clean.error).toMatchObject({ success: true, isRepo: true, files: [] })

  const found = await page.evaluate(cwd => window.aether.search.query(cwd, 'offline commit', {
    caseSensitive: true, wholeWord: false, useRegex: false, include: '', exclude: ''
  }, {}), repo)
  expect(found).toMatchObject({ strategy: 'git', truncated: false, hits: [{ path: file, line: 1, text: 'offline commit' }] })

  // git.exe reports its actual native executable directory through Git's trace, independently of what PATH inspection predicts.
  const traceText = readFileSync(trace).subarray(offset).toString('utf8')
  const prefix = canonical(selected ? selectedGitRoot : gitRoot)
  const nativeDirs = [...new Set(Array.from(traceText.matchAll(/trace: resolved executable dir: ([^\r\n]+)/g), match => canonical(match[1])))]
  expect(nativeDirs.length, 'no native Git invocation was traced for the source control panel').toBeGreaterThan(0)
  for (const native of nativeDirs) expect(native.startsWith(prefix + '\\'), 'source control used ' + native + ' instead of ' + prefix).toBe(true)
  writeFileSync(join(project, 'git-panel-receipt.json'), JSON.stringify({ head: hash, nativeDirs }))
}

function checkReceipt(receipt: Receipt, selected: boolean): void {
  expect(canonical(receipt.node)).toBe(canonical(selected ? selectedNode : join(nodeDir, 'node.exe')))
  expect(receipt.nodeVersion).toBe(lock.node.version)
  expect(canonical(receipt.python.executable)).toBe(canonical(selected ? join(venv, 'Scripts', 'python.exe') : join(pythonDir, 'python.exe')))
  expect(canonical(receipt.python.prefix)).toBe(canonical(selected ? venv : pythonDir))
  expect(canonical(receipt.python.basePrefix)).toBe(canonical(pythonDir))
  expect(receipt.python.version.join('.')).toBe(lock.python.version)
  expect(canonical(receipt.gitExecPath)).toBe(canonical(gitExecPath(selected)))
  expect(receipt.gitVersion).toBe('git version ' + lock.git.version)
  expect(existsSync(aliasMarker), 'a Windows Store launcher won instead of an interpreter').toBe(false)
}
function prepareSelected(): void {
  // A selected Node installation with a distinct executable path; never depend on a developer's version manager.
  mkdirSync(dirname(selectedNode), { recursive: true }); copyFileSync(join(nodeDir, 'node.exe'), selectedNode)
  // A complete second MinGit installation can run real commands and reports its own installation prefix.
  cpSync(gitRoot, selectedGitRoot, { recursive: true })
  execFileSync(join(pythonDir, 'python.exe'), ['-m', 'venv', venv], { cwd: project, env: environment(false), timeout: 60_000, windowsHide: true })
}

// Typical desktop E2E only builds out/. The packaging job supplies the unpacked EXE explicitly;
// once opted in, missing tools, stale packages and broken runtimes are failures, never skips.
test.skip(process.platform !== 'win32' || process.arch !== 'x64' || !installed, 'Requires Windows x64 and AETHER_E2E_PACKAGED_EXE (unpacked release)')
test.beforeEach(() => {
  if (!installed || !isAbsolute(installed) || !existsSync(installed)) throw new Error('Missing unpacked Windows application: ' + installed)
  mkdirSync(fixtureRoot, { recursive: true }); fixture = mkdtempSync(join(fixtureRoot, 'run-'))
  project = join(fixture, '示例 project'); profile = join(fixture, 'profile'); venv = join(project, '.venv')
  selectedNode = join(fixture, 'selected node', 'node.exe')
  // A focused native window may start an OS input-method helper which retains files in LocalLow for minutes after Electron exits.
  // This disposable user needs only Local and Roaming; keep unrelated low-integrity profiles out of the runtime test.
  const appData = join(fixture, 'home', 'AppData')
  mkdirSync(appData, { recursive: true }); writeFileSync(join(appData, 'LocalLow'), '', { flag: 'wx' })
  nodeDir = join(dirname(installed), 'resources', 'engine', 'win32-x64', 'runtime')
  pythonDir = join(dirname(installed), 'resources', 'toolchains', 'win32-x64', 'python')
  gitRoot = join(dirname(pythonDir), 'git'); selectedGitRoot = join(fixture, 'selected Git')
  mkdirSync(project, { recursive: true }); copyFileSync(probeSource, join(project, '检查 runtime.mjs'))
})
async function attachReceipts(info: TestInfo): Promise<void> {
  // Preserve probe output, never the full profile, environment or temporary virtualenv.
  for (const file of ['shell-receipt.json', 'mcp receipt.json', 'python-shell.txt', 'venv-pip.txt', 'npm-version.txt', 'npx-version.txt', 'git-shell-path.txt', 'git-panel-receipt.json']) {
    const path = join(project, file)
    if (existsSync(path)) await info.attach(file, { body: readFileSync(path), contentType: file.endsWith('.json') ? 'application/json' : 'text/plain' })
  }
}

test.afterEach(async ({}, info) => {
  if (!fixture) return
  try {
    // Keep the small execution evidence even if closing or deleting the fixture is what fails.
    await attachReceipts(info)
  } finally {
    if (app) {
      const child = app.process()
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit', { signal: AbortSignal.timeout(30_000) })
      await Promise.all([exited, app.close()]); app = undefined
    }
    const expectedParent = join(realpathSync(root), '.e2e-tmp', 'bundled-toolchains-e2e')
    if (canonical(realpathSync(fixtureRoot)) !== canonical(expectedParent) || canonical(dirname(realpathSync(fixture))) !== canonical(expectedParent) || !/^run-[a-z0-9]{6}$/i.test(basename(fixture)) || lstatSync(fixture).isSymbolicLink()) throw new Error('Refusing cleanup outside owned run: ' + fixture)
    // The async remover identifies locked children. Retry the whole tree so a nested lock cannot multiply the retry budget.
    const deadline = Date.now() + 10_000
    for (;;) {
      try { await rm(fixture, { recursive: true, force: true }); break }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error
        await delay(250)
      }
    }
    fixture = ''
    if (readdirSync(fixtureRoot).length === 0 && !lstatSync(fixtureRoot).isSymbolicLink()) rmdirSync(fixtureRoot)
  }
})

for (const selected of [false, true]) {
  const scenario = selected ? 'selected Git, Node and activated venv' : 'no system Git or interpreters'
  test(`installed PowerShell and source control run offline: ${scenario}`, async () => {
    if (selected) prepareSelected()
    await startDesktop(selected, false)
    await checkSourceControl(selected)
    const terminal = await page.evaluate(async cwd => {
      try { return await window.aether.terminal.create({ cwd, cols: 100, rows: 24 }) }
      catch (error) { return { error: String(error) } }
    }, project)
    if ('error' in terminal) {
      expect(terminal.error).toMatch(/Cannot launch conpty|conpty (?:is )?unavailable/i)
      test.skip(true, terminal.error); return
    }
    try {
      // Use the bare command in the actual default PowerShell (including its execution policy).
      // Out-File defaults to UTF-16 on Windows PowerShell; explicitly use ASCII for version text.
      const commands = [
        "(Get-Command git -CommandType Application | Select-Object -First 1).Source | Out-File 'git-shell-path.txt' -Encoding utf8",
        "npm --version | Out-File 'npm-version.txt' -Encoding ascii", "npx --version | Out-File 'npx-version.txt' -Encoding ascii",
        "python -c \"from pathlib import Path; Path('python-shell.txt').write_text('ok')\"",
        ...(selected ? [] : ["python -m venv .venv", ".\\.venv\\Scripts\\python.exe -m pip --version | Out-File 'venv-pip.txt' -Encoding ascii"]),
        "node '.\\检查 runtime.mjs' 'shell-receipt.json' shell"
      ]
      await page.evaluate(([id, command]) => window.aether.terminal.write(id, command + '\r'), [terminal.id, commands.join('; ')])
      const receipt = join(project, 'shell-receipt.json')
      await expect.poll(() => existsSync(receipt), { timeout: 75_000, message: 'No receipt from scripts in the real terminal: ' + project }).toBe(true)
      const value = JSON.parse(readFileSync(receipt, 'utf8')) as Receipt
      checkReceipt(value, selected)
      expect(canonical(readFileSync(join(project, 'git-shell-path.txt'), 'utf8').trim())).toBe(canonical(join(selected ? selectedGitRoot : gitRoot, 'cmd', 'git.exe')))
      expect(value.npm).toBe(lock.node.npm); expect(value.npx).toBe(lock.node.npm)
      expect(readFileSync(join(project, 'python-shell.txt'), 'utf8')).toBe('ok')
      if (!selected) expect(readFileSync(join(project, 'venv-pip.txt'), 'ascii').replaceAll('\\', '/').toLowerCase()).toContain('/.venv/lib/site-packages/pip')
    } finally { await page.evaluate(id => window.aether.terminal.dispose(id), terminal.id) }
  })

  test(`installed local engine discovers a real offline stdio MCP: ${scenario}`, async () => {
    if (selected) prepareSelected()
    await startDesktop(selected, true)
    await checkEngineSourceControl()
    const receipt = join(project, 'mcp receipt.json'), id = 'runtime-probe'
    // npx must launch a local executable, not merely return its own version. No registry access is permitted.
    const script = join(project, '检查 runtime.mjs')
    // --call runs only this local command; plain npx node would try to resolve a registry package named node.
    const args = selected ? [script, receipt, 'mcp'] : ['--offline', '--call', `node "${script}" "${receipt}" mcp`]
    await ipc({ method: 'POST', path: '/mcp/servers', query: { path: project }, body: {
      id, name: 'Offline runtime', transportType: 'stdio', command: selected ? 'node' : 'npx', args,
      timeoutMs: 15_000, enabled: false, scope: 'project'
    } })
    const result = await ipc({ method: 'POST', path: `/mcp/servers/${id}/test`, query: { path: project }, timeoutMs: 30_000 })
    expect(result).toMatchObject({ success: true, toolCount: 1, tools: [{ name: `mcp_${id}_runtime_probe` }] })
    checkReceipt(JSON.parse(readFileSync(receipt, 'utf8')) as Receipt, selected)
  })
}
