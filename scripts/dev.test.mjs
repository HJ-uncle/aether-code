import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { prepareDevEngine, startDev } from './dev.mjs'

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'aether-dev-contract-'))
  t.after(() => { if (dirname(parent) !== resolve(tmpdir()) || !parent.startsWith(join(resolve(tmpdir()), 'aether-dev-contract-'))) throw new Error('fixture cleanup boundary'); rmSync(parent, { recursive: true, force: true }) })
  const root = join(parent, 'client'), engine = join(parent, 'ai-agent-engine'); mkdirSync(root); mkdirSync(engine)
  const write = (name, data = 'asset') => { const file = join(engine, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data) }
  write('package.json', JSON.stringify({ type: 'module', version: 'test' })); write('dist/main.js', 'RUNNING SHARED DIST')
  for (const path of ['src/terminal/workspace-shell.mjs', 'src/workspace/assets/repository-supervisor.exe', 'src/workspace/assets/repository-supervisor.sha256', 'src/workspace/assets/repository-supervisor.cs', 'src/skills/builtin/test/SKILL.md', 'node_modules/node-pty/.aether-node-pty-patch.json']) write(path)
  const manifest = { buildId: 'sha256:' + 'a'.repeat(64), version: 'test', protocolVersion: 1, subagentSchemaVersion: 1, toolProfiles: ['general', 'code'] }
  const calls = [], runs = async (binary, args, options) => {
    calls.push({ binary, args, options })
    const index = args.indexOf('--outDir')
    if (index >= 0) { mkdirSync(args[index + 1], { recursive: true }); writeFileSync(join(args[index + 1], 'main.js'), 'FRESH ISOLATED OUTPUT') }
  }
  return { parent, root, engine, manifest, calls, run: runs, options: { root, env: {}, run: runs, loadManifest: async () => () => structuredClone(manifest), log: () => {} } }
}
test('development prepares distinct immutable outputs, never rewrites running sibling dist and only checks native patch', async t => {
  const f = fixture(t), first = await prepareDevEngine(f.options), second = await prepareDevEngine(f.options)
  assert.notEqual(first.entryPath, second.entryPath)
  assert.equal(readFileSync(join(f.engine, 'dist/main.js'), 'utf8'), 'RUNNING SHARED DIST')
  assert.equal(readFileSync(first.entryPath, 'utf8'), 'FRESH ISOLATED OUTPUT')
  assert.equal(readFileSync(join(dirname(first.entryPath), 'skills/builtin/test/SKILL.md'), 'utf8'), 'asset')
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(first.entryPath), 'runtime/build-manifest.json'), 'utf8')), f.manifest)
  assert.equal(first.environment.AETHER_IDE_ENGINE_ENTRY, first.entryPath)
  assert.equal(f.calls.filter(call => call.args.includes('--check')).length, 4)
  assert.equal(f.calls.filter(call => call.args.includes('--outDir')).length, 2)
})
test('explicit valid engine entry bypasses compilation and retains its selected manifest', async t => {
  const f = fixture(t), entryPath = join(f.engine, 'dist/main.js'); mkdirSync(join(f.engine, 'dist/runtime'))
  writeFileSync(join(f.engine, 'dist/runtime/build-manifest.json'), JSON.stringify(f.manifest))
  const result = await prepareDevEngine({ ...f.options, env: { AETHER_IDE_ENGINE_ENTRY: entryPath } })
  assert.equal(result.source, 'override'); assert.equal(result.entryPath, entryPath); assert.equal(f.calls.length, 0)
})
test('invalid explicit entry fails instead of silently building or falling back to shared dist', async t => {
  const f = fixture(t)
  await assert.rejects(prepareDevEngine({ ...f.options, env: { AETHER_IDE_ENGINE_ENTRY: join(f.engine, 'missing/main.js') } }), /ENOENT/)
  assert.equal(f.calls.length, 0)
})
test('source change during compilation leaves no certifying manifest and never starts the client', async t => {
  const f = fixture(t); let reads = 0
  await assert.rejects(prepareDevEngine({ ...f.options, loadManifest: async () => () => ({ ...f.manifest, buildId: 'sha256:' + (++reads === 1 ? 'a' : 'b').repeat(64) }) }), /源码发生变化/)
  const folder = readdirSync(join(f.engine, '.tmp/aether-code-dev'))[0]
  assert.equal(existsSync(join(f.engine, '.tmp/aether-code-dev', folder, 'dist/runtime/build-manifest.json')), false)
  assert.equal(readFileSync(join(f.engine, 'dist/main.js'), 'utf8'), 'RUNNING SHARED DIST')
})
test('compiler failure stops startup without certifying partial output', async t => {
  const f = fixture(t)
  await assert.rejects(prepareDevEngine({ ...f.options, run: async (...args) => { await f.run(...args); if (args[1].includes('--outDir')) throw new Error('compile failed') } }), /compile failed/)
  const folder = readdirSync(join(f.engine, '.tmp/aether-code-dev'))[0]
  assert.equal(existsSync(join(f.engine, '.tmp/aether-code-dev', folder, 'dist/runtime/build-manifest.json')), false)
})
test('single dev command passes pinned engine to electron-vite and forwards user arguments', async t => {
  const f = fixture(t), cli = join(f.root, 'node_modules/electron-vite/bin/electron-vite.js'); mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, '')
  const entryPath = join(f.engine, '.tmp/fresh/dist/main.js'), calls = []
  await startDev({ root: f.root, env: { TEST_SENTINEL: 'kept' }, args: ['--host'], prepare: async () => ({ environment: { AETHER_IDE_ENGINE_ENTRY: entryPath } }), run: async (...args) => calls.push(args) })
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][1], [cli, 'dev', '--host'])
  assert.deepEqual(calls[0][2].env, { TEST_SENTINEL: 'kept', AETHER_IDE_ENGINE_ENTRY: entryPath })
})
test('prepare-only validates the build without launching Electron or an engine', async t => {
  const f = fixture(t); let calls = 0
  const result = await startDev({ root: f.root, args: ['--prepare-only'], prepare: async () => ({ entryPath: 'prepared' }), run: async () => { calls++ } })
  assert.equal(result.entryPath, 'prepared'); assert.equal(calls, 0)
})
