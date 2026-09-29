/**
 * 折叠状态记忆（会话级），照抄 wuzu-client useCollapseMemory 的语义。
 *
 * 消息列表里可折叠条目（过程块 / 思考行 / 工具行 / 子代理卡）的展开状态
 * 原本是组件内局部 state，切会话、列表分页回收重建后全部回到默认，
 * 用户手动折过的东西白折了。这里把「用户点过一次之后的选择」按条目 key
 * 记进 sessionStorage：刷新页面会清空（会话语义），但组件重建、分页回收
 * 都能恢复到用户最后的选择。
 *
 * 语义：返回 [manual, setManual]，manual 初值为 null（未手动操作过，
 * 听组件默认/自动逻辑）；用户点过一次后写入记忆，之后永远以用户选择为准。
 */
import { useCallback, useState } from 'react'

const STORAGE_KEY = 'aether-chat-collapse-memory'

function readStore(): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, boolean>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 存储满/被禁用时静默降级为会话内记忆，不影响交互
  }
}

/**
 * @param key 条目唯一标识（如 toolUseId / 块首 id）；空时退化为普通 useState
 * @returns [manual, setManual]：manual=null 表示未手动操作
 */
export function useCollapseMemory(
  key: string | undefined
): [boolean | null, (value: boolean) => void] {
  const [manual, setManualState] = useState<boolean | null>(() => {
    if (!key) return null
    const stored = readStore()[key]
    return typeof stored === 'boolean' ? stored : null
  })

  const setManual = useCallback(
    (value: boolean) => {
      setManualState(value)
      if (!key) return
      const store = readStore()
      store[key] = value
      writeStore(store)
    },
    [key]
  )

  return [manual, setManual]
}
