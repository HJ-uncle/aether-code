import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parseEngineManifest, type EngineManifest } from './protocol'
import { selectRuntimeEntry } from './runtime-location'

export interface ResolvedRuntime {
  entryPath: string
  root: string
  source: 'env' | 'bundled' | 'dev-sibling'
  version: string
  manifest: EngineManifest
}

export function enginePlatform(): string {
  return `${process.platform}-${process.arch}`
}

/** State belongs to this installation, never to a replaceable runtime version. */
export function engineDataFile(): string {
  return join(app.getPath('userData'), 'engine', 'state', 'agent.db')
}

export function legacyEngineDataFile(): string {
  return join(app.getPath('userData'), 'engine', '1.0.0', 'data', 'agent.db')
}

/** Packaged applications must be self-contained; developer overrides only apply in development. */
export function resolveRuntime(): ResolvedRuntime | null {
  const { entryPath, source } = selectRuntimeEntry({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: enginePlatform(),
    override: process.env.AETHER_IDE_ENGINE_ENTRY
  })

  if (!existsSync(entryPath)) {
    if (source === 'env') throw new Error(`显式指定的引擎入口不存在：${entryPath}`)
    return null
  }

  const manifestPath = join(dirname(entryPath), 'runtime', 'build-manifest.json')
  let manifest: EngineManifest
  try {
    manifest = parseEngineManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')))
  } catch {
    throw new Error(`引擎构建信息缺失或不兼容，请重新构建配套引擎：${manifestPath}`)
  }
  return {
    entryPath,
    root: dirname(dirname(entryPath)),
    source,
    version: manifest.version,
    manifest
  }
}

/** The engine owns the schema and success marker; retrying never imports conversation history. */
export async function migrateLegacyModels(
  runtime: ResolvedRuntime,
  encryptionKey: string,
  signal: AbortSignal
): Promise<void> {
  const source = legacyEngineDataFile()
  if (!existsSync(source)) return
  const entry = join(dirname(runtime.entryPath), 'storage', 'dev-migration.js')
  if (!existsSync(entry)) throw new Error('引擎缺少开发模型配置迁移入口，请重新构建引擎')
  try {
    await promisify(execFile)(
      process.execPath,
      [entry, '--source-db', source, '--dest-db', engineDataFile()],
      {
        cwd: dirname(runtime.entryPath),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ENCRYPTION_KEY: encryptionKey },
        signal,
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 64 * 1024
      }
    )
  } catch {
    signal.throwIfAborted()
    // execFile errors include stdout/stderr; never forward credential-related process output to IPC.
    throw new Error('旧模型配置迁移失败，原数据库和密钥已保留；请检查引擎迁移入口后重试')
  }
}
