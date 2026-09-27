/**
 * 搜索排除规则的匹配与剪枝（主进程）
 *
 * 与渲染层的 `core/workspace/exclude.ts` 是同一套 glob 语义 ——
 * 但那一份在渲染进程、依赖 window.aether 所在的上下文，搜索在主进程跑，
 * 只能各存一份。两处最坏的结果只是「资源管理器藏着、搜索却搜到」，
 * 不会损坏数据，因此不值得为共用而把主进程的逻辑搬到渲染层去。
 *
 * 与 VS Code 对齐的三条语义：
 *   1. 搜索的排除表 = files.exclude 与 search.exclude 的并集，同名键以 search 为准；
 *   2. 值为 false 表示「显式不排除」，用于把继承来的默认规则放回来
 *      （例如把 files.exclude 里的某条规则在 search.exclude 里写成 false）；
 *   3. 目录命中即剪枝 —— 不再往下遍历，这是排除目录真正省时间的地方。
 */
import type { FilesExclude } from '@shared/ipc'

/** 编译后的单条规则 */
interface CompiledRule {
  regex: RegExp
  /** 正则是否锚定整段相对路径（否则只锚定 basename） */
  pathScoped: boolean
  /** false = 显式不排除 */
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

    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

/**
 * 编译排除表。
 *
 * 一条模式至多编译成两条正则：锚定整段相对路径的那条，以及（模式不含分隔符时）
 * 只锚定 basename 的那条。匹配时两条都试 —— 这样含双星前缀的模式既能命中
 * 顶层目录，也能命中任意深度的同名目录，而不必依赖父级传播。
 */
export function compileSearchExclude(exclude: FilesExclude | undefined): CompiledRule[] {
  if (!exclude) return []

  const rules: CompiledRule[] = []
  for (const [rawPattern, value] of Object.entries(exclude)) {
    const pattern = rawPattern.trim()
    if (!pattern) continue

    // 末尾的斜杠、或斜杠加双星，只是强调「目录及其内容」，匹配语义上可省
    let normalized = pattern.replace(/\/\*\*$/, '').replace(/\/+$/, '')
    if (!normalized) continue

    const isPathPattern = normalized.includes('/')
    if (!isPathPattern) normalized = `**/${normalized}`

    const exclude = value !== false
    rules.push({
      regex: new RegExp(`^(?:${globToRegExpSource(normalized)})$`),
      pathScoped: true,
      exclude
    })

    if (!isPathPattern) {
      rules.push({
        regex: new RegExp(`^(?:${globToRegExpSource(normalized.slice(3))})$`),
        pathScoped: false,
        exclude
      })
    }
  }
  return rules
}

/**
 * 判断某个条目（相对工作区根）是否被排除。
 *
 * @param relPath 相对工作区根的路径（正斜杠）
 * @param name    条目名（basename）
 */
export function isSearchExcluded(rules: CompiledRule[], relPath: string, name: string): boolean {
  if (rules.length === 0) return false

  for (const rule of rules) {
    if (!rule.exclude) continue
    // 两条正则的匹配对象不同：路径型看整段相对路径，名字型只看 basename
    if (rule.pathScoped ? rule.regex.test(relPath) : rule.regex.test(name)) return true
  }
  return false
}

/**
 * 合并两张排除表：files.exclude 打底，search.exclude 覆盖同名键。
 *
 * 与 VS Code 的 `getExcludes` 一致（objects.mixin 的后者优先）。
 * false 值保留在表里 —— 它的含义是「显式不排除」，由 compileSearchExclude
 * 编译成 exclude:false 的规则，从而把打底表里的同名规则挡回去。
 */
export function mergeSearchExclude(
  filesExclude: FilesExclude | undefined,
  searchExclude: FilesExclude | undefined
): FilesExclude {
  return { ...(filesExclude ?? {}), ...(searchExclude ?? {}) }
}

/**
 * 归一化一条 glob 以便交给 git 的 pathspec 使用。
 *
 * 只处理「无分隔符」这一种情况：用户按资源管理器的直觉写 node_modules，
 * 意思是「任意层级下的 node_modules」，而 git pathspec 的裸写只匹配顶层。
 * 补上双星前缀后两边语义才一致 —— 否则同一张规则表在遍历兜底与 git grep
 * 两条路径上会给出不同的搜索结果，搜索行为会随仓库是否为 git 而变。
 *
 * 末端的「斜杠双星」裁掉：它只匹配目录内的文件、不含目录本身，
 * 而带 -n 的命中本来就只来自文件行，裁掉反而更直接。
 *
 * 返回数组而非单条：git 的 pathspec 是「路径匹配」，不认目录树。
 * 排除 glob 只写了 sub 时，匹配不到 sub 目录里的 nested.txt —— 必须再补一条
 * 「sub 之下全部内容」才能把目录里的文件排掉。这与 walkScan 的「目录命中即剪枝」
 * 语义对齐，否则用户按资源管理器的直觉写 sub，git 路径下会「排除失效」。
 *
 * @param inSubmodule 该模式是否用于 git 子模块路径（需要跨目录边界时另加前缀）
 */
export function toGitPathspec(pattern: string, inSubmodule = false): string[] {
  const trimmed = pattern.trim()
  if (!trimmed) return []

  const normalized = trimmed.replace(/\/\*\*$/, '').replace(/\/+$/, '')
  if (!normalized) return []

  // 以 / 开头的模式在 git 里锚定仓库根，逐字符编译会把它当字面量，语义不同，跳过
  if (normalized.startsWith('/')) return []

  // 不含分隔符 = 匹配任意层级的同名项；补双星前缀把 git 的「仅顶层」放宽
  const anchored = normalized.includes('/') ? normalized : `**/${normalized}`
  const prefix = inSubmodule ? ':(exclude,glob)**/' : ':(exclude,glob)'

  // 第一条挡同名文件或目录本身，第二条挡该目录下的所有内容
  return [`${prefix}${anchored}`, `${prefix}${anchored}/**`]
}
