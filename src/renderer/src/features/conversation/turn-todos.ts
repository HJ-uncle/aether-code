import type { EngineTodo } from '@shared/ipc'
import type { ChatMessage } from '@renderer/core/engine/useChat'

export interface SessionTurnTodoFrame {
  todos: EngineTodo[]
  runId?: string
  turnId?: string
}

const PLAN_TOOLS = new Set(['plan_update', 'todo_create', 'todo_update', 'todo_delete'])

/** The whole table remains the source of truth. Each task keeps its originating
 * turn; a later turn may add a separate card without stealing the old plan. */
export class SessionTurnTodoLedger {
  private owners = new Map<string, string>()
  private latest: EngineTodo[] = []

  update(frame: SessionTurnTodoFrame, fallbackOwner?: string, toolOwner?: string): void {
    const previousIds = new Set(this.latest.map(todo => todo.id))
    const explicit = frame.turnId ? `conversation:${frame.turnId}` : frame.runId ? `run:${frame.runId}` : undefined
    const owner = explicit ?? toolOwner ?? fallbackOwner
    this.latest = frame.todos
    if (!owner) return
    for (const todo of frame.todos) {
      if (!previousIds.has(todo.id) || !this.owners.has(todo.id)) this.owners.set(todo.id, owner)
    }
  }

  reset(): void { this.owners.clear(); this.latest = [] }

  assign(groups: readonly { id: string; identity?: string; owners?: readonly string[] }[]): Map<string, EngineTodo[]> {
    if (!this.latest.length) return new Map()
    const result = new Map<string, EngineTodo[]>()
    let hasUnknownOwner = false
    for (const todo of this.latest) {
      const owner = this.owners.get(todo.id)
      const group = owner ? groups.find(item => item.identity === owner || item.id === owner || item.owners?.includes(owner)) : undefined
      if (!group) { hasUnknownOwner = true; continue }
      const todos = result.get(group.id) ?? []
      todos.push(todo)
      result.set(group.id, todos)
    }
    // A legacy snapshot with no origin is kept visible rather than assigned to
    // an arbitrary last turn. Known cards are never duplicated at the tail.
    if (hasUnknownOwner && !result.size) result.set('', this.latest)
    return result
  }
}

/** Old servers omit turn identity from todo frames. Only successful plan tools
 * are evidence: a failed or merely requested plan cannot claim ownership. */
export function sessionTodoToolOwners(messages: readonly ChatMessage[]): Map<string, string> {
  const owners = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const tool of message.tools) {
      if (!PLAN_TOOLS.has(tool.name) || tool.state !== 'done') continue
      if (message.conversationId) owners.set(tool.id, `conversation:${message.conversationId}`)
      else if (message.runId) owners.set(tool.id, `run:${message.runId}`)
    }
  }
  return owners
}
