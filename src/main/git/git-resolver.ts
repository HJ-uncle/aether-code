/**
 * git 可执行文件解析（主进程）
 *
 * 移植自 wuzu-client 的 gitResolver，做了两处简化：
 * - aether 没有内置 mingit，砍掉 bundled 候选与 setup 脚本逻辑
 * - 候选列表只保留「系统安装路径 + where git」，兜底 'git'（交给 PATH 与 ENOENT 文案）
 *
 * 结果做模块级缓存：git 安装位置在一个会话内不会变，反复 where 是浪费。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

let cached: string | null = null

/** Windows 下常见的 git 安装位置（ProgramFiles / 用户目录 / scoop / C:\Git） */
function installedCandidates(): string[] {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Programs') : undefined,
    process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], 'scoop', 'apps', 'git', 'current') : undefined,
    'C:\\'
  ].filter((r): r is string => Boolean(r))

  const candidates: string[] = []
  for (const root of roots) {
    const base = root === 'C:\\' ? 'C:\\Git' : path.join(root, 'Git')
    candidates.push(path.join(base, 'cmd', 'git.exe'), path.join(base, 'bin', 'git.exe'))
  }
  return candidates
}

/** `where git`（Windows 的 which）：把 PATH 里的 git.exe 都列出来 */
function listWhereGit(): string[] {
  try {
    const out = execFileSync('where', ['git'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().endsWith('git.exe') && existsSync(line))
  } catch {
    return []
  }
}

/**
 * 解析 git 可执行文件路径。
 *
 * 顺序：常见安装路径 → where git → 兜底 'git'（让 execFile 自己走 PATH，
 * 找不到时由 runGit 的 ENOENT 分支给出友好文案）。
 */
export function resolveGitExecutable(): string {
  if (cached) return cached

  if (process.platform === 'win32') {
    for (const candidate of installedCandidates()) {
      if (existsSync(candidate)) {
        cached = candidate
        return candidate
      }
    }
    const fromWhere = listWhereGit()
    if (fromWhere.length > 0) {
      cached = fromWhere[0]
      return cached
    }
  }

  cached = 'git'
  return cached
}
