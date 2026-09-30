import { createRequire } from 'node:module'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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
const graph = require('@colbymchenry/codegraph')
check(typeof graph.CodeGraph?.openSync === 'function', 'CodeGraph native module failed to load')
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
  sqlite: true, codegraph: true, pty: true, typescript: require('typescript').version,
  languageServer: languageServer.stdout.trim(), dependencies: Object.keys(pkg.dependencies).length, skillCount: stage.skillCount }))
