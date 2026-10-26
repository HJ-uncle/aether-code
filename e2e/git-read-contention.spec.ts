/** Native supervisor + real index: a Work write waits for a background reader,
 * while a competing writer is still rejected before any side effect. No UI. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import type * as Lease from '../src/main/git/repository-lease'

let fixture: string, lease: typeof Lease
const env = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)))
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: env(), windowsHide: true, encoding: 'utf8' })
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
test.beforeAll(async () => {
  test.skip(process.platform !== 'win32', 'Native Windows job supervisor')
  fixture = path.resolve('.e2e-tmp', 'git-read-contention-' + randomUUID())
  fs.mkdirSync(fixture, { recursive: true })
  // The product bundler resolves ?asset. Compile only these two isolated test
  // modules with the identical packaged native executable, leaving out/ alone.
  for (const name of ['repository-process', 'repository-lease']) {
    let source = fs.readFileSync(path.resolve('src/main/git', name + '.ts'), 'utf8')
    source = source.replace("import nativeSupervisorPath from './assets/repository-supervisor.exe?asset'", `const nativeSupervisorPath = ${JSON.stringify(path.resolve('src/main/git/assets/repository-supervisor.exe'))}`)
      .replace("'./repository-process.js'", "'./repository-process.mjs'")
    fs.writeFileSync(path.join(fixture, name + '.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)
  }
  lease = await import(pathToFileURL(path.join(fixture, 'repository-lease.mjs')).href)
})
test.afterAll(() => {
  if (!fixture) return
  if (!fixture.startsWith(path.resolve('.e2e-tmp') + path.sep) || !path.basename(fixture).startsWith('git-read-contention-')) throw new Error('Unsafe fixture cleanup')
  fs.rmSync(fixture, { recursive: true, force: true })
})
test('stage waits for the native reader to close, then writes the real index', async () => {
  const cwd = path.join(fixture, 'stage'); fs.mkdirSync(cwd); git(cwd, ['init'])
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'native read/write isolation\n')
  const file = path.join(cwd, '.git', '.aether-operation.lock'), entered = gate(), release = gate()
  const reader = lease.withRepositoryLease(file, async scope => {
    await scope.run('git', ['status', '--porcelain'], { cwd, env: env() })
    entered.release(); await release.promise
  }, 30_000, undefined, 'read')
  await entered.promise
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).access).toBe('read')
  const writer = lease.withRepositoryLease(file, scope => scope.run('git', ['add', '--', 'report.txt'], { cwd, env: env() }))
  const outcome = writer.then(value => ({ value }), error => ({ error }))
  expect(git(cwd, ['ls-files', '--stage'])).toBe('')
  release.release(); await reader
  const result = await outcome
  expect('error' in result ? String(result.error) : '').toBe('')
  expect(git(cwd, ['show', ':report.txt'])).toBe('native read/write isolation\n')
  expect(fs.existsSync(file)).toBe(false)
  const audit = JSON.parse(fs.readFileSync(file + '.last-audit.json', 'utf8'))
  expect(audit.proof).toMatchObject({ jobExists: false, supervisorAlive: false, empty: true })
})
test('competing writers and legacy leases remain fail-fast and do not stage', async () => {
  for (const legacy of [false, true]) {
    const cwd = path.join(fixture, legacy ? 'legacy' : 'writer'); fs.mkdirSync(cwd); git(cwd, ['init'])
    const file = path.join(cwd, '.git', '.aether-operation.lock')
    const held = await lease.acquireRepositoryLease(file)
    if (legacy) { const owner = JSON.parse(fs.readFileSync(file, 'utf8')); delete owner.access; fs.writeFileSync(file, JSON.stringify(owner)) }
    let dispatched = false
    try {
      await expect(lease.withRepositoryLease(file, async () => { dispatched = true })).rejects.toMatchObject({ code: 'GIT_REPOSITORY_BUSY', executionDisposition: 'not_started' })
      expect(dispatched).toBe(false); expect(git(cwd, ['ls-files', '--stage'])).toBe('')
    } finally { held.release() }
  }
})
test('a new writer replacing a reader cannot inherit the waiting allowance', async () => {
  const file = path.join(fixture, 'replacement.lock'), held = await lease.acquireRepositoryLease(file, 0, undefined, 'read')
  let dispatched = false
  const waiting = lease.acquireRepositoryLease(file).then(value => { dispatched = true; value.release(); return null }, error => error)
  const next = { ...held.owner, generation: randomUUID(), access: 'write' }
  next.jobName = 'Local\\AetherGit-' + next.generation
  fs.writeFileSync(file, JSON.stringify(next))
  try {
    expect(await waiting).toMatchObject({ code: 'GIT_REPOSITORY_BUSY', executionDisposition: 'not_started' })
    expect(dispatched).toBe(false); expect(JSON.parse(fs.readFileSync(file, 'utf8')).generation).toBe(next.generation)
  } finally { fs.unlinkSync(file) }
})
