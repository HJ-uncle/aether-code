import { Menu } from 'monaco-editor/base/browser/ui/menu/menu'
import menuStyles from '../../assets/monaco-menu.css?inline'

const shadowStyles = menuStyles.replaceAll(':root', ':host')
let initialized = false

export function setupMonacoMenuStyles(): void {
  if (initialized) return
  initialized = true

  const initializeStyleSheet = Menu.prototype.initializeOrUpdateStyleSheet
  // Monaco 0.56 invokes this hook before constructing and measuring its scroll
  // surface, including submenus. Synchronous styles preserve its fixed Shadow
  // DOM placement without a later restyle invalidating scrollbar measurements.
  Menu.prototype.initializeOrUpdateStyleSheet = function (container, style): void {
    initializeStyleSheet.call(this, container, style)
    if (container.getRootNode() instanceof ShadowRoot && this.styleSheet) {
      this.styleSheet.textContent = `${this.styleSheet.textContent ?? ''}\n${shadowStyles}`
    }
  }
}
