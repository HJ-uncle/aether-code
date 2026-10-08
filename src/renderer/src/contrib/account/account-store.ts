import { useEffect, useSyncExternalStore } from 'react'
import type { AccountState } from '@shared/account'
import { getExpectedEngine, isEngineReady, subscribeEngineSource } from '@renderer/core/engine/source'
import { onboardingFor, reconcileOnboarding, type AccountOnboarding } from './account-onboarding'

const INITIAL: AccountState = {
  status: 'unavailable', user: null, providers: [], serviceUrl: '',
  persistence: 'none', message: null, registrationEnabled: false
}
let snapshot: { account: AccountState; loading: boolean; error: string; onboarding: AccountOnboarding | null } = {
  account: INITIAL, loading: true, error: '', onboarding: null
}
let revision = 0
let initialized = false
let pending: Promise<void> | null = null
let refreshQueued = false
const listeners = new Set<() => void>()
const notify = (): void => { for (const listener of listeners) listener() }

export function publishAccountState(account: AccountState): void {
  const engine = getExpectedEngine()
  // Once a transport is ready it is authoritative: a delayed account read from
  // another endpoint must not bring its profile back into the title bar/form.
  if (isEngineReady() && engine.baseUrl.replace(/\/+$/, '') !== account.serviceUrl.replace(/\/+$/, '')) return
  revision++
  snapshot = { account, loading: false, error: '', onboarding: reconcileOnboarding(snapshot.onboarding, account) }
  notify()
}

export function requestAccountOnboarding(account: AccountState): void {
  const request = onboardingFor(account)
  if (!request) return
  snapshot = { ...snapshot, onboarding: reconcileOnboarding(request, snapshot.account) }
  notify()
}

export function dismissAccountOnboarding(): void {
  snapshot = { ...snapshot, onboarding: null }
  notify()
}

export async function refreshAccount(): Promise<void> {
  if (pending) { refreshQueued = true; return pending }
  const generation = revision
  snapshot = { ...snapshot, loading: true, error: '' }
  notify()
  const task = window.aether.account.getState().then((state) => {
    // A login/logout event arriving during this read is already newer.
    if (generation === revision) publishAccountState(state)
  }).catch(() => {
    if (generation === revision) {
      snapshot = { ...snapshot, loading: false, error: '暂时无法读取账号状态，请重试。' }
      notify()
    }
  }).finally(() => {
    if (pending === task) pending = null
    if (refreshQueued) { refreshQueued = false; void refreshAccount() }
  })
  pending = task
  return task
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useAccount(): typeof snapshot {
  const value = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(() => {
    if (initialized) return
    initialized = true
    window.aether.account.onChanged(publishAccountState)
    subscribeEngineSource(() => {
      // Clear before requesting the new scope, so the previous user's editable
      // form and third-party credentials cannot remain actionable while loading.
      revision++
      snapshot = { ...snapshot, account: INITIAL, loading: true, error: '' }
      notify()
      void refreshAccount()
    })
    void refreshAccount()
  }, [])
  return value
}

export const ACCOUNT_STATUS_LABELS: Record<AccountState['status'], string> = {
  'signed-out': '未登录', authenticated: '已登录', offline: '离线', expired: '登录已过期', unavailable: '账号服务不可用'
}
