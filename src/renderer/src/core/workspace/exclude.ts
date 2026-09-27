/**
 * 文件排除规则（`files.exclude`）的匹配器。
 *
 * 语义照搬 VS Code 的 glob：
 *   - 单星匹配一段路径内的任意字符（不跨分隔符）
 *   - 问号匹配单个字符（不跨分隔符）
 *   - 双星匹配任意层级（跨分隔符）
 *   - 模式不含分隔符时视为「匹配任意层级的同名项」，即在前面补上双星加斜杠
 *     （VS Code 里写 node_modules 与加上双星前缀是有区别的 ——
 *      前者只挡顶层；这里跟随「用户直觉」放宽为任意层级，与实际使用一致）
 *   - 末尾的斜杠与斜杠加双星都表示「目录及其内容」，编译时裁掉
 *
 * 值 false 表示显式不排除，用于在内层覆盖出厂默认（如把 .git 放出来）。
 * 匹配对「相对工作区根的路径」和「basename」各试一次，任一命中即算排除 ——
 * 这样带双星的 *.log 与裸写的 *.log 都能直接命中深层文件。
 */
import type { FilesExclude } from '@shared/ipc'

/** 编译后的单条规则 */
interface CompiledRule {
  /** 原始模式，仅用于调试与去重 */
  pattern: string
  regex: RegExp
  /** false = 显式不隐藏 */
  exclude: boolean
}

/** 把 glob 片段转成正则源码。逐字符扫描，避免正则元字符被误转义。 */
function globToRegExpSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]

    if (char === '*') {
      const isDouble = glob[i + 1] === '*'
      if (isDouble) {
        // 双星加斜杠吞掉「任意层级的前缀」；单独双星则匹配任意字符
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }

    if (char === '?') {
      out += '[^/]'
      continue
    }

    // 正则元字符一律转义
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

/**
 * 编译排除表。
 *
 * 一个模式会编译成两条正则（锚定整段路径 / 锚定 basename），匹配时各试一次。
 * 规则不多（默认 6 条），不必做 VS Code 那套 basename 聚合优化的复杂度。
 */
export function compileExclude(exclude: FilesExclude | undefined): CompiledRule[] {
  if (!exclude) return []

  const rules: CompiledRule[] = []
  for (const [rawPattern, value] of Object.entries(exclude)) {
    const pattern = rawPattern.trim()
    if (!pattern) continue

    // 末尾的斜杠、或斜杠加双星，只是强调「目录及其内容」，匹配语义上可省
    let normalized = pattern.replace(/\/\*\*$/, '').replace(/\/+$/, '')
    if (!normalized) continue

    // 含路径分隔符 = 按相对根的路径匹配；否则在 basename 与「任意层级的路径」
    // 两个维度上都生效（见下方 basename 注释）
    const isPathPattern = normalized.includes('/')
    if (!isPathPattern) normalized = `**/${normalized}`

    const source = globToRegExpSource(normalized)
    const anchored = new RegExp(`^(?:${source})$`)

    // 没有分隔符的模式只约束「名字」，因此 basename 必须单独匹配一次：
    // 这样 `**/dist` 既能隐藏顶层的 dist，也能隐藏 src/dist，而不必依赖父级传播。
    // 带分隔符的模式已经约束了层级，不额外做 basename 匹配，
    // 否则 `src/generated` 会顺带隐藏别处的同名目录。
    const basename = isPathPattern
      ? null
      : new RegExp(`^(?:${globToRegExpSource(normalized.slice(3))})$`)

    rules.push({ pattern: rawPattern, regex: anchored, exclude: value !== false })
    if (basename) {
      rules.push({ pattern: rawPattern, regex: basename, exclude: value !== false })
    }
  }
  return rules
}

/**
 * 判断一个条目是否应被隐藏。
 *
 * @param rules        compileExclude 的产物
 * @param relPath      相对工作区根的路径（正斜杠）
 * @param name         条目名（basename）
 * @param parentHidden 祖先是否已被隐藏 —— 父被隐藏则子树一律隐藏
 */
export function isExcluded(
  rules: CompiledRule[],
  relPath: string,
  name: string,
  parentHidden: boolean
): boolean {
  if (parentHidden) return true
  if (rules.length === 0) return false

  const path = relPath.replace(/\\/g, '/')

  for (const rule of rules) {
    if (!rule.exclude) continue
    if (rule.regex.test(path) || rule.regex.test(name)) return true
  }
  return false
}
