/** Metadata and progress shared by the main process and settings view. */
export interface EngineRuntimeInfo {
  /** Immutable id derived from the archive digest. */
  id: string
  /** Name declared by the runtime package.json. */
  name: string
  version: string
  buildId: string
  fileName: string
  importedAt: number
}

export type EngineImportPhase = 'idle' | 'extracting' | 'validating' | 'ready' | 'error'

export interface EngineImportProgress {
  phase: EngineImportPhase
  files: number
  bytes: number
  message: string
}

export interface EngineRuntimeCatalog {
  activeId: string | null
  runtimes: EngineRuntimeInfo[]
}
