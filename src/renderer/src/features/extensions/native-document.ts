/** A small JSON UI vocabulary; no HTML, expressions, imports or executable host code. */
export type NativeAction = { command: string; args?: Record<string, unknown>; tool?: never } | { tool: string; args?: Record<string, unknown>; command?: never }
export interface NativeNode { type: 'text' | 'heading' | 'stack' | 'row' | 'divider' | 'button' | 'input' | 'textarea' | 'select' | 'checkbox' | 'card' | 'image' | 'markdown'; id?: string; text?: string; label?: string; value?: string | number | boolean; bind?: string; placeholder?: string; options?: Array<{ label: string; value: string }>; children?: NativeNode[]; action?: NativeAction; variant?: 'primary' | 'secondary' | 'danger'; src?: string; alt?: string }
const types = new Set(['text', 'heading', 'stack', 'row', 'divider', 'button', 'input', 'textarea', 'select', 'checkbox', 'card', 'image', 'markdown'])
const fields = new Set(['type', 'id', 'text', 'label', 'value', 'bind', 'placeholder', 'options', 'children', 'action', 'variant', 'src', 'alt'])
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function validateArgs(args: unknown): void {
  const pending: Array<{ value: unknown; exit?: boolean }> = [{ value: args }], ancestors = new Set<object>()
  while (pending.length) {
    const { value, exit } = pending.pop()!
    if (!value || typeof value !== 'object') continue
    if (exit) { ancestors.delete(value); continue }
    if (ancestors.has(value)) throw new Error('原生动作参数不能循环引用。')
    ancestors.add(value); pending.push({ value, exit: true })
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('原生动作参数包含保留字段。')
      pending.push({ value: item })
    }
  }
}
export function parseNativeDocument(source: string): { version: 1; root: NativeNode } {
  const document: unknown = JSON.parse(source)
  if (!record(document) || document.version !== 1 || Object.keys(document).some(key => !['version', 'root'].includes(key))) throw new Error('原生页面版本无效。')
  const binds = new Set<string>(), pending: unknown[] = [document.root]
  while (pending.length) {
    const value = pending.pop()
    if (!record(value) || !types.has(String(value.type)) || Object.keys(value).some(key => !fields.has(key))) throw new Error('原生页面包含未知组件或字段。')
    for (const field of ['id', 'text', 'label', 'bind', 'placeholder', 'src', 'alt']) if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error('原生页面字段无效。')
    if (value.value !== undefined && !['string', 'number', 'boolean'].includes(typeof value.value)) throw new Error('原生组件值无效。')
    if (value.variant !== undefined && !['primary', 'secondary', 'danger'].includes(String(value.variant))) throw new Error('原生组件样式无效。')
    if (value.bind !== undefined) { if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(String(value.bind)) || ['constructor', 'prototype'].includes(String(value.bind)) || binds.has(String(value.bind))) throw new Error('表单字段标识无效或重复。'); binds.add(String(value.bind)) }
    if (value.src !== undefined && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(String(value.src))) throw new Error('原生图片只支持内嵌位图。')
    if (value.options !== undefined && (!Array.isArray(value.options) || value.options.some(item => !record(item) || typeof item.label !== 'string' || typeof item.value !== 'string' || Object.keys(item).some(key => !['label', 'value'].includes(key))))) throw new Error('下拉选项无效。')
    if (value.action !== undefined) {
      const action = value.action
      if (!record(action) || Boolean(action.command) === Boolean(action.tool) || (action.command !== undefined && typeof action.command !== 'string') || (action.tool !== undefined && typeof action.tool !== 'string') || Object.keys(action).some(key => !['command', 'tool', 'args'].includes(key)) || action.args !== undefined && !record(action.args)) throw new Error('原生页面操作无效。')
      validateArgs(action.args)
    }
    if (value.children !== undefined) { if (!Array.isArray(value.children)) throw new Error('原生子组件无效。'); for (const child of value.children) pending.push(child) }
  }
  return document as unknown as { version: 1; root: NativeNode }
}
export function nativeInitialValues(node: NativeNode, result: Record<string, string | number | boolean> = {}): Record<string, string | number | boolean> {
  const pending = [node]
  while (pending.length) {
    const current = pending.pop()!
    if (current.bind) result[current.bind] = current.value ?? (current.type === 'checkbox' ? false : '')
    if (current.children) for (let i = current.children.length - 1; i >= 0; i--) pending.push(current.children[i])
  }
  return result
}

export function resolveNativeArgs(args: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  validateArgs(args)
  const result: Record<string, unknown> = {}
  const pending: Array<{ value: unknown; target: Record<string, unknown> | unknown[]; key: string | number }> = [{ value: args, target: result, key: 'value' }]
  while (pending.length) {
    const { value, target, key } = pending.pop()!
    const assign = (item: unknown): void => { if (Array.isArray(target)) target[Number(key)] = item; else target[String(key)] = item }
    if (Array.isArray(value)) {
      const items: unknown[] = []; assign(items)
      value.forEach((item, index) => pending.push({ value: item, target: items, key: index }))
    } else if (record(value)) {
      if (Object.keys(value).length === 1 && typeof value.$field === 'string') {
        if (!Object.hasOwn(values, value.$field)) throw new Error(`表单字段不存在：${value.$field}`)
        assign(values[value.$field]); continue
      }
      const item: Record<string, unknown> = {}; assign(item)
      for (const [name, child] of Object.entries(value)) pending.push({ value: child, target: item, key: name })
    } else assign(value)
  }
  return result.value as Record<string, unknown>
}
