import type { AetherIdeApi } from './index'

declare global {
  interface Window {
    aether: AetherIdeApi
  }
}
