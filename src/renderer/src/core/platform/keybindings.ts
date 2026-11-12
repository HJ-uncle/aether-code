/**
 * 键位绑定
 *
 * 声明式地把「按键组合 → 命令 ID」注册进来，由一个全局监听器统一派发。
 * 组件内部不写 keydown 处理，避免同一个快捷键在多个组件里重复实现。
 *
 * 派发顺序对齐 VS Code KeybindingResolver：用户自定义规则（user-keybindings）
 * 永远优先；默认绑定里被用户负规则删除的不再响应。
 */
import { evaluateWhen } from './context-keys'
import { executeCommand, getCommand } from './commands'
import {
  getEffectiveUserBinding,
  getUserKeybindingRules,
  onUserKeybindingsChanged
} from './user-keybindings'

export interface KeybindingDefinition {
  /** 形如 'ctrl+shift+p' / 'ctrl+enter' / 'escape'，mac 上 ctrl 自动映射为 cmd */
  key: string
  command: string
  when?: string
  /** 阻止默认行为（如 ctrl+s 保存页面） */
  preventDefault?: boolean
}

export interface ResolvedParts {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

interface ResolvedBinding extends KeybindingDefinition {
  parts: ResolvedParts
}

const bindings: ResolvedBinding[] = []

function parseKeybinding(definition: KeybindingDefinition): ResolvedBinding {
  const tokens = definition.key.toLowerCase().split('+')
  const parts = { ctrl: false, shift: false, alt: false, key: '' }

  for (const token of tokens) {
    if (token === 'ctrl' || token === 'cmd' || token === 'meta') parts.ctrl = true
    else if (token === 'shift') parts.shift = true
    else if (token === 'alt') parts.alt = true
    else parts.key = token
  }

  return { ...definition, parts }
}

export function registerKeybinding(definition: KeybindingDefinition): () => void {
  const resolved = parseKeybinding(definition)
  bindings.push(resolved)
  return () => {
    const index = bindings.indexOf(resolved)
    if (index >= 0) bindings.splice(index, 1)
  }
}

export function registerKeybindings(definitions: KeybindingDefinition[]): () => void {
  const disposers = definitions.map(registerKeybinding)
  return () => disposers.forEach((dispose) => dispose())
}

// ==================== 用户规则层 ====================

/** 用户规则的解析缓存：规则变更时置空，按需重建 */
let userBindingCache: ResolvedBinding[] | null = null

function getParsedUserBindings(): ResolvedBinding[] {
  if (!userBindingCache) {
    userBindingCache = getUserKeybindingRules().map((rule) =>
      parseKeybinding({ key: rule.key, command: rule.command, when: rule.when })
    )
  }
  return userBindingCache
}

onUserKeybindingsChanged(() => {
  userBindingCache = null
})

function sameParts(a: ResolvedParts, b: ResolvedParts): boolean {
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.key === b.key
}

/** 默认绑定是否被用户负规则删除（按键组合按解析后的修饰键比较，不受写法差异影响） */
export function isDefaultKeybindingRemoved(key: string, command: string): boolean {
  const negative = `-${command}`
  const parts = parseKeybinding({ key, command: '' }).parts
  return getParsedUserBindings().some(
    (rule) => rule.command === negative && sameParts(rule.parts, parts)
  )
}

/** 命令的默认键位 key 串（注册表里第一条），无绑定返回 undefined */
export function getDefaultKeybinding(command: string): string | undefined {
  return bindings.find((item) => item.command === command)?.key
}

/** 把 key 串转成展示串（'ctrl+shift+p' → 'Ctrl+Shift+P'） */
export function formatKeybinding(key: string): string {
  const { ctrl, alt, shift, key: name } = parseKeybinding({ key, command: '' }).parts
  return [ctrl ? 'Ctrl' : '', alt ? 'Alt' : '', shift ? 'Shift' : '', name.toUpperCase()]
    .filter(Boolean)
    .join('+')
}

export interface KeybindingConflict {
  command: string
  /** 占用者当前的键位展示串 */
  key: string
  title?: string
}

/**
 * 查询「把 key 分给某命令」时会覆盖哪些现有绑定（编辑器的冲突提示用）：
 *   - 用户正规则里已占用该组合的其他命令（新规则更晚定义，会压过它们）；
 *   - 默认绑定占用该组合、未被负规则删除、也没有用户重绑的其他命令。
 */
export function findKeybindingConflicts(
  key: string,
  excludeCommand?: string
): KeybindingConflict[] {
  const target = parseKeybinding({ key, command: '' }).parts
  const conflicts = new Map<string, KeybindingConflict>()

  for (const rule of getParsedUserBindings()) {
    if (rule.command.startsWith('-')) continue
    if (rule.command === excludeCommand || !sameParts(rule.parts, target)) continue
    conflicts.set(rule.command, {
      command: rule.command,
      key: formatKeybinding(rule.key),
      title: getCommand(rule.command)?.title
    })
  }

  for (const binding of bindings) {
    if (binding.command === excludeCommand) continue
    if (!sameParts(binding.parts, target)) continue
    if (isDefaultKeybindingRemoved(binding.key, binding.command)) continue
    if (getEffectiveUserBinding(binding.command) !== undefined) continue
    conflicts.set(binding.command, {
      command: binding.command,
      key: formatKeybinding(binding.key),
      title: getCommand(binding.command)?.title
    })
  }

  return [...conflicts.values()]
}

/** 取某命令的键位展示串（优先用户自定义，其次默认绑定），无绑定返回 undefined */
export function getKeybindingHint(command: string): string | undefined {
  const userKey = getEffectiveUserBinding(command)
  if (userKey) return formatKeybinding(userKey)

  const binding = bindings.find((item) => item.command === command)
  if (!binding) return undefined
  if (isDefaultKeybindingRemoved(binding.key, command)) return undefined
  return formatKeybinding(binding.key)
}

function eventKeyName(event: KeyboardEvent): string {
  // event.key 对空格等返回 ' '，统一成可比较的名字
  if (event.key === ' ') return 'space'
  return event.key.toLowerCase()
}

function matches(binding: ResolvedBinding, event: KeyboardEvent): boolean {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  // mac 上 ctrl 语义映射为 Cmd，与 VS Code 一致
  const ctrlPressed = isMac ? event.metaKey : event.ctrlKey

  return (
    ctrlPressed === binding.parts.ctrl &&
    event.shiftKey === binding.parts.shift &&
    event.altKey === binding.parts.alt &&
    eventKeyName(event) === binding.parts.key
  )
}

/** 录制按键时忽略的纯功能键（按下它们不算组合键完成） */
const MODIFIER_KEY_NAMES = new Set([
  'control',
  'shift',
  'alt',
  'meta',
  'capslock',
  'numlock',
  'scrolllock',
  'fn',
  'fnlock'
])

/**
 * 把 KeyboardEvent 转成 key 串（键位编辑器的录制用）。
 * 纯修饰键返回 null（还没录到主键）；其余与匹配端 eventKeyName 同一规范化，
 * 保证「录制出的串一定能被派发器匹配」。
 */
export function serializeKeybindingEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEY_NAMES.has(event.key.toLowerCase())) return null
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const parts: string[] = []
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  parts.push(event.key === ' ' ? 'space' : event.key.toLowerCase())
  return parts.join('+')
}

