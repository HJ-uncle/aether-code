/** Clone progress and cancellation share the audited native process lifetime.
 * A result or cancel acknowledgement never races a still-writing descendant. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, lstatSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { GitCloneOptions, GitCloneProgressPayload, GitCloneResult, GitResult } from '../../shared/git-types'
import { assertAllowed } from '../fs/file-service'
import { resolveGitExecutable } from './git-resolver'
import { withRepositoryLease, prepareCloneDestinationLock, cloneDestinationLock, repositoryFailureMetadata } from './repository-lease'

const MAX_DIR_NAME_TRIES = 20
const CLONE_TIMEOUT_MS = 30 * 60_000
const CANCEL_JOIN_MS = 15_000
const activeClones = new Map<string, { controller: AbortController; completion: Promise<GitCloneResult> }>()

function deriveRepoDirName(url: string): string {
  const name = (url.split(/[?#]/)[0] ?? '').replace(/[/\\]+$/, '').split(/[/\\]/).pop()?.replace(/\.git$/i, '').replace(/[<>:"|?*\u0000-\u001f]/g, '').slice(0, 120)
  return !name || name === '.' || name === '..' ? 'repository' : name
}
function classifyCloneError(error: unknown): GitCloneResult {
  const value = error as { code?: string; stderr?: string; message?: string }
  const text = value.stderr || value.message || String(error)
  const metadata=repositoryFailureMetadata(error)
  if (value.code === 'GIT_REPOSITORY_QUARANTINED') return { ...metadata, success: false, error: '克隆的后台进程未能确认停止。已保留目录，请检查恢复状态后重试。', errorCode: 'git-quarantined' }
  if (value.code === 'ABORT_ERR') return { ...metadata, success: false, error: '克隆已取消', errorCode: 'clone-cancelled' }
  if (value.code === 'ETIMEDOUT') return { ...metadata, success: false, error: '克隆超过 30 分钟，已安全停止。请检查网络后重试。' }
  if (/Authentication failed|Permission denied \(publickey\)|could not read Username/i.test(text)) return { ...metadata, success: false, error: '仓库认证失败：请检查账号权限；若使用 SSH 且私钥设有口令，请先加载 SSH 私钥。', errorCode: 'ssh-passphrase' }
  if (/Repository not found|could not read from remote repository/i.test(text)) return { ...metadata, success: false, error: '仓库不存在，或当前账号没有访问权限。' }
  if (/Could not resolve host/i.test(text)) return { ...metadata, success: false, error: '无法解析仓库主机名，请检查网络或代理设置。' }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return { ...metadata, success: false, error: lines.at(-1) || '克隆失败' }
}

export async function cloneRepository(options: GitCloneOptions, onProgress: (payload: GitCloneProgressPayload) => void): Promise<GitCloneResult> {
  const url = (options.url ?? '').trim().replace(/^git\s+clone\s+/i, '')
  if (!url) return { success: false, error: '请输入仓库地址。' }
  if (!options.parentDir?.trim()) return { success: false, error: '请选择克隆到的目录。' }
  let parent: string
  try { parent = assertAllowed(options.parentDir.trim()) } catch (error) { return classifyCloneError(error) }
  if (/[\r\n\u0000]/.test(url) || url.startsWith('-')) return { success: false, error: '仓库地址无效。' }
  const baseName = deriveRepoDirName(url)
  let target: string | undefined
  for (let index = 0; index < MAX_DIR_NAME_TRIES; index++) {
    const candidate = path.join(parent, index ? `${baseName}-${index}` : baseName)
    if (!existsSync(candidate) && !existsSync(cloneDestinationLock(candidate))) { target = candidate; break }
  }
  if (!target) return { success: false, error: '目标目录下同名文件夹太多，请选择其他目录。' }
  const cloneTarget = target
  const cloneId = randomUUID()
  const controller = new AbortController()
  let finish!: (result: GitCloneResult) => void
  const completion = new Promise<GitCloneResult>(resolve => { finish = resolve })
  activeClones.set(cloneId, { controller, completion })
  let percentage = 0, progressBuffer = ''
  const report = (value: number, message: string): void => {
    if (value < percentage || value === percentage && value !== 0) return
    percentage = value
    try { onProgress({ cloneId, percentage, message }) } catch { /* Closing a window does not orphan the running job. */ }
  }
  const progress = (chunk: string): void => {
    progressBuffer = (progressBuffer + chunk).slice(-16 * 1024)
    const lines = progressBuffer.split(/[\r\n]+/)
    progressBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const match = /(Counting|Compressing|Receiving|Resolving) (?:objects|deltas):\s+(\d+)%/.exec(line)
      if (!match) continue
      const [start, weight] = match[1] === 'Counting' ? [0, .1] : match[1] === 'Compressing' ? [10, .1] : match[1] === 'Receiving' ? [20, .4] : [60, .4]
      report(Math.min(99, start + Math.floor(Number(match[2]) * weight)), line.trim())
    }
  }
  let result: GitCloneResult
  try {
    const lease = prepareCloneDestinationLock(cloneTarget)
    result = await withRepositoryLease(lease, async (scope, assertOwned) => {
      assertOwned()
      // mkdir reserves an exact new filesystem identity. Never delete a target
      // which existed before this clone or was replaced during cancellation.
      mkdirSync(cloneTarget)
      const identity = lstatSync(cloneTarget)
      report(0, '正在准备克隆…')
      try {
        await scope.run(resolveGitExecutable(), ['clone', '--progress', '--', url, cloneTarget], { cwd: parent, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: CLONE_TIMEOUT_MS, maxBytes: 20 * 1024 * 1024, signal: controller.signal, onStderr: progress })
        return { success: true, finalPath: cloneTarget }
      } catch (error) {
        // close requires durable zero-members proof. Supervisor crashes retain
        // the directory and lease as evidence instead of deleting live data.
        await scope.close()
        assertOwned()
        if (existsSync(cloneTarget)) {
          const current = lstatSync(cloneTarget)
          if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('克隆目标目录已被替换，已保留现场。')
          await rm(cloneTarget, { recursive: true, force: true })
        }
        if (controller.signal.aborted) return { success: false, error: '克隆已取消', errorCode: 'clone-cancelled' }
        return classifyCloneError(error)
      }
    })
    if (result.success) report(100, '完成')
  } catch (error) { result = classifyCloneError(error) }
  finally { activeClones.delete(cloneId) }
  finish(result)
  return result
}

/** An active cancel acknowledgement waits for audited process closure and
 * partial-directory cleanup. Repeating a finished cancellation is harmless. */
export async function cancelClone(cloneId: string): Promise<GitResult> {
  const entry = activeClones.get(cloneId)
  if (!entry) return { success: true }
  entry.controller.abort()
  let deadline: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([entry.completion,new Promise<GitCloneResult>(resolve=>{deadline=setTimeout(()=>resolve({success:false,error:'取消请求已发出，后台仍在确认停止。请稍后检查状态。',errorCode:'git-busy',executionDisposition:'may_have_effects'}),CANCEL_JOIN_MS)})]).finally(()=>clearTimeout(deadline))
  return result.success || result.errorCode === 'clone-cancelled' ? { success: true } : { success: false, error: result.error || '取消克隆未能确认完成', errorCode: result.errorCode, executionDisposition:'may_have_effects' }
}
