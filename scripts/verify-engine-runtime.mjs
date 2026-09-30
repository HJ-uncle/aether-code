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
  sqlite: true, codegraph: true, codegraphLifecycle: ['engine-esm-loader', 'typescript-index', 'symbol-search', 'database-reopen'],
  pty: true, typescript: require('typescript').version,
  languageServer: languageServer.stdout.trim(), dependencies: Object.keys(pkg.dependencies).length, skillCount: stage.skillCount }))
