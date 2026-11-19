import { app } from 'electron'
import { lstatSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/** Packaged apps only trust the Node distribution from their own installation. */
export function trustedNodeCandidates(): string[] {
  const binary = process.platform === 'win32' ? 'node.exe' : 'node'
  return [...new Set([
    join(process.resourcesPath, 'engine', `${process.platform}-${process.arch}`, 'runtime', binary),
    ...(!app.isPackaged ? [
      join(app.getAppPath(), 'resources', 'engine', `${process.platform}-${process.arch}`, 'runtime', binary),
      ...(process.env.AETHER_NODE_BINARY ? [resolve(process.env.AETHER_NODE_BINARY)] : []),
      ...(!process.versions.electron ? [process.execPath] : []),
      ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map((directory) => join(directory, binary))
    ] : [])
  ])]
}

/** Only a file check; the importer verifies the selected binary and archive before installation. */
export function canImportLocalRuntime(): boolean {
  if (process.platform !== 'win32' || process.arch !== 'x64') return false
  return trustedNodeCandidates().some(file => {
    try { return lstatSync(file, { throwIfNoEntry: false })?.isFile() === true } catch { return false }
  })
}
