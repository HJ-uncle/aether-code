import type { AccountState } from '@shared/account'

export interface AccountOnboarding {
  serviceUrl: string
  userId: string
  tenantId: string
}

export function onboardingFor(account: AccountState): AccountOnboarding | null {
  return account.status === 'authenticated' && account.user ? {
    serviceUrl: account.serviceUrl.replace(/\/+$/, ''), userId: account.user.id, tenantId: account.user.tenantId
  } : null
}

export function isOnboardingAccount(request: AccountOnboarding | null, account: AccountState): boolean {
  const current = onboardingFor(account)
  return !!request && !!current && request.serviceUrl === current.serviceUrl &&
    request.userId === current.userId && request.tenantId === current.tenantId
}

/** Transport resets temporarily have no user; only a confirmed account change
 * or sign-out can discard the post-registration interaction. */
export function reconcileOnboarding(request: AccountOnboarding | null, account: AccountState): AccountOnboarding | null {
  if (!request) return null
  if (account.serviceUrl && request.serviceUrl !== account.serviceUrl.replace(/\/+$/, '')) return null
  if (account.status === 'signed-out') return null
  if (account.user && (request.userId !== account.user.id || request.tenantId !== account.user.tenantId)) return null
  return request
}
