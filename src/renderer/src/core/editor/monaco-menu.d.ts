/** Narrow bridge to the Monaco 0.56 menu style hook, before native layout. */
declare module 'monaco-editor/base/browser/ui/menu/menu' {
  export class Menu {
    styleSheet?: HTMLStyleElement
    /** Monaco owns this style payload; the bridge only forwards it unchanged. */
    initializeOrUpdateStyleSheet(container: HTMLElement, style: unknown): void
  }
}
