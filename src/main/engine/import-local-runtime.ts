import { app } from 'electron'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createReadStream } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { extractTgz } from './tgz-extract'
import { parseEngineManifest } from './protocol'
import { getLocalRuntimeRoot, listLocalRuntimes } from './local-runtime-store'
import type { EngineImportProgress, EngineRuntimeInfo } from '../../shared/engine-import'

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024
const MAX_FILES = 1_000_000
const execute = promisify(execFile)

function progress(
  onProgress: (value: EngineImportProgress) => void,
  phase: EngineImportProgress['phase'],
  files: number,
  bytes: number,
  message: string
): void {
  onProgress({ phase, files, bytes, message })
}

function importErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' || /gzip|incorrect header|unexpected end of file|invalid block|invalid distance|incorrect data check/i.test(reason)) {
    return `引擎压缩包已损坏或不是有效的 .tgz 文件，请重新打包或下载（${reason}）`
  }
  if (error instanceof SyntaxError) return `引擎包中的 JSON 配置或构建清单无效（${reason}）`
  if (/[\u3400-\u9fff]/.test(reason)) return reason
  return `导入引擎失败：${reason}`
}

function copyTree(source: string, target: string): void {
  const info = lstatSync(source)
  if (info.isSymbolicLink()) throw new Error('引擎包不能包含符号链接')
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const child of readdirSync(source)) copyTree(join(source, child), join(target, child))
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
}

function inventory(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, child.name)
      const info = lstatSync(full)
      if (info.isSymbolicLink()) throw new Error('引擎包不能包含符号链接')
      if (info.isDirectory()) walk(full)
      else if (info.isFile()) {
        files++
        bytes += info.size
        if (files > MAX_FILES || bytes > MAX_EXTRACTED_BYTES) throw new Error('引擎包解压后超出大小限制')
      }
    }
  }
  walk(root)
  return { files, bytes }
}

function findTrustedTls(): string | null {
  const candidates = [
    join(process.resourcesPath, 'engine', `${process.platform}-${process.arch}`, 'node_modules', 'typescript-language-server'),
    ...(!app.isPackaged ? [
      join(app.getAppPath(), 'resources', 'engine', `${process.platform}-${process.arch}`, 'node_modules', 'typescript-language-server'),
      join(app.getAppPath(), 'node_modules', 'typescript-language-server')
    ] : [])
  ]
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json'))) ?? null
}

function ensureTrustedTls(packageRoot: string): void {
  const target = join(packageRoot, 'node_modules', 'typescript-language-server')
  if (existsSync(join(target, 'package.json'))) return
  const trusted = findTrustedTls()
  if (!trusted) throw new Error('客户端缺少受信任的 TypeScript Language Server，无法导入此引擎')
  copyTree(trusted, target)
}

function cleanProbeEnvironment(probeRoot: string, nodePath: string): NodeJS.ProcessEnv {
  // Package checks must not inherit model credentials, NODE_OPTIONS, user
  // configuration or the live engine database path from this process.
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    TEMP: probeRoot,
    TMP: probeRoot,
    HOME: probeRoot,
    USERPROFILE: probeRoot,
    APPDATA: probeRoot,
    LOCALAPPDATA: probeRoot,
    NODE_ENV: 'production',
    PATH: dirname(nodePath),
    AETHER_GLOBAL_DIR: probeRoot,
    SKILLS_ROOT: join(probeRoot, 'skills')
  }
}

async function copyTrustedNode(packageRoot: string, probeRoot: string): Promise<string> {
  const binary = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates = [
    join(process.resourcesPath, 'engine', `${process.platform}-${process.arch}`, 'runtime', binary),
    ...(!app.isPackaged ? [
      join(app.getAppPath(), 'resources', 'engine', `${process.platform}-${process.arch}`, 'runtime', binary),
      ...(process.env.AETHER_NODE_BINARY ? [resolve(process.env.AETHER_NODE_BINARY)] : []),
      ...(!process.versions.electron ? [process.execPath] : []),
      ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map((directory) => join(directory, binary))
    ] : [])
  ]
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue
    try {
      const { stdout } = await execute(candidate, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch})'], {
        cwd: probeRoot,
        env: cleanProbeEnvironment(probeRoot, candidate),
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 4096
      })
      const info = JSON.parse(stdout.trim()) as { node?: string; electron?: string; platform?: string; arch?: string }
      if (info.electron || info.platform !== process.platform || info.arch !== process.arch || Number(info.node?.split('.')[0] ?? 0) < 22) continue
      const destination = join(packageRoot, 'runtime', binary)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(candidate, destination)
      const license = join(dirname(candidate), 'LICENSE')
      if (existsSync(license)) copyFileSync(license, join(packageRoot, 'runtime', 'LICENSE'))
      return destination
    } catch { /* Try the next trusted client/developer Node distribution. */ }
  }
  throw new Error('客户端缺少可用的独立 Node.js 运行时；请安装完整客户端，开发环境可设置 AETHER_NODE_BINARY')
}

