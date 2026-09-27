import { useSyncExternalStore } from 'react'
import { getLayout, onLayoutChanged, type LayoutState } from '@renderer/core/platform/layout-state'

/** 订阅布局状态。任何区域的拖动/切换都会让所有使用本 hook 的组件同步更新。 */
export function useLayout(): LayoutState {
  // layout-state 内部整体替换 state 对象，引用稳定，可直接作快照
  return useSyncExternalStore(onLayoutChanged, getLayout)
}
