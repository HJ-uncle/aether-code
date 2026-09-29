/**
 * 引擎运行时定位与安装
 *
 * 双轨交付（内置 + 可下载）在这里落地。入口解析优先级：
 *
 *   1. 环境变量 AETHER_IDE_ENGINE_ENTRY —— 显式覆盖，开发调试用
 *   2. <userData>/engine/<version>/dist/main.js —— 已安装（CDN 下载或本地包解压）
 *   3. <resources>/engine/<platform>/dist/main.js —— 安装包内置的保底版本
 *   4. <仓库同级>/ai-agent-engine/dist/main.js —— 开发期使用当前源码构建
 *      缺失时再回退 sdk-package/bin/dist/main.js
 *
 * 之所以把「已安装」排在「内置」之前：内置版本永不覆盖，只作兜底；
 * 用户升级后应优先使用新版，出问题时可回滚到内置。
 *
 * 入口固定为 dist/main.js 而非根目录 main.js —— 后者是打包脚本的副产物，
 * 其相对导入（./api/...）在根目录下无法解析，直接运行会失败。
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { extractTgz } from './tgz-extract'

/** 与发布包/PORT 默认值保持一致 */
export const DEFAULT_ENGINE_VERSION = '1.0.0'

export interface ResolvedRuntime {
  /** 引擎入口脚本绝对路径 */
  entryPath: string
  /** 运行时根目录 */
  root: string
  /** 来源，用于状态展示与排障 */
  source: 'env' | 'installed' | 'bundled' | 'dev-sibling'
  version: string
}

export function enginePlatform(): string {
  return `${process.platform}-${process.arch}`
}

/** 已安装运行时的目录：<userData>/engine/<version> */
export function installedDir(version: string = DEFAULT_ENGINE_VERSION): string {
  return join(app.getPath('userData'), 'engine', version)
}

/** 引擎数据目录（SQLite 文件路径）。与运行时分离，升级引擎不丢数据。 */
export function engineDataFile(version: string = DEFAULT_ENGINE_VERSION): string {
  return join(installedDir(version), 'data', 'agent.db')
}

/** 校验一个运行时根目录是否真的可运行 */
function entryOf(root: string): string | null {
  const entry = join(root, 'dist', 'main.js')
  return existsSync(entry) ? entry : null
}

function makeRuntime(
  entryPath: string,
  source: ResolvedRuntime['source'],
  version = DEFAULT_ENGINE_VERSION
): ResolvedRuntime {
  return { entryPath, root: dirname(dirname(entryPath)), source, version }
}

/**
 * 按优先级解析可用运行时。全部落空时返回 null，调用方应触发安装流程。
 */
export function resolveRuntime(): ResolvedRuntime | null {
  // 1. 显式覆盖
  const override = process.env.AETHER_IDE_ENGINE_ENTRY
  if (override && existsSync(override)) {
    return makeRuntime(override, 'env')
  }

  // 2. 已安装
  const installed = entryOf(installedDir())
  if (installed) return makeRuntime(installed, 'installed')

  // 3. 安装包内置
  if (app.isPackaged) {
    const bundled = entryOf(join(process.resourcesPath, 'engine', enginePlatform()))
    if (bundled) return makeRuntime(bundled, 'bundled')
  }

  // 同级引擎源码修复后，优先用 npm run build 的产物，避免继续启动旧 SDK 副本。
  const engineRoot = resolve(app.getAppPath(), '..', 'ai-agent-engine')
  for (const entry of [
    join(engineRoot, 'dist', 'main.js'),
    join(engineRoot, 'sdk-package', 'bin', 'dist', 'main.js')
  ]) {
    if (existsSync(entry)) return makeRuntime(entry, 'dev-sibling')
  }

  return null
}

export interface InstallProgress {
  stage: 'extracting' | 'done'
  files: number
  bytes: number
}

/**
 * 从本地 .tgz 安装运行时到 <userData>/engine/<version>。
 *
 * 这是 CDN 下载路径的共用后半段：下载完成后同样调用本函数，
 * 因此本地包安装与联网安装的落盘结果完全一致。
 *
 * 幂等：目标目录已存在且入口可运行时直接返回，不重复解压。
 * 原子性：解压到临时目录后改名，避免中途失败留下半成品。
 */
export async function installFromTgz(
  tgzPath: string,
  version: string = DEFAULT_ENGINE_VERSION,
  onProgress?: (progress: InstallProgress) => void
): Promise<ResolvedRuntime> {
  const finalDir = installedDir(version)

  const existing = entryOf(finalDir)
  if (existing) return makeRuntime(existing, 'installed', version)

  const stagingDir = `${finalDir}.staging`
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  try {
    // 发布包内部以 package/ 为前缀，解压后取出该层
    await extractTgz(tgzPath, stagingDir, {
      onProgress: (p) => onProgress?.({ stage: 'extracting', files: p.files, bytes: p.bytes })
    })

    const packagedDir = join(stagingDir, 'package')
    const root = entryOf(packagedDir) ? packagedDir : stagingDir

    if (!entryOf(root)) {
      throw new Error(`解压后未找到 dist/main.js，包结构可能已变更（tgz: ${tgzPath}）`)
    }

    await rm(finalDir, { recursive: true, force: true })
    await mkdir(dirname(finalDir), { recursive: true })
    const { rename } = await import('node:fs/promises')
    await rename(root, finalDir)
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }

  const entry = entryOf(finalDir)
  if (!entry) throw new Error('安装完成但入口不可用')
  onProgress?.({ stage: 'done', files: 0, bytes: 0 })
  return makeRuntime(entry, 'installed', version)
}
