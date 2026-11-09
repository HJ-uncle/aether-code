/** Installation detection, argument safety, and trusted/local/authorized IPC boundaries without opening native apps. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function fixture() {
  const handlers = new Map(), launches = [], revealed = [], recoveries = [], cache = new Map()
  const state = {
    trusted: true, mode: 'embedded', settingsMode: 'embedded', allowed: true,
    directory: true, missing: false, spawnError: '', revealError: '', beforeDetected: () => {},
    exitCode: 0, exitSignal: null, stderr: '', recoveryStatus: 'unchanged', recoveryError: null,
    installations: [
      { app: { id: 'vscode', label: 'VS Code', available: true }, command: { executable: 'C:\\Apps\\Code.exe', kind: 'vscode' } },
      { app: { id: 'file-explorer', label: '项目目录', available: true } }
    ]
  }
  const dependencies = {
    electron: {
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      shell: { openPath: async value => { revealed.push(value); return state.revealError } }
    },
    'node:path': path.win32,
    'node:os': os,
    'node:fs/promises': { stat: async () => { if (state.missing) throw new Error('ENOENT'); return { isFile: () => true, isDirectory: () => state.directory } } },
    'node:child_process': { execFile: (command, args, options, callback) => {
      recoveries.push({ command, args, options })
      callback(state.recoveryError, JSON.stringify({ status: state.recoveryStatus }))
    }, spawn: (command, args, options) => {
      const child = new EventEmitter(); child.unref = () => { child.unreferenced = true }
      child.stderr = new PassThrough(); child.stderr.unref = () => { child.stderr.unreferenced = true }
      launches.push({ command, args, options, child })
      queueMicrotask(() => {
        if (state.spawnError) { child.emit('error', new Error(state.spawnError)); return }
        child.emit('spawn')
        if (state.stderr) child.stderr.write(state.stderr)
        if (state.exitCode !== undefined || state.exitSignal) child.emit('exit', state.exitCode, state.exitSignal)
      })
      return child
    } },
    './ipc-security': { assertTrustedRenderer: () => { if (!state.trusted) throw new Error('untrusted sender') } },
    './fs/file-service': { assertAllowed: value => { if (!state.allowed) throw new Error('outside workspace'); return value } },
    './settings-store': { getSettings: () => ({ engineMode: state.settingsMode }) },
    './engine/host': { engineHost: { getSnapshot: () => ({ mode: state.mode }) } }
  }
  function load(url) {
    const file = fileURLToPath(url)
    if (cache.has(file)) return cache.get(file)
    const exports = {}; cache.set(file, exports)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
    } }).outputText
    vm.runInNewContext('(function(exports, require) {' + code + '\n})', {
      process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Apps', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', KEEP_ME: 'yes' } },
      setTimeout, clearTimeout, Buffer
    })(exports, id => {
      if (id in dependencies) return dependencies[id]
      if (id.startsWith('.')) return load(new URL(id + '.ts', url))
      throw new Error(`Unexpected module ${id}`)
    })
    return exports
  }
  const launcher = load(new URL('./open-with.ts', import.meta.url))
  dependencies['./open-with'] = { ...launcher, detectOpenWithApplications: async () => {
    state.beforeDetected(); return state.installations
  } }
  load(new URL('./open-with-ipc.ts', import.meta.url)).registerOpenWithIpc()
  return { state, launches, revealed, recoveries, launcher,
    open: (directory, app) => handlers.get('system:open-with')({}, directory, app),
    list: () => handlers.get('system:get-open-with-apps')({}) }
}

const plain = value => JSON.parse(JSON.stringify(value))
const environment = (files, extras = {}) => ({
  platform: 'win32', home: 'C:\\Users\\User', env: {
    LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local', ProgramFiles: 'C:\\Program Files',
    SystemRoot: 'C:\\Windows', PATH: '.;relative;C:\\custom\\VSCode\\bin;C:\\custom\\Cursor\\bin'
  }, isFile: async value => files.includes(value), ...extras
})

test('Windows lists only installed developer tools, with project directory last', async () => {
  const f = fixture()
  const detected = await f.launcher.detectOpenWithApplications(environment([
    'C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    'C:\\Users\\User\\AppData\\Local\\Programs\\Cursor\\Cursor.exe',
    'C:\\Program Files\\Git\\git-bash.exe',
    'C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
  ]))
  assert.deepEqual(plain(detected.map(item => [item.app.id, item.app.available])), [
    ['vscode', true], ['cursor', true], ['file-explorer', true]
  ])
  assert.equal(detected.at(-1).app.label, '项目目录')
})

test('custom absolute PATH installations work without searching the current directory', async () => {
  const f = fixture(), probed = []
  const files = ['C:\\custom\\VSCode\\Code.exe', 'C:\\custom\\Cursor\\Cursor.exe']
  const detected = await f.launcher.detectOpenWithApplications(environment(files, {
    isFile: async value => { probed.push(value); return files.includes(value) }
  }))
  assert.equal(detected[0].command.executable, files[0])
  assert.equal(detected[1].command.executable, files[1])
  assert.equal(probed.some(value => !path.win32.isAbsolute(value)), false)
})

test('missing apps are omitted and macOS bundles use the native app launcher', async () => {
  const f = fixture()
  const windows = await f.launcher.detectOpenWithApplications(environment([]))
  assert.deepEqual(plain(windows), [{ app: { id: 'file-explorer', label: '项目目录', available: true } }])
  const mac = await f.launcher.detectOpenWithApplications(environment(['/usr/bin/open', '/Applications/Cursor.app/Contents/Info.plist'], {
    platform: 'darwin', home: '/Users/user', env: { PATH: '/usr/bin:/bin' }
  }))
  assert.equal(mac[0].app.id, 'cursor')
  assert.equal(mac[0].command.kind, 'mac-app')
  assert.equal(mac[0].command.applicationPath, '/Applications/Cursor.app')
  assert.equal(mac[1].app.label, '项目目录')
})

test('registry App Paths and uninstall records discover custom drives and Chinese paths', async () => {
  const f = fixture()
  const files = ['D:\\开发工具\\Code.exe', 'E:\\Editors\\Cursor\\Cursor.exe', 'D:\\JetBrains\\WebStorm 2026.2\\bin\\webstorm64.exe']
  const registry = [
    { kind: 'app-path', name: 'code.exe', executable: '"D:\\开发工具\\Code.exe"' },
    { kind: 'uninstall', name: 'Cursor (User)', executable: '"E:\\Editors\\Cursor\\Cursor.exe",0', location: 'E:\\Editors\\Cursor' },
    { kind: 'uninstall', name: 'WebStorm 2026.2', location: 'D:\\JetBrains\\WebStorm 2026.2' },
    { kind: 'uninstall', name: 'Cursor duplicate', location: 'E:\\Editors\\Cursor' }
  ]
  const detected = await f.launcher.detectOpenWithApplications(environment(files, { readRegistry: async () => registry }))
  assert.deepEqual(plain(detected.map(item => item.app.id)), ['vscode', 'cursor', 'webstorm', 'file-explorer'])
  assert.deepEqual(plain(detected.slice(0, -1).map(item => item.command.executable)), files)
})

test('registry executable values cannot inject commands or register unknown applications', async () => {
  const f = fixture(), probed = []
  const registry = [
    { kind: 'app-path', name: 'Code.exe', executable: 'D:\\Code.exe & calc.exe' },
    { kind: 'uninstall', name: 'Cursor', executable: 'C:\\Windows\\System32\\cmd.exe /c calc' },
    { kind: 'uninstall', name: 'Not an editor', location: 'D:\\Unrelated' },
    { kind: 'app-path', name: 'Code.exe', executable: '.\\Code.exe' }
  ]
  const detected = await f.launcher.detectOpenWithApplications(environment([], {
    readRegistry: async () => registry,
    isFile: async value => { probed.push(value); return false }
  }))
  assert.deepEqual(plain(detected.map(item => item.app.id)), ['file-explorer'])
  assert.equal(probed.some(value => /calc|cmd\.exe|Unrelated/.test(value)), false)
})

test('registry parsing preserves Unicode, ignores malformed records and handles unavailable discovery', async () => {
  const f = fixture()
  assert.deepEqual(plain(f.launcher.parseOpenWithRegistry('\uFEFF' + JSON.stringify([
    { kind: 'uninstall', name: 'Cursor', location: 'D:\\工具\\Cursor', executable: null },
    { kind: 'uninstall', name: 42 }, null, { kind: 'command', name: 'ignored' }
  ]))), [{ kind: 'uninstall', name: 'Cursor', location: 'D:\\工具\\Cursor' }])
  assert.deepEqual(plain(f.launcher.parseOpenWithRegistry('not JSON')), [])
  const detected = await f.launcher.detectOpenWithApplications(environment(['C:\\custom\\VSCode\\Code.exe'], {
    readRegistry: async () => { throw new Error('Registry access unavailable') }
  }))
  assert.deepEqual(plain(detected.map(item => item.app.id)), ['vscode', 'file-explorer'])
})

test('versioned JetBrains and bounded Toolbox installations are found without a recursive drive scan', async () => {
  const f = fixture(), visited = []
  const toolbox = 'C:\\Users\\User\\AppData\\Local\\JetBrains\\Toolbox\\apps\\PyCharm-P'
  const files = ['C:\\Program Files\\JetBrains\\WebStorm 2026.2\\bin\\webstorm64.exe', `${toolbox}\\ch-0\\262.123\\bin\\pycharm64.exe`]
  const listing = new Map([
    ['C:\\Program Files\\JetBrains', ['WebStorm 2026.2']],
    [toolbox, ['ch-0']], [`${toolbox}\\ch-0`, ['262.123']]
  ])
  const detected = await f.launcher.detectOpenWithApplications(environment(files, {
    readDirectories: async directory => { visited.push(directory); return listing.get(directory) ?? [] }
  }))
  assert.deepEqual(plain(detected.map(item => item.app.id)), ['webstorm', 'pycharm', 'file-explorer'])
  assert.equal(visited.includes('C:\\'), false)
  assert.equal(visited.includes(`${toolbox}\\ch-0\\262.123`), false)
  assert.ok(visited.length < 60)
})

test('TRAE CN and Notepad++ are discovered as project-capable installed tools', async () => {
  const f = fixture()
  const files = ['D:\\编辑器\\Trae CN.exe', 'E:\\Tools\\Notepad++\\notepad++.exe']
  const detected = await f.launcher.detectOpenWithApplications(environment(files, { readRegistry: async () => [
    { kind: 'uninstall', name: 'TRAE CN (User)', location: 'D:\\编辑器' },
    { kind: 'app-path', name: 'notepad++.exe', executable: files[1] }
  ] }))
  assert.deepEqual(plain(detected.map(item => item.app.id)), ['trae', 'notepad-plus-plus', 'file-explorer'])
  assert.equal(detected[0].app.label, 'Trae CN')
})

test('every discovery rechecks executable existence, so deleted apps disappear', async () => {
  const f = fixture(), files = ['D:\\Editors\\Cursor.exe']
  const context = environment(files, { readRegistry: async () => [{ kind: 'app-path', name: 'Cursor.exe', executable: files[0] ?? 'D:\\Editors\\Cursor.exe' }] })
  assert.deepEqual(plain((await f.launcher.detectOpenWithApplications(context)).map(item => item.app.id)), ['cursor', 'file-explorer'])
  files.length = 0
  assert.deepEqual(plain((await f.launcher.detectOpenWithApplications(context)).map(item => item.app.id)), ['file-explorer'])
})

test('spawn keeps a special-character project path in one argument and never uses a command shell', async () => {
  const f = fixture(), directory = 'C:\\项目 files\\& echo owned; $(whoami)'
  await f.open(directory, 'vscode')
  assert.equal(f.launches.length, 1)
  const launch = f.launches[0]
  assert.deepEqual(plain(launch.args), ['--new-window', directory])
  assert.equal(launch.options.cwd, directory)
  assert.equal(launch.options.shell, false)
  assert.equal(launch.options.detached, true)
  assert.equal(launch.options.windowsHide, false)
  assert.equal(launch.child.unreferenced, true)
  assert.equal(launch.child.stderr.unreferenced, true)
  assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(launch.options.env.NODE_OPTIONS, undefined)
  assert.equal(launch.options.env.KEEP_ME, 'yes')
})

test('launch arguments follow each editor protocol without evaluating user text', () => {
  const f = fixture(), directory = 'C:\\a;b & $(whoami)'
  assert.deepEqual(plain(f.launcher.openWithLaunchArguments('vscode', directory)), ['--new-window', directory])
  assert.deepEqual(plain(f.launcher.openWithLaunchArguments('sublime', directory)), ['--new-window', directory])
  assert.deepEqual(plain(f.launcher.openWithLaunchArguments('zed', directory)), ['--new', directory])
  assert.deepEqual(plain(f.launcher.openWithLaunchArguments('jetbrains', directory)), [directory])
  assert.deepEqual(plain(f.launcher.openWithLaunchArguments('notepad-plus-plus', directory)), ['-openFoldersAsWorkspace', directory])
  assert.deepEqual(plain(f.launcher.openWithLaunchArguments('mac-app', directory, '/Applications/Cursor.app')), ['-a', '/Applications/Cursor.app', directory])
})

test('File Explorer opens the directory itself and reports native open errors', async () => {
  const f = fixture()
  f.state.beforeDetected = () => { throw new Error('Project directory should not wait for application discovery') }
  await f.open('C:\\project', 'file-explorer')
  assert.deepEqual(f.revealed, ['C:\\project'])
  assert.equal(f.launches.length, 0)
  f.state.revealError = 'Access denied'
  await assert.rejects(f.open('C:\\project', 'file-explorer'), /Access denied/)
})

test('untrusted senders and remote engines cannot launch local apps', async () => {
  const f = fixture()
  f.state.trusted = false
  await assert.rejects(f.list(), /untrusted/)
  await assert.rejects(f.open('C:\\project', 'vscode'), /untrusted/)
  f.state.trusted = true; f.state.mode = 'remote'
  await assert.rejects(f.open('C:\\project', 'vscode'), /远程/)
  f.state.mode = 'embedded'; f.state.settingsMode = 'remote'
  await assert.rejects(f.open('C:\\project', 'vscode'), /远程/)
  assert.equal(f.launches.length, 0)
})

test('source changes during installation lookup are rejected before any launch', async () => {
  const f = fixture()
  f.state.beforeDetected = () => { f.state.mode = 'remote' }
  await assert.rejects(f.open('C:\\project', 'vscode'), /远程/)
  assert.equal(f.launches.length, 0)
  assert.equal(f.revealed.length, 0)
})

test('unknown applications, relative paths, unauthorized paths, files and deleted projects are rejected', async () => {
  const f = fixture()
  await assert.rejects(f.open('C:\\project', 'cmd /c calc'), /不支持/)
  await assert.rejects(f.open('C:\\project', 'terminal'), /不支持/)
  await assert.rejects(f.open('C:\\project', 'git-bash'), /不支持/)
  for (const value of ['relative', '', 'C:\\project\0extra', 42]) await assert.rejects(f.open(value, 'vscode'), /有效/)
  f.state.allowed = false
  await assert.rejects(f.open('C:\\project', 'vscode'), /outside workspace/)
  f.state.allowed = true; f.state.directory = false
  await assert.rejects(f.open('C:\\project', 'vscode'), /不存在/)
  f.state.directory = true; f.state.missing = true
  await assert.rejects(f.open('C:\\project', 'vscode'), /不存在/)
  assert.equal(f.launches.length, 0)
})

test('unavailable apps and native spawn failures are returned to the caller', async () => {
  const f = fixture()
  f.state.installations[0].app.available = false
  f.state.installations[0].app.unavailableReason = '请安装 VS Code'
  await assert.rejects(f.open('C:\\project', 'vscode'), /请安装 VS Code/)
  assert.equal(f.launches.length, 0)
  f.state.installations[0].app.available = true; f.state.spawnError = 'EACCES'
  await assert.rejects(f.open('C:\\project', 'vscode'), /无法打开 VS Code.*EACCES/)
})

test('a successful spawn is not reported as success before startup can fail', async () => {
  const f = fixture(); f.state.exitCode = undefined
  let completed = false
  const pending = f.open('C:\\project', 'vscode').then(() => { completed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.launches.length, 1)
  assert.equal(completed, false)
  f.launches[0].child.emit('exit', 0, null)
  await pending
  assert.equal(completed, true)
})

test('quick nonzero exits include bounded native stderr instead of silently succeeding', async () => {
  const f = fixture(); f.state.exitCode = 7
  f.state.stderr = 'x'.repeat(8000) + '\u001b[31mMissing required runtime DLL\u001b[0m'
  await assert.rejects(f.open('C:\\project', 'vscode'), error => {
    assert.match(error.message, /退出码 7/)
    assert.match(error.message, /Missing required runtime DLL/)
    assert.equal(error.message.includes('\u001b'), false)
    assert.ok(error.message.length < 1200)
    return true
  })
})

test('a running editor is released after the bounded startup observation', { timeout: 5000 }, async () => {
  const f = fixture(); f.state.exitCode = undefined
  await f.open('C:\\project', 'vscode')
  assert.equal(f.launches[0].child.unreferenced, true)
  assert.equal(f.launches[0].child.stderr.destroyed, false)
})

test('VS Code recovery uses a hidden fixed helper with paths passed as data', async () => {
  const f = fixture(), directory = "C:\\工作区 & '项目'"
  f.state.recoveryStatus = 'recovered'
  await f.open(directory, 'vscode')
  assert.equal(f.recoveries.length, 1)
  const helper = f.recoveries[0]
  assert.equal(helper.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(helper.options.windowsHide, true)
  assert.ok(helper.options.timeout > 0 && helper.options.timeout <= 6000)
  assert.equal(helper.options.env.AETHER_OPEN_WITH_DIRECTORY, directory)
  assert.equal(helper.options.env.AETHER_OPEN_WITH_EXECUTABLE, 'C:\\Apps\\Code.exe')
  const script = Buffer.from(helper.args.at(-1), 'base64').toString('utf16le')
  assert.ok(helper.command.length + helper.args.join(' ').length < 32000)
  assert.equal(script.includes(directory), false)
  assert.match(script, /OpenProcessToken/)
  assert.match(script, /QueryFullProcessImageName/)
  assert.match(script, /CommandLineToArgvW/)
})

test('ambiguous or unverified hidden project windows produce a clear recovery error', async () => {
  const f = fixture(); f.state.recoveryStatus = 'ambiguous'
  await assert.rejects(f.open('C:\\project', 'vscode'), /多个同名项目窗口/)
  f.state.recoveryStatus = 'unverified'
  await assert.rejects(f.open('C:\\project', 'vscode'), /无法安全恢复/)
})

test('optional recovery failures do not break normal launches or affect other applications', async () => {
  const f = fixture(); f.state.recoveryError = new Error('Helper unavailable')
  await f.open('C:\\project', 'vscode')
  const count = f.recoveries.length
  f.state.installations.push({ app: { id: 'trae', label: 'Trae CN', available: true }, command: { executable: 'C:\\Apps\\Trae CN.exe', kind: 'vscode' } })
  await f.open('C:\\project', 'trae')
  await f.open('C:\\project', 'file-explorer')
  assert.equal(f.recoveries.length, count)
})

test('the renderer only receives status fields, never application executable paths', async () => {
  const f = fixture()
  assert.deepEqual(plain(await f.list()), [
    { id: 'vscode', label: 'VS Code', available: true },
    { id: 'file-explorer', label: '项目目录', available: true }
  ])
})