async function verifyNativeModules(packageRoot: string, nodePath: string, probeRoot: string): Promise<void> {
  const probe = join(probeRoot, 'verify-runtime.mjs')
  const source = `
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const require = createRequire(join(root, 'package.json'));
const check = (value, message) => { if (!value) throw new Error(message); };
const { createClient } = await import(pathToFileURL(join(root, 'node_modules/@libsql/client/lib-esm/node.js')).href);
const db = createClient({url:'file::memory:'});
try { check((await db.execute('SELECT 41 + 1 AS answer')).rows[0].answer === 42, 'SQLite'); } finally { db.close(); }
const { loadCodeGraph } = await import(pathToFileURL(join(root, 'dist/tools/codegraph/codegraph-module.js')).href);
const CodeGraph = await loadCodeGraph();
for (const method of ['init','openSync','isInitialized','recreate']) check(typeof CodeGraph[method] === 'function', 'CodeGraph');
check(typeof require('node-pty').spawn === 'function', 'PTY');
require(join(root,'node_modules/node-pty/prebuilds/win32-x64/conpty.node'));
check(typeof require('typescript').createLanguageService === 'function', 'TypeScript');
console.log('AETHER_RUNTIME_VERIFIED');
`
  writeFileSync(probe, source, 'utf8')
  try {
    const { stdout } = await execute(nodePath, [probe, packageRoot], {
      cwd: probeRoot,
      env: cleanProbeEnvironment(probeRoot, nodePath),
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 64 * 1024
    })
    if (!stdout.includes('AETHER_RUNTIME_VERIFIED')) throw new Error('Runtime verification failed')
    await execute(nodePath, [join(packageRoot, 'node_modules/typescript-language-server/lib/cli.mjs'), '--version'], {
      cwd: probeRoot,
      env: cleanProbeEnvironment(probeRoot, nodePath),
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 16 * 1024
    })
  } catch {
    throw new Error('引擎原生依赖或语言服务校验失败，请选择与当前 Windows x64 客户端匹配的完整引擎包')
  }
}

function cleanupStage(stage: string, userData: string): void {
  const parent = resolve(userData, 'engine', 'runtimes')
  const child = relative(parent, resolve(stage))
  if (!child.startsWith('.import-') || child.includes(sep) || isAbsolute(child) || lstatSync(stage).isSymbolicLink()) {
    throw new Error('导入临时目录路径无效，未执行清理')
  }
  rmSync(stage, { recursive: true, force: true })
}

function assertRequiredFiles(packageRoot: string): void {
  const required = [
    'dist/main.js',
    'dist/runtime/build-manifest.json',
    'dist/terminal/workspace-shell.mjs',
    'SKILLs/skills.config.json',
    'node_modules/@libsql/client/package.json',
    'node_modules/@colbymchenry/codegraph/package.json',
    'node_modules/node-pty/package.json',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    'node_modules/typescript/package.json',
    'node_modules/typescript-language-server/package.json'
  ]
  for (const item of required) if (!existsSync(join(packageRoot, item))) throw new Error(`引擎包缺少必需文件：${item}`)
  let skills = 0
  const visit = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, child.name)
      if (child.isDirectory()) visit(full)
      else if (child.isFile() && child.name === 'SKILL.md') skills++
    }
  }
  visit(join(packageRoot, 'SKILLs'))
  if (!skills) throw new Error('引擎包没有可用技能资源')
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

