import { ElectronAPI } from '@electron-toolkit/preload'
import type { AetherIdeApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    aether: AetherIdeApi
  }
}
