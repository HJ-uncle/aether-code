import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parseEngineManifest, type EngineManifest } from './protocol'
import { selectRuntimeEntry } from './runtime-location'
import { canImportLocalRuntime } from './runtime-import-support'
import { preparePackagedRuntime } from './packaged-runtime'
import { localToolchainEnvironment } from '../local-toolchains'
import { developmentRuntimeEnvironment } from './development-runtime'
import { getActiveRuntimeId, getLocalRuntimeRoot } from './local-runtime-store'

export interface ResolvedRuntime {
  nodePath: string
  entryPath: string
  root: string
  source: 'env' | 'bundled' | 'dev-sibling' | 'imported'
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
  const activeId = getActiveRuntimeId(app.getPath('userData'))
  const { entryPath, source } = selectRuntimeEntry({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: enginePlatform(),
    override: process.env.AETHER_IDE_ENGINE_ENTRY,
    importedRoot: activeId ? getLocalRuntimeRoot(app.getPath('userData'), activeId) : undefined
  })

  if (!existsSync(entryPath)) {
    if (source === 'env') throw new Error(`开发版找不到 AETHER_IDE_ENGINE_ENTRY 指定的引擎入口：${entryPath}`)
    if (source === 'imported') throw new Error('选用的本机引擎包不完整。请在「本机引擎 → 高级设置」切换到完整的版本。')
    return null
  }

  const manifestPath = join(dirname(entryPath), 'runtime', 'build-manifest.json')
  let manifest: EngineManifest
  try {
    manifest = parseEngineManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')))
  } catch {
    if (source === 'imported') throw new Error('选用的本机引擎包损坏或版本不兼容。请在高级设置中导入并选用配套版本。')
    if (source === 'bundled') throw new Error('内置引擎文件损坏或版本不兼容。请重新安装完整的 Aether 客户端，或连接其他引擎。')
    throw new Error(`开发版引擎构建信息缺失或不兼容，请重新构建配套引擎：${manifestPath}`)
  }
  const root = dirname(dirname(entryPath))
  const nodePath = source === 'bundled' || source === 'imported' ? join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath
  if (!existsSync(nodePath)) throw new Error(source === 'imported'
    ? '选用的本机引擎包缺少运行所需组件。请在高级设置中切换到完整的版本。'
    : '内置引擎缺少运行所需组件。请重新安装完整的 Aether 客户端，或连接其他引擎。')
  return {
    nodePath,
    entryPath,
    root,
    source,
    version: manifest.version,
    manifest
  }
}

/** The import path is only an option on a supported client with its own trusted Node runtime. */
export function requireLocalRuntime(): ResolvedRuntime {
  const runtime = resolveRuntime()
  if (runtime) return runtime
  const external = '也可以在「引擎管理」选择「连接其他引擎」。'
  const canImport = canImportLocalRuntime()
  if (!app.isPackaged) {
    const importHint = canImport ? '可在「本机引擎 → 高级设置」导入并选用配套引擎包。' : ''
    throw new Error('未找到本机引擎。' + importHint + external + '开发版还可重新构建配套引擎或检查 AETHER_IDE_ENGINE_ENTRY。')
  }
  throw new Error(canImport ? '未找到本机引擎。请在「本机引擎 → 高级设置」导入并选用配套的 .tgz 引擎包。' + external
    : '此客户端缺少本机引擎所需组件，请安装包含本机引擎的完整 Aether 客户端。' + external)
}

export function runtimeEnvironment(runtime: ResolvedRuntime): { cwd: string; env: Record<string, string> } {
  const standalone = runtime.source === 'bundled' || runtime.source === 'imported'
  const config = standalone
    ? preparePackagedRuntime(runtime.root, app.getPath('userData'))
    : developmentRuntimeEnvironment(runtime.entryPath, app.getPath('userData'), process.env.WORKSPACE_ROOT)
  return { cwd: config.cwd, env: {
    ...config.env, ...localToolchainEnvironment('engine', standalone ? runtime.nodePath : undefined),
    // The engine and its internal services use the pinned executable independently of project commands.
    ...(standalone ? { AETHER_ENGINE_NODE: runtime.nodePath } : { ELECTRON_RUN_AS_NODE: '1' })
  } }
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
  const config = runtimeEnvironment(runtime)
  try {
    await promisify(execFile)(
      runtime.nodePath,
      [entry, '--source-db', source, '--dest-db', engineDataFile()],
      {
        cwd: config.cwd,
        env: { ...process.env, ...config.env, ENCRYPTION_KEY: encryptionKey },
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
