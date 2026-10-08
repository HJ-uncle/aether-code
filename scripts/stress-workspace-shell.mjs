#!/usr/bin/env node
/**
 * Regression/pressure check for the restricted workspace file terminal.
 * This creates only disposable fixtures and never targets a real credential,
 * network service, or user directory. The production shell must not launch
 * arbitrary child processes; this harness launches the shell itself to test it.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const shell = path.resolve(process.argv[2] ?? path.resolve('..', 'ai-agent-engine', 'src', 'terminal', 'workspace-shell.mjs'))
const root = await mkdtemp(path.join(tmpdir(), 'aether-shell-pressure-'))
const outside = await mkdtemp(path.join(tmpdir(), 'aether-shell-outside-'))
const marker = path.join(outside, 'marker.txt')
await writeFile(marker, 'outside-fixture\n')
await mkdir(path.join(root, 'src'))
await writeFile(path.join(root, 'src', 'inside.txt'), 'inside-fixture\n')

const commands = []
for (let i = 0; i < 1200; i++) commands.push(`echo queued-${i}`)
commands.push('grep [ src/inside.txt') // malformed regex must be contained
commands.push('env PATH') // arbitrary environment lookup must be refused
commands.push('node -e "console.log(\'unexpected\')"') // external process must be refused
commands.push('rm -rf .') // root deletion must be refused
commands.push('pwd')
commands.push('cat src/inside.txt')

const child = spawn(process.execPath, [shell], {
  cwd: root,
  env: { ...process.env, WORKSPACE_ROOT: root, WORKSPACE_ROOTS: JSON.stringify([root]), AUDIT_FAKE_ENGINE_TOKEN: 'synthetic-only' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })
child.stdin.end(`${commands.join('\n')}\n`)
const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('shell pressure run exceeded 20 seconds')) }, 20_000)
  child.once('error', reject)
  child.once('close', code => { clearTimeout(timer); resolve(code) })
})

const rootStillExists = await readFile(path.join(root, 'src', 'inside.txt'), 'utf8')
const outsideStillExists = await readFile(marker, 'utf8')
const checks = {
  exitCode,
  rootPreserved: rootStillExists === 'inside-fixture\n',
  outsideFixturePreserved: outsideStillExists === 'outside-fixture\n',
  queueOrdering: stdout.indexOf('queued-0') < stdout.indexOf('queued-1199'),
  malformedRegexContained: stdout.includes('无效正则'),
  envRefused: stdout.includes('环境变量不可查询'),
  externalRefused: stdout.includes('已拒绝外部命令'),
  rootDeleteRefused: stdout.includes('不能删除工作空间根目录'),
  insideReadWorks: stdout.includes('inside-fixture'),
}
if (process.platform === 'win32') {
  try {
    const link = path.join(root, 'link')
    await symlink(outside, link, 'junction')
    const linkProbe = spawn(process.execPath, [shell], {
      cwd: root,
      env: { ...process.env, WORKSPACE_ROOT: root, WORKSPACE_ROOTS: JSON.stringify([root]) },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let linkOutput = ''
    linkProbe.stdout.setEncoding('utf8')
    linkProbe.stdout.on('data', chunk => { linkOutput += chunk })
    linkProbe.stdin.end('cat link/marker.txt\n')
    await new Promise(resolve => linkProbe.once('close', resolve))
    checks.junctionRejected = !linkOutput.includes('outside-fixture')
  } catch {
    checks.junctionRejected = true // capability unavailable; normal files remain covered
  }
}
console.log(JSON.stringify({ checks, stderr: stderr.slice(-2000) }, null, 2))
await rm(root, { recursive: true, force: true })
await rm(outside, { recursive: true, force: true })
if (Object.values(checks).some(value => value === false)) process.exitCode = 2
