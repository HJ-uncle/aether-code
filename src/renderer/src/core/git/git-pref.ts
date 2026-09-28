/**
 * Git 偏好持久化（移植自 wuzu-client stores/codeGitPref.ts）
 *
 * 承载「后台自动获取远端更新」的开关与间隔。aether 无 Pinia，
 * 也没有适合存「布尔+毫秒」这类小偏好的主进程 settings 通道（现有 settings 是
 * 应用级外观/引擎配置），故与 wuzu 一致用 localStorage，读写都 try/catch。
 *
 * 与 wuzu 版差异：pull 用 merge/rebase 的记忆在 wuzu 里是主进程写进仓库
 * git config（pull.rebase）的，渲染层只传 remember 标记，无需在此持久化。
 */

const STORAGE_KEY = 'aether:git:autoFetch'

const DEFAULT_AUTO_FETCH = true
const DEFAULT_INTERVAL_MS = 180000
/** 间隔下限 30s：太密会把 git fetch IPC 打爆；上限 1h 防误输入 */
const MIN_INTERVAL_MS = 30000
const MAX_INTERVAL_MS = 3600000

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(value)))
}

function loadAutoFetch(): boolean {
  try {
    return localStorage.getItem(`${STORAGE_KEY}:enabled`) !== '0'
  } catch {
    return DEFAULT_AUTO_FETCH
  }
}

function loadIntervalMs(): number {
  try {
    const raw = Number(localStorage.getItem(`${STORAGE_KEY}:intervalMs`))
    if (!raw) return DEFAULT_INTERVAL_MS
    return clampInterval(raw)
  } catch {
    return DEFAULT_INTERVAL_MS
  }
}

let autoFetch = loadAutoFetch()
let autoFetchIntervalMs = loadIntervalMs()

export function getGitAutoFetch(): boolean {
  return autoFetch
}

export function getGitAutoFetchIntervalMs(): number {
  return autoFetchIntervalMs
}

export function setGitAutoFetch(value: boolean): void {
  autoFetch = value
  try {
    localStorage.setItem(`${STORAGE_KEY}:enabled`, value ? '1' : '0')
  } catch {
    /* 忽略：localStorage 不可用时仅本次会话生效 */
  }
}

export function setGitAutoFetchIntervalMs(value: number): void {
  autoFetchIntervalMs = clampInterval(value)
  try {
    localStorage.setItem(`${STORAGE_KEY}:intervalMs`, String(autoFetchIntervalMs))
  } catch {
    /* 忽略 */
  }
}
