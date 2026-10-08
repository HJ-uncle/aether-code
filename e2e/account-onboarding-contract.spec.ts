/** Post-registration UI survives transport reset and stays bound to one user/service. */
import { expect, test } from '@playwright/test'
import type { AccountState } from '../src/shared/account'
import { isOnboardingAccount, onboardingFor, reconcileOnboarding } from '../src/renderer/src/contrib/account/account-onboarding'

const account: AccountState = {
  status: 'authenticated', serviceUrl: 'https://accounts.example.test', persistence: 'session',
  providers: [], registrationEnabled: true, message: null,
  user: { id: 'registered-user', tenantId: 'tenant-a', name: '新用户', email: null, bio: null, avatarUrl: null, userData: {}, identities: [], createdAt: '2026-10-08T00:00:00Z' }
}

test('首登请求跨暂时空资料和同服务重连保留，恢复资料后继续显示', () => {
  const request = onboardingFor(account)
  const resetting = { ...account, status: 'unavailable' as const, user: null, serviceUrl: '' }
  expect(reconcileOnboarding(request, resetting)).toEqual(request)
  expect(isOnboardingAccount(request, resetting)).toBe(false)
  expect(isOnboardingAccount(reconcileOnboarding(request, resetting), { ...account, serviceUrl: account.serviceUrl + '/' })).toBe(true)
})

test('切换账号、租户、服务或确认退出时不能把首登弹窗移给别人', () => {
  const request = onboardingFor(account)
  for (const other of [
    { ...account, user: { ...account.user!, id: 'other-user' } },
    { ...account, user: { ...account.user!, tenantId: 'other-tenant' } },
    { ...account, serviceUrl: 'https://other.example.test' },
    { ...account, status: 'signed-out' as const, user: null }
  ]) {
    expect(reconcileOnboarding(request, other)).toBeNull()
    expect(isOnboardingAccount(request, other)).toBe(false)
  }
  expect(reconcileOnboarding(null, account)).toBeNull()
})
