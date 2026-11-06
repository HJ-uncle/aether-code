import type { EngineSnapshot } from './ipc'
import type { BrowserNetworkQuery, BrowserNetworkList, BrowserNetworkDetail, BrowserNetworkDetailOptions } from './browser-network'
import type {
  BrowserAction, BrowserBoundsInput, BrowserContext, BrowserCreateInput, BrowserEvent,
  BrowserReadKind, BrowserSettings, BrowserSurfaceOwner, BrowserTabState, BrowserToolResult, BrowserLocalFileContent
} from './browser'

export const BROWSER_IPC = { invoke: 'browser:invoke', event: 'browser:event', connection: 'browser:connection' } as const

export interface BrowserConnectInput {
  sessionId: string
  presentationMode?: 'code' | 'work'
  expectedEngine: Pick<EngineSnapshot, 'mode' | 'baseUrl' | 'instanceId' | 'accountId'>
}

export interface BrowserConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  message?: string
  sessionId?: string
  engineId?: string
}

export interface BrowserFileOpenOptions {
  owner: BrowserSurfaceOwner
  /** Work workspace files use the engine's authenticated session root. */
  sessionId?: string
}

export interface BrowserApi {
  getHostZoomFactor(): number
  list(): Promise<BrowserTabState[]>
  create(input?: BrowserCreateInput): Promise<BrowserTabState>
  duplicate(tabId: string): Promise<BrowserTabState>
  action(input: BrowserAction): Promise<BrowserTabState>
  activateSurface(owner: BrowserSurfaceOwner): Promise<void>
  setBounds(input: BrowserBoundsInput): Promise<void>
  close(tabId: string): Promise<void>
  share(tabId: string, expectedContext: BrowserContext): Promise<BrowserTabState>
  getSettings(): Promise<BrowserSettings>
  updateSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings>
  clearData(): Promise<void>
  read(tabId: string, kind: BrowserReadKind): Promise<BrowserToolResult>
  network(tabId: string, query?: BrowserNetworkQuery): Promise<BrowserNetworkList>
  networkRequest(tabId: string, requestId: string, options?: BrowserNetworkDetailOptions): Promise<BrowserNetworkDetail>
  openFile(filePath: string, workspaceRoot: string, options?: BrowserFileOpenOptions): Promise<BrowserTabState>
  openLocalFile(path?: string): Promise<BrowserTabState | null>
  openLocalDirectory(path?: string): Promise<BrowserTabState | null>
  openLocalEntry(tabId: string, path: string): Promise<BrowserTabState>
  readLocalFile(tabId: string): Promise<BrowserLocalFileContent>
  connect(input: BrowserConnectInput): Promise<BrowserConnectionState>
  disconnect(): Promise<void>
  getConnection(): Promise<BrowserConnectionState>
  onEvent(listener: (event: BrowserEvent) => void): () => void
  onConnection(listener: (state: BrowserConnectionState) => void): () => void
}
