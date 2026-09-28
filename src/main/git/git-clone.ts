/**
 * git clone（主进程）
 *
 * 移植自 wuzu-client 的 gitClone。
 * - spawn（而非 execFile）：clone 可能跑很久，且进度要从 stderr 流式解析
 * - 进度：Counting/Compressing/Receiving/Resolving 四阶段加权合成 0-100，只前进不回退
 * - 取消：按 cloneId 登记活跃子进程，kill 后清理半截目录，返回 errorCode='clone-cancelled'
 * - 目标目录重名自动 -1/-2 去重
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { GitCloneOptions, GitCloneProgressPayload, GitCloneResult, GitResult } from '../../shared/git-types'
import { resolveGitExecutable } from './git-resolver'

/** 目录名去重上限：repository-19 之后就不再试了 */
const MAX_DIR_NAME_TRIES = 20

/** 活跃克隆任务表：cloneId → 子进程句柄 */
const activeClones = new Map<string, { child: ChildProcess; cancelled: boolean; targetPath: string }>()

/** 容忍用户粘贴整条 `git clone <url>` 命令 */
function cleanUrl(input: string): string {
  return input.trim().replace(/^git\s+clone\s+/i, '')
}

/** 从 url 推导目录名：去 query/hash、尾斜杠、.git 后缀与非法字符 */
function deriveRepoDirName(url: string): string {
  const noQuery = url.split(/[?#]/)[0] ?? ''
  const trimmed = noQuery.replace(/[/\\]+$/, '')
  const last = trimmed.split(/[/\\]/).pop() ?? ''
  const name = last.replace(/\.git$/i, '').replace(/[<>:"|?*]/g, '')
  if (!name || name === '.' || name === '..') return 'repository'
  return name
}

/** clone 失败的分类文案（顺序敏感：认证先于仓库不存在） */
function classifyCloneError(stderr: string): { error: string; errorCode?: GitCloneResult['errorCode'] } {
  if (/already exists and is not an empty directory/i.test(stderr)) {
    return { error: '目标目录已存在且非空，请换一个目录。' }
  }
  if (/Authentication failed|Permission denied \(publickey\)|could not read Username/i.test(stderr)) {
    return {
      error: '仓库认证失败：请检查账号权限；若使用 SSH 且私钥设有口令，请先加载 SSH 私钥。',
      errorCode: 'ssh-passphrase'
    }
  }
  if (/Repository not found|could not read from remote repository/i.test(stderr)) {
    return { error: '仓库不存在，或当前账号没有访问权限。' }
  }
  if (/Could not resolve host/i.test(stderr)) {
    return { error: '无法解析仓库主机名，请检查网络或 VPN/代理设置。' }
  }
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return { error: lines[lines.length - 1] || '克隆失败' }
}

/** 取消后清理半截克隆目录（失败仅忽略，目录可能已被 git 自己清掉） */
async function cleanupPartialClone(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * 克隆仓库到指定父目录；promise 挂起至克隆结束才 resolve，
 * 期间进度经 onProgress 回调推送（由 IPC 层转发给渲染进程）。
 */
export async function cloneRepository(
  options: GitCloneOptions,
  onProgress: (payload: GitCloneProgressPayload) => void
): Promise<GitCloneResult> {
  const url = cleanUrl(options.url ?? '')
  const parentDir = options.parentDir?.trim()
  if (!url) return { success: false, error: '请输入仓库地址。' }
  if (!parentDir) return { success: false, error: '请选择克隆到的目录。' }

  // 目录去重：name、name-1 … name-19
  const baseName = deriveRepoDirName(url)
  let targetPath: string | null = null
  for (let i = 0; i < MAX_DIR_NAME_TRIES; i++) {
    const candidate = path.join(parentDir, i === 0 ? baseName : `${baseName}-${i}`)
    if (!existsSync(candidate)) {
      targetPath = candidate
      break
    }
  }
  if (!targetPath) return { success: false, error: '目标目录下同名文件夹太多，请手动清理后再试。' }

  const cloneId = randomUUID()
  const target = targetPath

  return new Promise<GitCloneResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(resolveGitExecutable(), ['clone', '--progress', url, target], {
        cwd: parentDir,
        windowsHide: true,
        // stdin/stdout 不需要；进度全在 stderr
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
    } catch (error) {
      resolve({ success: false, error: error instanceof Error ? error.message : '克隆启动失败' })
      return
    }

    const entry = { child, cancelled: false, targetPath: target }
    activeClones.set(cloneId, entry)

    let percentage = 0
    let stderrTail = ''
    let progressBuffer = ''
    let settled = false

    const report = (pct: number, message: string): void => {
      // 只前进不回退：Receiving 的数字可能因重新计数而回跳
      if (pct <= percentage) return
      percentage = pct
      try {
        onProgress({ cloneId, percentage, message })
      } catch {
        // 进度回调（渲染进程已销毁等）不影响克隆本身
      }
    }

    /** git 的进度经 \r 覆盖同行刷新，按 \r\n 切行 */
    const handleProgressChunk = (chunk: string): void => {
      progressBuffer += chunk
      const lines = progressBuffer.split(/[\r\n]+/)
      progressBuffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        let match: RegExpMatchArray | null
        if ((match = line.match(/Counting objects:\s+(\d+)%/))) {
          report(Math.floor(Number(match[1]) * 0.1), line)
        } else if ((match = line.match(/Compressing objects:\s+(\d+)%/))) {
          report(10 + Math.floor(Number(match[1]) * 0.1), line)
        } else if ((match = line.match(/Receiving objects:\s+(\d+)%/))) {
          report(20 + Math.floor(Number(match[1]) * 0.4), line)
        } else if ((match = line.match(/Resolving deltas:\s+(\d+)%/))) {
          report(60 + Math.floor(Number(match[1]) * 0.4), line)
        }
      }
    }

    const settle = (result: GitCloneResult): void => {
      if (settled) return
      settled = true
      activeClones.delete(cloneId)
      resolve(result)
    }

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8')
      handleProgressChunk(text)
      stderrTail = (stderrTail + text).slice(-4096)
    })

    child.on('error', () => {
      settle({ success: false, error: '未找到可用的 Git，请确认已安装并加入 PATH。' })
    })

    child.on('close', (code) => {
      if (entry.cancelled) {
        void cleanupPartialClone(target).then(() =>
          settle({ success: false, error: '克隆已取消', errorCode: 'clone-cancelled' })
        )
        return
      }
      if (code === 0) {
        report(100, '完成')
        settle({ success: true, finalPath: target })
        return
      }
      const { error, errorCode } = classifyCloneError(stderrTail)
      void cleanupPartialClone(target).then(() => settle({ success: false, error, errorCode }))
    })
  })
}

/** 取消进行中的克隆（幂等：任务已结束时也返回成功） */
export function cancelClone(cloneId: string): GitResult {
  const entry = activeClones.get(cloneId)
  if (!entry) return { success: true }
  entry.cancelled = true
  try {
    entry.child.kill()
    return { success: true }
  } catch {
    return { success: false, error: '取消克隆失败' }
  }
}
