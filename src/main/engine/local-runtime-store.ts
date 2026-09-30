import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path'
import type { EngineRuntimeInfo } from '../../shared/engine-import'

const RUNTIMES_DIR = 'runtimes'
const POINTER_FILE = 'active-runtime.json'
const METADATA_FILE = 'runtime-info.json'

function runtimesRoot(userData: string): string {
  return join(resolve(userData), 'engine', RUNTIMES_DIR)
}

function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{7,127}$/.test(id)
}

function readInfo(file: string): EngineRuntimeInfo | null {
  try {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<EngineRuntimeInfo>
    if (
      typeof value.id !== 'string' || !validId(value.id) ||
      typeof value.version !== 'string' || !value.version.trim() ||
      typeof value.buildId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.buildId) ||
      typeof value.fileName !== 'string' || !value.fileName.trim() ||
      typeof value.importedAt !== 'number' || !Number.isFinite(value.importedAt)
    ) return null
    // Older imports did not persist the package name. Recover it from the
    // installed package before falling back to the archive filename.
    let name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : ''
    if (!name) {
      try {
        const pkg = JSON.parse(readFileSync(join(dirname(file), 'package.json'), 'utf8')) as { name?: unknown }
        if (typeof pkg.name === 'string' && pkg.name.trim()) name = pkg.name.trim()
      } catch {
        // Legacy metadata may not have a package manifest; the filename still
        // gives the user a stable way to identify the installed runtime.
      }
    }
    if (!name) name = value.fileName.trim()
    return { id: value.id, name, version: value.version, buildId: value.buildId, fileName: value.fileName, importedAt: value.importedAt }
  } catch {
    return null
  }
}

/** Remove an inactive imported runtime without touching the active pointer. */
export function removeLocalRuntime(userData: string, id: string): void {
  if (!validId(id)) throw new Error('无效的本地引擎标识')
  if (getActiveRuntimeId(userData) === id) throw new Error('当前使用的本地引擎不能删除，请先切换到默认引擎')
  const root = getLocalRuntimeRoot(userData, id)
  if (!existsSync(root)) throw new Error('本地引擎不存在或已删除')
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('本地引擎目录无效')
  rmSync(root, { recursive: true, force: true })
}

/** Installed runtime metadata is deliberately separate from engine state/database. */
export function listLocalRuntimes(userData: string): EngineRuntimeInfo[] {
  const root = runtimesRoot(userData)
  if (!existsSync(root)) return []
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  return names
    .filter((name) => validId(name))
    .map((name) => {
      try {
        const directory = lstatSync(join(root, name))
        if (!directory.isDirectory() || directory.isSymbolicLink()) return null
      } catch { return null }
      const info = readInfo(join(root, name, METADATA_FILE))
      return info?.id === name ? info : null
    })
    .filter((info): info is EngineRuntimeInfo => Boolean(info))
    .sort((a, b) => b.importedAt - a.importedAt)
}

export function getActiveRuntimeId(userData: string): string | null {
  const file = join(runtimesRoot(userData), POINTER_FILE)
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown }
    if (typeof value.id !== 'string' || !validId(value.id)) return null
    return listLocalRuntimes(userData).some((runtime) => runtime.id === value.id) ? value.id : null
  } catch {
    return null
  }
}

/** The pointer is replaced as one rename so a crash cannot leave a partial JSON document. */
export function setActiveRuntimeId(userData: string, id: string | null): void {
  const root = runtimesRoot(userData)
  mkdirSync(root, { recursive: true })
  if (id !== null) {
    if (!validId(id) || !listLocalRuntimes(userData).some((runtime) => runtime.id === id)) {
      throw new Error('本地引擎不存在或已损坏')
    }
  }
  const temporary = join(root, `.${POINTER_FILE}.${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify({ id }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    // If a filesystem refuses replacement, fail with the old selection intact.
    // Deleting it first would turn a failed switch into a silent reset to default.
    renameSync(temporary, join(root, POINTER_FILE))
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function getLocalRuntimeRoot(userData: string, id: string): string {
  if (!validId(id)) throw new Error('无效的本地引擎标识')
  const root = runtimesRoot(userData)
  const child = resolve(root, id)
  const suffix = relative(root, child)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('本地引擎路径越界')
  }
  return child
}

export function runtimeMetadataPath(userData: string, id: string): string {
  return join(getLocalRuntimeRoot(userData, id), METADATA_FILE)
}

