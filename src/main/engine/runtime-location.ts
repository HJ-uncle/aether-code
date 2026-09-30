import { join, resolve } from 'node:path'

export function selectRuntimeEntry(options: {
  packaged: boolean
  resourcesPath: string
  appPath: string
  platform: string
  override?: string
  importedRoot?: string
}): { entryPath: string; source: 'env' | 'bundled' | 'dev-sibling' | 'imported' } {
  // An explicitly selected imported version must also take effect in development.
  if (options.importedRoot) return { entryPath: join(options.importedRoot, 'dist', 'main.js'), source: 'imported' }
  if (options.packaged) {
    return {
      entryPath: join(options.resourcesPath, 'engine', options.platform, 'dist', 'main.js'),
      source: 'bundled'
    }
  }
  if (options.override) return { entryPath: resolve(options.override), source: 'env' }
  return {
    entryPath: resolve(options.appPath, '..', 'ai-agent-engine', 'dist', 'main.js'),
    source: 'dev-sibling'
  }
}
