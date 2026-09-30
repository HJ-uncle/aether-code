import type { Mention } from './MentionInput'
import { showChatPanel } from '@renderer/core/platform/layout-state'

// ── 终端/编辑器「添加到对话」桥 ───────────────────────────────────────────────
// 终端选中、编辑器选中产生的引用，需要先暂存再交给 ChatView 输入框消费——
// 两者处于不同 React 子树，ChatView 也未必挂载。照 app-settings-navigation
// 的模式做一个模块级队列：push 端（TerminalView / MonacoEditor）只管入队，
// ChatView 挂载或收到订阅通知时一次性 consume（取出并清空），逐条插入为
// mention chip。对齐 wuzu-client codeWorkspace 的 pendingTerminalRefs /
// pendingCodeRefs（消费端用 splice(0) 原子取空，这里用 consume 返回值等价）。

let pending: Mention[] = []
const listeners = new Set<() => void>()

/** 入队一条待插入输入框的引用（终端选中文本 / 编辑器选区） */
export function pushPendingMention(mention: Mention): void {
  pushPendingMentions([mention])
}

export function pushPendingMentions(mentions: Mention[]): void {
  showChatPanel()
  pending = [...pending, ...mentions]
  for (const listener of listeners) listener()
}

/**
 * 原子地取出并清空当前队列（对齐 wuzu splice(0)）。
 * ChatView 消费后逐个 insertMention。
 */
export function consumePendingMentions(): Mention[] {
  const current = pending
  pending = []
  return current
}

/** 供 ChatView 在有新引用入队时被通知（useEffect 订阅） */
export function subscribePendingMentions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
