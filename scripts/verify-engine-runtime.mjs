import { createRequire } from 'node:module'
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(root, 'package.json'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const stage = JSON.parse(readFileSync(join(root, 'stage-manifest.json'), 'utf8'))
const check = (condition, message) => { if (!condition) throw new Error(message) }
check(process.execPath.toLowerCase() === join(root, 'runtime/node.exe').toLowerCase(), 'Smoke must use the bundled Node binary')
check(process.versions.node === stage.node.node, 'Bundled Node version does not match manifest')
for (const name of Object.keys(pkg.dependencies)) {
  const packageJson = join(root, 'node_modules', name, 'package.json')
  check(existsSync(packageJson), `Dependency missing from runtime: ${name}`)
  const rel = relative(root, packageJson)
  check(rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `Dependency escaped runtime: ${name}`)
}
const { createClient } = await import(pathToFileURL(join(root, 'node_modules/@libsql/client/lib-esm/node.js')).href)
const db = createClient({ url: 'file::memory:' })
try { check((await db.execute('SELECT 41 + 1 AS answer')).rows[0].answer === 42, 'SQLite native query failed') }
finally { db.close() }
// Verify the engine's shipped database adapter, including its native subprocess.
async function verifySqliteProcessRuntime() {
  const tempParent = realpathSync(tmpdir())
  const fixture = mkdtempSync(join(tempParent, 'aether-sqlite-runtime-smoke-'))
  const { LocalSqliteProcessClient } = await import(pathToFileURL(join(root, 'dist/storage/sqlite/local-process-client.js')).href)
  const url = pathToFileURL(join(fixture, 'adapter.db')).href
  const client = new LocalSqliteProcessClient({ url }, { cacheKb: 2048, mmapBytes: 0, busyTimeoutMs: 1500 })
  const bounded = async operation => {
    let timeout
    try { return await Promise.race([operation, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SQLite subprocess operation timed out')), 5000) })]) }
    finally { clearTimeout(timeout) }
  }
  const settings = async db => {
    const result = {}
    for (const key of ['journal_mode', 'synchronous', 'cache_size', 'mmap_size', 'busy_timeout', 'foreign_keys']) {
      result[key] = Object.values((await db.execute('PRAGMA ' + key)).rows[0])[0]
    }
    return result
  }
  let memoryDb
  let closeMemoryDb
  const oldDataDir = process.env.DATA_DIR
  try {
    const expected = { journal_mode: 'wal', synchronous: 1, cache_size: -2048, mmap_size: 0, busy_timeout: 1500, foreign_keys: 1 }
    check(JSON.stringify(await bounded(settings(client))) === JSON.stringify(expected), 'SQLite subprocess settings mismatch')
    await client.execute('CREATE TABLE checks(id INTEGER PRIMARY KEY, content TEXT, payload BLOB)')
    const tx = await client.transaction('write')
    const inserted = await tx.execute('INSERT INTO checks VALUES(?,?,?)', [1, '包内事务', Uint8Array.from([1, 2, 255])])
    check(inserted.lastInsertRowid === 1n, 'SQLite subprocess lost bigint row ID')
    const queued = client.execute('INSERT INTO checks VALUES(2,?,NULL)', ['queued'])
    await bounded(tx.commit())
    await bounded(queued)
    check(tx.closed, 'SQLite subprocess transaction retained ownership after commit')
    check(JSON.stringify(await settings(client)) === JSON.stringify(expected), 'SQLite subprocess lost PRAGMAs after commit')
    const row = (await client.execute('SELECT * FROM checks WHERE id=1')).rows[0]
    check(row.content === '包内事务' && row[1] === row.content && row.payload instanceof ArrayBuffer && Buffer.from(row.payload).toString('hex') === '0102ff', 'SQLite subprocess row/blob serialization failed')
    const rollback = await client.transaction('write')
    await rollback.execute('INSERT INTO checks VALUES(3,?,NULL)', ['rollback'])
    await rollback.rollback()
    await Promise.all(Array.from({ length: 5 }, async (_, lane) => {
      for (let step = 0; step < 10; step++) {
        const transaction = await client.transaction('write')
        try { await transaction.execute('INSERT INTO checks VALUES(?,?,NULL)', [10 + lane * 10 + step, 'parallel']); await transaction.commit() }
        finally { transaction.close() }
      }
    }))
    check((await client.execute('SELECT count(*) AS n FROM checks')).rows[0].n === 52, 'SQLite subprocess concurrency/rollback mismatch')
    client.close()
    await client.whenClosed()
    client.reconnect()
    check((await bounded(client.execute('PRAGMA quick_check'))).rows[0].quick_check === 'ok', 'SQLite subprocess database failed integrity check after reopen')
    check((await client.execute('SELECT count(*) AS n FROM checks')).rows[0].n === 52, 'SQLite subprocess persistence failed')

    process.env.DATA_DIR = join(fixture, 'agent.db')
    const memory = await import(pathToFileURL(join(root, 'dist/storage/memory/db.js')).href)
    const { MEMORY_SCHEMA } = await import(pathToFileURL(join(root, 'dist/storage/memory/schema.js')).href)
    const { SQLiteMemoryManager } = await import(pathToFileURL(join(root, 'dist/storage/memory/memory-manager.js')).href)
    closeMemoryDb = memory.closeMemoryDb
    await bounded(memory.initMemoryDb(MEMORY_SCHEMA))
    memoryDb = memory.getMemoryDb()
    const manager = new SQLiteMemoryManager()
    const global = { tenantId: 'runtime-smoke', scope: 'global', sessionId: '' }
    const scoped = { tenantId: 'runtime-smoke', scope: 'session', sessionId: 'runtime-session' }
    const created = await manager.createNode({ type: 'fact', summary: '包内记忆', tags: ['runtime'] }, scoped)
    check(await manager.getNode(created.id, global) === null, 'Memory session scope leaked into global scope')
    check((await manager.getNode(created.id, scoped)).tags.includes('runtime'), 'Memory create/read lost tags')
    check((await manager.updateNode(created.id, { summary: '已编辑', tags: ['edited'] }, scoped)).summary === '已编辑', 'Memory update failed')
    await manager.deleteNode(created.id, scoped)
    check(await manager.getNode(created.id, scoped) === null, 'Memory delete failed')
    check((await memoryDb.execute('PRAGMA quick_check')).rows[0].quick_check === 'ok', 'Memory database integrity failed')
    return { processIsolation: true, transactions: 50, commit: true, rollback: true, bigint: true, blob: true, pragmas: true, reopen: true, memoryCrud: true, memoryScope: true }
  } finally {
    client.close()
    await client.whenClosed()
    if (closeMemoryDb) await closeMemoryDb()
    if (oldDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = oldDataDir
    const cleanupPath = realpathSync(fixture)
    const child = relative(tempParent, cleanupPath)
    check(!lstatSync(fixture).isSymbolicLink() && child.startsWith('aether-sqlite-runtime-smoke-') && !child.includes(sep) && !isAbsolute(child), 'Unsafe SQLite smoke cleanup path')
    rmSync(cleanupPath, { recursive: true, force: true })
  }
}
const sqliteRuntime = await verifySqliteProcessRuntime()
// Exercise the shipped ESM loader: require() alone can pass while the engine's
// dynamic import fails to resolve a CommonJS package's CodeGraph export.
const { loadCodeGraph } = await import(pathToFileURL(join(root, 'dist/tools/codegraph/codegraph-module.js')).href)
const CodeGraph = await loadCodeGraph()
for (const method of ['init', 'openSync', 'isInitialized', 'recreate']) {
  check(typeof CodeGraph[method] === 'function', `CodeGraph API missing: ${method}`)
}
const tempRoot = realpathSync(tmpdir())
const graphFixture = mkdtempSync(join(tempRoot, 'aether-engine-runtime-smoke-'))
let graphInstance
try {
  writeFileSync(join(graphFixture, 'runtime-smoke.ts'),
    'export function aetherRuntimeSmoke(value: number): number { return value + 1 }\n', 'utf8')
  check(!CodeGraph.isInitialized(graphFixture), 'CodeGraph fixture must start without an index')
  graphInstance = await CodeGraph.init(graphFixture, { index: false })
  const indexed = await graphInstance.indexAll()
  check(indexed.success, `CodeGraph TypeScript indexing failed: ${JSON.stringify(indexed.errors ?? [])}`)
  check(CodeGraph.isInitialized(graphFixture), 'CodeGraph initialization did not persist')
  check(graphInstance.getIndexState() === 'complete', 'CodeGraph indexing did not complete')
  check(graphInstance.getStats().fileCount === 1, 'CodeGraph failed to index the fixture file')
  const hasFixtureSymbol = graph => graph.searchNodes('aetherRuntimeSmoke', { limit: 10 }).some(({ node }) =>
    node.name === 'aetherRuntimeSmoke' && node.kind === 'function' && basename(node.filePath) === 'runtime-smoke.ts')
  check(hasFixtureSymbol(graphInstance), 'CodeGraph could not find the indexed TypeScript function')
  graphInstance.close()
  graphInstance = undefined
  graphInstance = CodeGraph.openSync(graphFixture)
  check(graphInstance.getStats().fileCount === 1 && hasFixtureSymbol(graphInstance),
    'CodeGraph index could not be reopened with its persisted symbol')
} finally {
  try { graphInstance?.close() }
  finally {
    // Delete only this newly allocated fixture, after checking the resolved
    // path remains a direct child of the system temporary directory.
    const cleanupPath = realpathSync(graphFixture)
    const child = relative(tempRoot, cleanupPath)
    check(!lstatSync(graphFixture).isSymbolicLink() && child.startsWith('aether-engine-runtime-smoke-') &&
      !child.includes(sep) && !isAbsolute(child), `Unsafe CodeGraph fixture cleanup path: ${cleanupPath}`)
    rmSync(cleanupPath, { recursive: true, force: true })
  }
}
const pty = require('node-pty')
check(typeof pty.spawn === 'function', 'PTY native module failed to load')
require(join(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node'))
check(typeof require('typescript').createLanguageService === 'function', 'TypeScript API missing')
const cli = join(root, 'node_modules/typescript-language-server/lib/cli.mjs')
const languageServer = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
check(languageServer.status === 0, `TypeScript language server failed: ${languageServer.stderr}`)
check(existsSync(join(root, 'dist/terminal/workspace-shell.mjs')), 'workspace shell asset missing')
check(stage.skillCount > 0 && existsSync(join(root, 'SKILLs/skills.config.json')), 'bundled skills missing')
console.log(JSON.stringify({ verified: true, node: process.versions.node, abi: process.versions.modules, napi: process.versions.napi,
  sqlite: true, sqliteRuntime, codegraph: true, codegraphLifecycle: ['engine-esm-loader', 'typescript-index', 'symbol-search', 'database-reopen'],
  pty: true, typescript: require('typescript').version,
  languageServer: languageServer.stdout.trim(), dependencies: Object.keys(pkg.dependencies).length, skillCount: stage.skillCount }))
