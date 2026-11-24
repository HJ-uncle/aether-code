import type { ChildLoginInfo, ChildPasswordScope, AccountUser } from '../../shared/account'

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
export function checkChildScope(
  scope: unknown,
  serviceUrl: string,
  user: AccountUser | undefined
): asserts scope is ChildPasswordScope {
  if (
    !record(scope) ||
    scope.serviceUrl !== serviceUrl ||
    scope.userId !== (user?.id ?? null) ||
    scope.tenantId !== (user?.tenantId ?? null) ||
    scope.sessionId !== (user?.sessionId ?? null)
  )
    throw new Error('服务或账号已切换，请在当前账号页重试。')
}
export function childLoginPath(childId: unknown, required = false): string {
  if (childId === undefined && !required) return '/child-password/me'
  if (
    typeof childId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(childId)
  )
    throw new Error('子账号无效，请刷新列表。')
  return '/child-password/children/' + childId
}
export function loginValue(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,47}$/.test(v.trim()))
    throw new Error('登录名需为 3–48 位，以字母或数字开头，可使用点、下划线和短横线。')
  return v.trim().toLowerCase()
}
export function passwordValue(v: unknown, fresh = false): string {
  if (typeof v !== 'string' || !v || v.length > 512) throw new Error('请输入有效密码。')
  const len = Array.from(v.normalize('NFC')).length
  if (len > 128 || (fresh && len < 15)) throw new Error('新密码需为 15–128 个字符，可以使用空格。')
  return v
}
export function recoveryValue(v: unknown): string {
  if (typeof v !== 'string' || !/^aether_child_reset_[A-Za-z0-9_-]{43}$/.test(v.trim()))
    throw new Error('请输入子账号自己保存的密码恢复码。')
  return v.trim()
}
export function managementFields(v: unknown): { loginName?: string; password?: string } {
  if (
    !record(v) ||
    (v.loginName === undefined && v.password === undefined) ||
    Object.keys(v).some((k) => k !== 'loginName' && k !== 'password')
  )
    throw new Error('请填写登录名或新密码。')
  return {
    ...(v.loginName !== undefined ? { loginName: loginValue(v.loginName) } : {}),
    ...(v.password !== undefined ? { password: passwordValue(v.password, true) } : {})
  }
}
export function childProof(v: unknown): { currentPassword: string } | { recoveryKey: string } {
  if (!record(v) || Object.keys(v).length !== 1) throw new Error('请验证当前密码或恢复码。')
  if ('recoveryKey' in v) return { recoveryKey: recoveryValue(v.recoveryKey) }
  return { currentPassword: passwordValue(v.currentPassword) }
}
export function safeLoginInfo(v: unknown): ChildLoginInfo {
  if (
    !record(v) ||
    (v.loginName !== null &&
      (typeof v.loginName !== 'string' || loginValue(v.loginName) !== v.loginName))
  )
    throw new Error('服务返回的子账号登录名无效。')
  return { loginName: v.loginName as string | null }
}