/** 是否正在输入框内（用于区分文本输入与全局快捷键） */
function isEditingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/**
 * 安装全局快捷键派发。返回卸载函数。
 * 只应在应用启动时调用一次。
 */
export function installKeybindingDispatcher(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const editing = isEditingContext(event.target)

    // 1) 用户自定义规则优先；逆序遍历 = 同键位后定义覆盖先定义（VS Code 语义）
    const userBindings = getParsedUserBindings()
    for (let i = userBindings.length - 1; i >= 0; i--) {
      const binding = userBindings[i]
      if (binding.command.startsWith('-')) continue // 负规则只负责屏蔽默认绑定
      if (!matches(binding, event)) continue
      if (!evaluateWhen(binding.when)) continue

      // 在输入框里时只放行带修饰键的绑定，避免吞掉正常打字
      const hasModifier = binding.parts.ctrl || binding.parts.alt
      if (editing && !hasModifier) continue

      if (binding.preventDefault !== false) event.preventDefault()
      void executeCommand(binding.command)
      return
    }

    // 2) 默认绑定：被用户负规则删除的不再响应
    for (const binding of bindings) {
      if (!matches(binding, event)) continue
      if (!evaluateWhen(binding.when)) continue
      if (isDefaultKeybindingRemoved(binding.key, binding.command)) continue

      const hasModifier = binding.parts.ctrl || binding.parts.alt
      if (editing && !hasModifier) continue

      if (binding.preventDefault !== false) event.preventDefault()
      void executeCommand(binding.command)
      return
    }
  }

  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
