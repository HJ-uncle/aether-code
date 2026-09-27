/**
 * 上下文键
 *
 * 借鉴 VS Code 的 context key 机制：功能可见性/可用性不写死在组件里，
 * 而是表达成对一组键的布尔表达式（when），由注册方声明。
 *
 * 这样新增功能时只需注册新的键与 when 条件，不必回头修改既有组件。
 * 支持语法：key、!key、a && b、a || b、a == 'x'、a != 'x'
 */

type ContextValue = boolean | string | number | undefined

const values = new Map<string, ContextValue>()
const listeners = new Set<() => void>()

export function setContextKey(key: string, value: ContextValue): void {
  if (values.get(key) === value) return
  values.set(key, value)
  for (const listener of listeners) listener()
}

/** 批量设置，只广播一次（避免 N 次重渲染） */
export function setContextKeys(entries: Record<string, ContextValue>): void {
  let changed = false
  for (const [key, value] of Object.entries(entries)) {
    if (values.get(key) !== value) {
      values.set(key, value)
      changed = true
    }
  }
  if (changed) {
    for (const listener of listeners) listener()
  }
}

export function getContextKey(key: string): ContextValue {
  return values.get(key)
}

export function onContextKeysChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ==================== 表达式求值 ====================

type Token = { type: 'ident' | 'string' | 'op' | 'paren'; value: string }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const ch = input[i]

    if (/\s/.test(ch)) {
      i++
      continue
    }

    if (ch === '!' || ch === '(' || ch === ')') {
      // 区分 != 与 !
      if (ch === '!' && input[i + 1] === '=') {
        tokens.push({ type: 'op', value: '!=' })
        i += 2
        continue
      }
      tokens.push({ type: ch === '!' ? 'op' : 'paren', value: ch })
      i++
      continue
    }

    if (ch === '&' && input[i + 1] === '&') {
      tokens.push({ type: 'op', value: '&&' })
      i += 2
      continue
    }

    if (ch === '|' && input[i + 1] === '|') {
      tokens.push({ type: 'op', value: '||' })
      i += 2
      continue
    }

    if (ch === '=' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '==' })
      i += 2
      continue
    }

    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let text = ''
      while (j < input.length && input[j] !== quote) {
        text += input[j]
        j++
      }
      tokens.push({ type: 'string', value: text })
      i = j + 1
      continue
    }

    let j = i
    let ident = ''
    while (j < input.length && /[A-Za-z0-9_.-]/.test(input[j])) {
      ident += input[j]
      j++
    }
    if (!ident) {
      i++ // 非法字符，跳过以免死循环
      continue
    }
    tokens.push({ type: 'ident', value: ident })
    i = j
  }

  return tokens
}

/**
 * 求值一个 when 表达式。
 * 空表达式视为 true（表示"无条件生效"）。
 * 表达式非法时返回 false —— 宁可功能不显示，也不要在错误条件下误触发。
 */
export function evaluateWhen(expression: string | undefined): boolean {
  if (!expression || !expression.trim()) return true

  const tokens = tokenize(expression)
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]

  function parsePrimary(): boolean {
    const token = peek()
    if (!token) throw new Error('unexpected end of expression')

    if (token.type === 'paren' && token.value === '(') {
      pos++
      const inner = parseOr()
      const closing = peek()
      if (!closing || closing.value !== ')') throw new Error('missing )')
      pos++
      return inner
    }

    if (token.type === 'op' && token.value === '!') {
      pos++
      return !parsePrimary()
    }

    if (token.type !== 'ident') throw new Error(`unexpected token: ${token.value}`)

    pos++
    const value: ContextValue = values.get(token.value)

    // 比较运算
    const next = peek()
    if (next && next.type === 'op' && (next.value === '==' || next.value === '!=')) {
      pos++
      const rhs = peek()
      if (!rhs || (rhs.type !== 'string' && rhs.type !== 'ident')) {
        throw new Error('comparison requires a value')
      }
      pos++
      const rhsValue = rhs.type === 'string' ? rhs.value : values.get(rhs.value)
      const equal = String(value) === String(rhsValue)
      return next.value === '==' ? equal : !equal
    }

    return !!value
  }

  function parseAnd(): boolean {
    let left = parsePrimary()
    while (peek()?.type === 'op' && peek()?.value === '&&') {
      pos++
      const right = parsePrimary()
      left = left && right
    }
    return left
  }

  function parseOr(): boolean {
    let left = parseAnd()
    while (peek()?.type === 'op' && peek()?.value === '||') {
      pos++
      const right = parseAnd()
      left = left || right
    }
    return left
  }

  try {
    const result = parseOr()
    if (pos !== tokens.length) throw new Error('trailing tokens')
    return result
  } catch (err) {
    console.warn('[context-keys] when 表达式求值失败:', expression, err)
    return false
  }
}
