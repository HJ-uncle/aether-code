/** Called as a real script or a local MCP server by the installed Windows build. */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [receipt, mode] = process.argv.slice(2)
const python = spawnSync('python', ['-c', 'import json, sys; print(json.dumps([sys.executable, sys.prefix, sys.base_prefix, list(sys.version_info[:3])]))'],
  { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
if (python.error || python.status !== 0) throw new Error(`Python failed: ${python.error?.message || python.stderr || python.status}`)
const [executable, prefix, basePrefix, version] = JSON.parse(python.stdout.trim())
// Both the real terminal and the stdio MCP must be able to start a bare git with the expected installation prefix.
const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim()
const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim()
writeFileSync(receipt, JSON.stringify({ node: process.execPath, nodeVersion: process.versions.node, python: { executable, prefix, basePrefix, version }, gitExecPath, gitVersion,
  ...(mode === 'shell' ? { npm: readFileSync(join(process.cwd(), 'npm-version.txt'), 'utf8').trim(), npx: readFileSync(join(process.cwd(), 'npx-version.txt'), 'utf8').trim() } : {}) }))
if (mode === 'mcp') {
  for await (const line of createInterface({ input: process.stdin })) {
    const req = JSON.parse(line)
    if (req.id === undefined) continue
    const result = req.method === 'initialize'
      ? { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'aether-offline-probe', version: '1.0.0' } }
      : { tools: [{ name: 'runtime_probe', description: 'Offline installation test', inputSchema: { type: 'object', properties: {} } }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
  }
}