/** Import an immutable engine artifact; activation and process start belong to EngineHost/IPC. */
export async function importLocalRuntime(
  filePath: string,
  onProgress: (value: EngineImportProgress) => void
): Promise<EngineRuntimeInfo> {
  const userData = app.getPath('userData')
  let stage = ''
  let files = 0
  let bytes = 0
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前本地引擎包导入支持 Windows x64 客户端')
    const artifact = lstatSync(filePath)
    if (!artifact.isFile() || artifact.isSymbolicLink()) throw new Error('引擎包路径不是普通文件')
    if (artifact.size <= 0 || artifact.size > MAX_ARCHIVE_BYTES) throw new Error('引擎包大小不在允许范围内')
    const digest = await sha256(filePath)
    const id = `runtime-${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`
    const existing = listLocalRuntimes(userData).find((runtime) => runtime.id === id)
    if (existing) {
      progress(onProgress, 'ready', 0, artifact.size, '此引擎版本已经导入')
      return existing
    }
    const runtimes = join(userData, 'engine', 'runtimes')
    mkdirSync(runtimes, { recursive: true })
    stage = mkdtempSync(join(runtimes, '.import-'))
    progress(onProgress, 'extracting', 0, 0, '正在解包引擎…')
    let lastProgressAt = Date.now()
    await extractTgz(filePath, stage, {
      limits: { maxExpandedBytes: MAX_EXTRACTED_BYTES, maxEntries: MAX_FILES },
      onProgress: (value) => {
        files = value.files
        bytes = value.bytes
        if (files > MAX_FILES || bytes > MAX_EXTRACTED_BYTES) throw new Error('引擎包解压后超出大小限制')
        const now = Date.now()
        if (now - lastProgressAt >= 100) {
          progress(onProgress, 'extracting', files, bytes, '正在解包引擎…')
          lastProgressAt = now
        }
      }
    })
    const packageRoot = join(stage, 'package')
    if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) throw new Error('引擎包缺少 package 根目录')
    ensureTrustedTls(packageRoot)
    progress(onProgress, 'validating', files, bytes, '正在校验引擎完整性…')
    const totals = inventory(packageRoot)
    files = totals.files
    bytes = totals.bytes
    assertRequiredFiles(packageRoot)
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    const manifest = parseEngineManifest(JSON.parse(readFileSync(join(packageRoot, 'dist/runtime/build-manifest.json'), 'utf8')))
    if (typeof pkg.name !== 'string' || !pkg.name.trim()) throw new Error('引擎包缺少 package.json name 配置')
    if (typeof pkg.version !== 'string' || pkg.version !== manifest.version) throw new Error('引擎包版本与构建清单不一致')
    // Only runtime assets survive installation. Archive configuration, .env and
    // state files never replace the user's existing engine preferences or DB.
    const readyRoot = join(stage, 'ready')
    mkdirSync(readyRoot)
    for (const child of ['dist', 'node_modules', 'SKILLs']) renameSync(join(packageRoot, child), join(readyRoot, child))
    // Keep the package name from the artifact so older installations can also
    // recover the configured display name from their installed package.
    writeFileSync(join(readyRoot, 'package.json'), JSON.stringify({ name: pkg.name.trim(), version: manifest.version, type: 'module', private: true }, null, 2) + '\n')
    const probeRoot = join(stage, 'probe')
    mkdirSync(probeRoot)
    const nodePath = await copyTrustedNode(readyRoot, probeRoot)
    progress(onProgress, 'validating', files, bytes, '正在校验 Node、原生依赖和语言服务…')
    await verifyNativeModules(readyRoot, nodePath, probeRoot)
    const finalRoot = getLocalRuntimeRoot(userData, id)
    const importedAt = Date.now()
    const info: EngineRuntimeInfo = {
      id,
      name: pkg.name.trim(),
      version: manifest.version,
      buildId: manifest.buildId,
      fileName: basename(filePath),
      importedAt
    }
    writeFileSync(join(readyRoot, 'runtime-info.json'), JSON.stringify(info, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    if (existsSync(finalRoot)) throw new Error('同一引擎版本正在被占用，请稍后重试')
    renameSync(readyRoot, finalRoot)
    cleanupStage(stage, userData)
    stage = ''
    progress(onProgress, 'ready', files, bytes, '引擎已导入，可在运行方式中启用')
    return info
  } catch (error) {
    let message = importErrorMessage(error)
    if (stage && existsSync(stage)) {
      try { cleanupStage(stage, userData) }
      catch (cleanupError) { message += `；临时文件清理失败：${importErrorMessage(cleanupError)}` }
    }
    progress(onProgress, 'error', files, bytes, message)
    throw new Error(message)
  }
}

