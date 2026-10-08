/** Real main-process IPC matrix: FS CRUD/limits/attachments/permission, search, settings, window and PTY. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'
import type { SearchOptions } from '../src/shared/ipc'

declare global { interface Window { aether: AetherIdeApi } }
const root = resolve(__dirname, '..')
const options: SearchOptions = { caseSensitive: false, wholeWord: false, useRegex: false, include: '', exclude: '' }
let app: ElectronApplication
let page: Page
let fixture: string
let workspace: string
let outside: string
let userData: string
async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env: { ...process.env } })
  page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.aether))
}
const errorOf = async (operation: () => Promise<unknown>): Promise<string> => {
  try { await operation(); return '' } catch (error) { return String(error) }
}

test.describe.serial('平台 IPC 全功能矩阵', () => {
  test.beforeAll(async () => {
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'platform-matrix-'))
    workspace = join(fixture, 'workspace'); outside = join(fixture, 'workspace-other'); userData = join(fixture, 'profile')
    for (const dir of [workspace, outside, userData]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(outside, 'private.txt'), 'outside sentinel')
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    await launch()
  })
  // Keep this spec's isolated fixture as evidence; never clean another runner's shared output.
  test.afterAll(async () => { await app?.close() })

  test('FS create/read/write/stat/list/copy/rename preserve disk content and reject overwrite', async () => {
    const folder = join(workspace, 'crud'); const file = join(folder, 'note.txt')
    await page.evaluate(async ({ folder, file }) => {
      await window.aether.fs.createFolder(folder); await window.aether.fs.createFile(file)
      await window.aether.fs.writeFile(file, '\uFEFF中文\nhello')
    }, { folder, file })
    expect(readFileSync(file, 'utf8')).toBe('\uFEFF中文\nhello')
    const read = await page.evaluate(file => window.aether.fs.readFile(file), file)
    expect(read).toMatchObject({ content: '中文\nhello', isBinary: false, truncated: false })
    expect(await page.evaluate(file => window.aether.fs.stat(file), file)).toMatchObject({ isDirectory: false, size: Buffer.byteLength('\uFEFF中文\nhello') })
    expect(await errorOf(() => page.evaluate(file => window.aether.fs.createFile(file), file))).toContain('同名文件')
    expect(await errorOf(() => page.evaluate(folder => window.aether.fs.createFolder(folder), folder))).toContain('同名文件夹')
    await page.evaluate(async ({ folder, workspace }) => {
      await window.aether.fs.copy(folder, `${workspace}/copied`)
      await window.aether.fs.rename(`${workspace}/copied/note.txt`, `${workspace}/moved/note.txt`)
    }, { folder, workspace })
    expect(readFileSync(join(workspace, 'moved/note.txt'), 'utf8')).toBe('\uFEFF中文\nhello')
    expect(existsSync(join(workspace, 'copied/note.txt'))).toBe(false)
    for (const operation of ['copy', 'rename'] as const) {
      expect(await errorOf(() => page.evaluate(({ operation, file }) => window.aether.fs[operation](file, file), { operation, file }))).toContain('目标已存在')
    }
    mkdirSync(join(workspace, 'node_modules'), { recursive: true }); writeFileSync(join(workspace, 'node_modules/hidden.js'), 'skip')
    const all = await page.evaluate(workspace => window.aether.fs.listAll(workspace), workspace)
    expect(all).toContain('crud/note.txt'); expect(all).not.toContain('node_modules/hidden.js')
    const entries = await page.evaluate(workspace => window.aether.fs.readDir(workspace), workspace)
    expect(entries.find(entry => entry.name === 'crud')?.isDirectory).toBe(true)
  })

  test('FS binary/base64, oversize preview, text truncation and missing-file errors', async () => {
    const binary = join(workspace, 'binary.bin'); const large = join(workspace, 'large.bin'); const text = join(workspace, 'large.txt')
    writeFileSync(binary, Buffer.from([0, 1, 2, 255])); writeFileSync(large, Buffer.from([0])); truncateSync(large, 32 * 1024 * 1024 + 1)
    writeFileSync(text, 'x'.repeat(4 * 1024 * 1024 + 1))
    expect(await page.evaluate(p => window.aether.fs.readFile(p), binary)).toMatchObject({ isBinary: true, base64: 'AAEC/w==', size: 4 })
    expect(await page.evaluate(p => window.aether.fs.readFile(p), large)).toMatchObject({ isBinary: true, tooLarge: true, content: '' })
    const read = await page.evaluate(p => window.aether.fs.readFile(p), text)
    expect(read.truncated).toBe(true); expect(read.content.length).toBe(4 * 1024 * 1024)
    expect(await errorOf(() => page.evaluate(p => window.aether.fs.readFile(p), join(workspace, 'missing')))).toContain('ENOENT')
  })

  test('FS attachments sanitize names, preserve bytes and avoid collisions', async () => {
    mkdirSync(join(workspace, 'uploads'), { recursive: true })
    writeFileSync(join(workspace, 'uploads', 'project-file.txt'), 'project-owned uploads')
    const copies = await page.evaluate(async root => {
      const input = { root, fileName: '../bad:name.txt', data: new Uint8Array([0, 7, 255]) }
      return [await window.aether.fs.copyIntoWorkspace(input), await window.aether.fs.copyIntoWorkspace(input)]
    }, workspace)
    expect(copies[0].relativePath).toBe('.ae/attachments/bad_name.txt')
    expect(copies[1].relativePath).toBe('.ae/attachments/bad_name-1.txt')
    expect([...readFileSync(copies[0].path)]).toEqual([0, 7, 255]); expect(copies[0].size).toBe(3)
    expect(readFileSync(join(workspace, 'uploads', 'project-file.txt'), 'utf8')).toBe('project-owned uploads')
  })

  test('FS outside roots and sibling-prefix paths are rejected for all access operations', async () => {
    const checks = await page.evaluate(async ({ outside, workspace }) => {
      const fs = window.aether.fs; const target = `${outside}/private.txt`
      const calls = [() => fs.readDir(outside), () => fs.readFile(target), () => fs.stat(target), () => fs.listAll(outside),
        () => fs.writeFile(target, 'must not write'), () => fs.createFile(`${outside}/new.txt`), () => fs.createFolder(`${outside}/new-dir`),
        () => fs.rename(target, `${workspace}/stolen.txt`), () => fs.copy(target, `${workspace}/copied-private.txt`),
        () => fs.rename(`${workspace}/crud/note.txt`, `${outside}/moved.txt`), () => fs.copy(`${workspace}/crud/note.txt`, `${outside}/copied.txt`),
        () => fs.trash(target), () => fs.copyIntoWorkspace({ root: outside, fileName: 'upload.txt', data: new Uint8Array([1]) })]
      return Promise.all(calls.map(async call => { try { await call(); return '' } catch (error) { return String(error) } }))
    }, { outside, workspace })
    expect(checks).toHaveLength(13)
    for (const error of checks) expect(error).toContain('拒绝访问工作区之外')
    expect(readFileSync(join(outside, 'private.txt'), 'utf8')).toBe('outside sentinel')
  })

  test('FS junction cannot escape the authorized workspace', async () => {
    const link = join(workspace, 'outside-link')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await errorOf(() => page.evaluate(p => window.aether.fs.readFile(p), join(link, 'private.txt')))).toContain('拒绝访问工作区之外')
    expect(await errorOf(() => page.evaluate(p => window.aether.fs.writeFile(p, 'must not write'), join(link, 'new.txt')))).toContain('拒绝访问工作区之外')
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  })

  for (const git of [false, true]) test(`search ${git ? 'git' : 'scan'} include/exclude/case/whole-word/regex and replacement`, async () => {
    const directory = join(workspace, git ? 'search-git' : 'search-scan')
    mkdirSync(join(directory, 'nested'), { recursive: true })
    writeFileSync(join(directory, 'alpha.txt'), 'Needle needle needles\nID=42\n')
    writeFileSync(join(directory, 'nested/beta.txt'), 'needle\n')
    writeFileSync(join(directory, 'nested/digits.txt'), 'ID=73\n')
    writeFileSync(join(directory, 'skip.log'), 'needle\n')
    writeFileSync(join(directory, 'binary.bin'), Buffer.from([0, ...Buffer.from('needle')]))
    if (git) execFileSync('git', ['init', '--quiet', directory], { windowsHide: true })
    const query = (query: string, opts = options, excludes = {}) => page.evaluate(({ directory, query, opts, excludes }) => window.aether.search.query(directory, query, opts, excludes), { directory, query, opts, excludes })
    expect((await query('needle')).strategy).toBe(git ? 'git' : 'scan')
    expect((await query('needle', { ...options, include: 'beta.txt' })).hits.map(hit => hit.path)).toEqual(['nested/beta.txt'])
    expect((await query('needle', { ...options, include: ':(exclude)skip.log' })).hits).toEqual([])
    expect((await query('needle', { ...options, include: '**/*.txt', exclude: '**/beta.txt' })).hits.map(hit => hit.path)).toEqual(['alpha.txt'])
    expect((await query('Needle', { ...options, caseSensitive: true, wholeWord: true })).hits.map(hit => hit.path)).toEqual(['alpha.txt'])
    expect((await query('needle', options, { '*.txt': true })).hits.map(hit => hit.path)).toEqual(['skip.log'])
    expect((await query('(?<=ID=)42', { ...options, useRegex: true })).hits[0]?.text).toBe('ID=42')
    const jsEscape = await query('ID=(\\d+)', { ...options, useRegex: true, include: 'digits.txt' })
    expect(jsEscape.hits.map(hit => hit.path)).toEqual(['nested/digits.txt'])
    expect((await query('[', { ...options, useRegex: true })).error).toContain('正则表达式无效')
    expect((await query('   ')).hits).toEqual([])
    const replacement = { ...options, useRegex: true, include: 'alpha.txt' }
    const preview = await page.evaluate(({ directory, replacement }) => window.aether.search.preview(directory, 'ID=([0-9]+)', replacement, 'VALUE=$1', {}), { directory, replacement })
    expect(preview.total).toBe(1); expect(preview.files[0].lines[0]).toMatchObject({ before: 'ID=42', after: 'VALUE=42' })
    expect(readFileSync(join(directory, 'alpha.txt'), 'utf8')).toContain('ID=42')
    const replaced = await page.evaluate(({ directory, replacement }) => window.aether.search.replace(directory, 'ID=([0-9]+)', replacement, 'VALUE=$1', {}), { directory, replacement })
    expect(replaced).toMatchObject({ files: ['alpha.txt'], replacements: 1 })
    expect(readFileSync(join(directory, 'alpha.txt'), 'utf8')).toContain('VALUE=42')
    const invalid = await page.evaluate(({ directory, options }) => window.aether.search.replace(directory, '[', { ...options, useRegex: true }, 'x', {}), { directory, options })
    expect(invalid.error).toContain('正则表达式无效')
  })

  test('search query/preview/replace reject unauthorized roots without modifying outside data', async () => {
    const results = await page.evaluate(async ({ outside, options }) => {
      const calls = [() => window.aether.search.query(outside, 'sentinel', options, {}),
        () => window.aether.search.preview(outside, 'sentinel', options, 'changed', {}),
        () => window.aether.search.replace(outside, 'sentinel', options, 'changed', {})]
      return Promise.all(calls.map(async call => { try { await call(); return '' } catch (error) { return String(error) } }))
    }, { outside, options })
    for (const error of results) expect(error).toContain('拒绝访问工作区之外')
    expect(readFileSync(join(outside, 'private.txt'), 'utf8')).toBe('outside sentinel')
  })

  test('settings update persists, preserves defaults and survives a full application restart', async () => {
    const update = { engineMode: 'remote' as const, remoteBaseUrl: 'http://127.0.0.1:19999', autoStartEngine: false, preferredPort: 14567,
      appearance: 'dark' as const, accent: 'blue' as const, lastFolder: workspace, filesExclude: { '*.tmp': true }, searchExclude: { '*.log': true } }
    await page.evaluate(update => window.aether.settings.update(update), update)
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))).toMatchObject(update)
    await app.close(); await launch()
    expect(await page.evaluate(() => window.aether.settings.get())).toMatchObject(update)
    expect((await page.evaluate(() => window.aether.engine.getSnapshot())).phase).toBe('idle')
    expect((await page.evaluate(p => window.aether.fs.readFile(p), join(workspace, 'crud/note.txt'))).content).toBe('中文\nhello')
  })

  test('window maximize/restore/minimize IPC changes the actual BrowserWindow', async () => {
    const before = await page.evaluate(() => window.aether.window.isMaximized())
    await page.evaluate(() => window.aether.window.toggleMaximize())
    await expect.poll(() => page.evaluate(() => window.aether.window.isMaximized())).toBe(!before)
    await page.evaluate(() => window.aether.window.toggleMaximize())
    await expect.poll(() => page.evaluate(() => window.aether.window.isMaximized())).toBe(before)
    await page.evaluate(() => window.aether.window.minimize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  })

  test('PTY create/data/resize/exit/dispose or explicit environment capability failure', async () => {
    const result = await page.evaluate(async workspace => {
      const terminal = window.aether.terminal; const chunks: string[] = []; const exits: Array<{ id: string; exitCode: number }> = []
      const offData = terminal.onData(event => chunks.push(event.chunk)); const offExit = terminal.onExit(event => exits.push(event))
      let id = ''
      try {
        try { id = (await terminal.create({ cwd: workspace, cols: 80, rows: 24 })).id }
        catch (error) { return { creationError: String(error), chunks: '', exited: false } }
        await terminal.resize(id, 100, 30); await terminal.resize(id, 0, 0)
        await terminal.write(id, "Write-Output ('PLATFORM_' + 'PTY_OK'); exit 7\r")
        await new Promise<void>(resolve => { const deadline = Date.now() + 20000; const timer = setInterval(() => { if (exits.some(exit => exit.id === id) || Date.now() >= deadline) { clearInterval(timer); resolve() } }, 50) })
        return { creationError: '', chunks: chunks.join(''), exited: exits.some(exit => exit.id === id && exit.exitCode === 7) }
      } finally { if (id) { await terminal.dispose(id); await terminal.dispose(id) }; offData(); offExit() }
    }, workspace)
    if (result.creationError) {
      expect(result.creationError).toMatch(/Cannot launch conpty|spawn|EPERM|ENOENT|Access.*denied/i)
      test.info().annotations.push({ type: 'environment-capability', description: result.creationError })
      return
    }
    expect(result.chunks).toContain('PLATFORM_PTY_OK'); expect(result.exited).toBe(true)
  })
})




