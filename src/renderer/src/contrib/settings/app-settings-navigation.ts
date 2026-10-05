import { showEditorView } from '@renderer/core/platform/layout-state'

// ── 打开设置时定位到指定分区 ────────────────────────────────────────────────
// 原先「模型」「安全」是主区独立标签，现已并入 AppSettingsView；命令/快捷键/对话页的
// 跳转统一走 openAppSettings(section)，既处理未打开时的初始定位，也处理
// 已打开时再次触发（如 Ctrl+Shift+M 切到模型分区）的分区切换。

export const DEFAULT_SETTINGS_SECTION = 'general'

interface SectionRequest {
  section: string
  nonce: number
}

let sectionRequest: SectionRequest | null = null
let nonceCounter = 0
const sectionListeners = new Set<() => void>()

/** 打开设置主区视图；传分区 id 时定位到该分区（默认引擎管理） */
export function openAppSettings(section?: string): void {
  sectionRequest = { section: section ?? DEFAULT_SETTINGS_SECTION, nonce: ++nonceCounter }
  showEditorView('app-settings')
  for (const listener of sectionListeners) listener()
}

/** useSyncExternalStore 的快照：返回当前（可能为空）的定位请求 */
export function getSectionRequest(): SectionRequest | null {
  return sectionRequest
}

export function subscribeSectionRequest(listener: () => void): () => void {
  sectionListeners.add(listener)
  return () => sectionListeners.delete(listener)
}
