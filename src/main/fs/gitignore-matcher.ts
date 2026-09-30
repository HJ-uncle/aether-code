/**
 * .gitignore 匹配（主进程）
 *
 * 资源管理器要把「已被 git 忽略」的目录/文件置灰 —— 一眼看出 node_modules、dist
 * 这些不该动的东西，对齐 VS Code / wuzu-client。
 *
 * 用 ignore 库做**纯语法匹配**，不调 git：非 git 仓库（还没 git init 的项目）同样
 * 能正确置灰，也不必为列一个目录就 fork 一次 git 进程。
 *
 * 规则来源：从被读目录向上收集到工作区根（含）的所有层级 .gitignore，外层在前叠加，
 * 与 git 的「就近优先」一致。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'

/** 单份 .gitignore 的解析结果缓存（键为绝对路径） */
const fileCache = new Map<string, { mtimeMs: number; lines: string[] }>()

/** 一个目录对应的合并匹配器缓存 */
const dirCache = new Map<string, { files: string[]; ig: Ignore | null }>()

async function loadIgnoreFile(file: string): Promise<string[] | null> {
  try {
    const stat = await fs.stat(file)
    const cached = fileCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.lines
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/)
    fileCache.set(file, { mtimeMs: stat.mtimeMs, lines })
    return lines
  } catch {
    return null
  }
}

/** 从 dir 向上走到 root，收集沿途所有 .gitignore（外层在前） */
async function collectIgnoreFiles(dir: string, root: string): Promise<string[]> {
  const rootResolved = path.resolve(root)
  const files: string[] = []
  let current = path.resolve(dir)
  const guard = /^[A-Za-z]:\\$|^\/$/
  for (;;) {
    files.push(path.join(current, '.gitignore'))
    if (current === rootResolved || guard.test(current)) break
    const parent = path.dirname(current)
    if (parent === current || !parent.startsWith(rootResolved)) break
    current = parent
  }
  return files.reverse()
}

/**
 * 取某个目录生效的忽略匹配器。
 *
 * 双重缓存：单文件按 mtime，合并结果按「依赖文件清单 + 各文件 mtime」。
 * .gitignore 改过之后下一次 readDir 就会拿到新规则，不需要用户手动刷新。
 */
async function getIgnore(dir: string, root: string): Promise<Ignore | null> {
  const files = await collectIgnoreFiles(dir, root)
  const cached = dirCache.get(dir)
  if (cached && cached.files.length === files.length && cached.files.every((f, i) => f === files[i])) {
    let stale = false
    for (const file of files) {
      try {
        const stat = await fs.stat(file)
        const entry = fileCache.get(file)
        if (!entry || entry.mtimeMs !== stat.mtimeMs) {
          stale = true
          break
        }
      } catch {
        // 文件被删了：需要重建
        stale = true
        break
      }
    }
    if (!stale) return cached.ig
  }

  const ig = ignore()
  let loaded = false
  for (const file of files) {
    const lines = await loadIgnoreFile(file)
    if (!lines) continue
    ig.add(lines)
    loaded = true
  }
  const result = loaded ? ig : null
  dirCache.set(dir, { files, ig: result })
  return result
}

/**
 * 给一层目录的子项打上「被 .gitignore 忽略」标记。
 *
 * 任何异常都吞掉并把标记留成 undefined（渲染层当未忽略处理）——列目录是主路径，
 * 不能因为一份写坏的 .gitignore 就整个读不出来。
 */
export async function markGitignored(
  entries: { path: string; gitignored?: boolean }[],
  dir: string,
  root: string
): Promise<void> {
  if (!root || entries.length === 0) return
  try {
    const ig = await getIgnore(dir, root)
    if (!ig) return
    const base = path.resolve(root)
    for (const entry of entries) {
      const rel = path.relative(base, entry.path).replace(/\\/g, '/')
      if (!rel) continue
      // 先按裸路径判；没命中再补判带尾斜杠的形式 —— ignore 库对 `dist/` 这类
      // 目录锚定规则要求被匹配的路径也带尾斜杠，否则目录本身判不出来。
      entry.gitignored = ig.ignores(rel) || ig.ignores(`${rel}/`)
    }
  } catch {
    // 忽略判定失败不阻断列目录：所有条目保持未标记
  }
}
