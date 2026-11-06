import { join, resolve } from 'node:path'

export function selectRuntimeEntry(options: {
  packaged: boolean
  resourcesPath: string
  appPath: string
  platform: string
  override?: string
  importedRoot?: string
}): { entryPath: string; source: 'env' | 'bundled' | 'dev-sibling' | 'imported' } {
  // A development launch pins its freshly built (or explicitly supplied) snapshot.
  if (!options.packaged && options.override) return { entryPath: resolve(options.override), source: 'env' }
  // Installed apps and development without a launcher override retain the selected import.
  if (options.importedRoot) return { entryPath: join(options.importedRoot, 'dist', 'main.js'), source: 'imported' }
  if (options.packaged) {
    return {
      entryPath: join(options.resourcesPath, 'engine', options.platform, 'dist', 'main.js'),
      source: 'bundled'
    }
  }
  return {
    entryPath: resolve(options.appPath, '..', 'ai-agent-engine', 'dist', 'main.js'),
    source: 'dev-sibling'
  }
}
