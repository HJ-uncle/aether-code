import type { FamilyChild, FamilyOverview } from '../../shared/account'
import { validCredential, type AccountCredential } from './credential-store'

const managedChildTenant = /^account_child_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const badName = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export function familyChildId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('子账号标识无效，请刷新列表。')
  return value
}
export function familyName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || badName.test(value)) throw new Error('请输入 1 至 80 个字符的子账号名称。')
  return value.trim()
}
export function familyParent(scope: unknown, url: string, current: AccountCredential | null): AccountCredential {
  const user = current?.user
  if (!record(scope) || !current || !user?.sessionId || scope.serviceUrl !== url || scope.userId !== user.id ||
      scope.tenantId !== user.tenantId || scope.sessionId !== user.sessionId) throw new Error('服务或账号已切换，请在当前账号页重试。')
  if (user.accountKind !== 'primary' || user.mainAccountActivated !== true) throw new Error('只有已开通的主账号可以管理子账号。')
  return current
}
export function familyChild(raw: unknown, parentId: string): FamilyChild {
  if (!record(raw) || typeof raw.id !== 'string' || !uuid.test(raw.id) || raw.id === parentId ||
      typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80 || badName.test(raw.name) ||
      (raw.status !== 'active' && raw.status !== 'disabled') || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new Error('服务返回的子账号资料无效，请刷新核对。')
  }
  return { id: raw.id, name: raw.name, status: raw.status, createdAt: raw.createdAt }
}
export function familyOverview(raw: unknown, parentId: string): FamilyOverview {
  const bad = (): never => { throw new Error('服务返回的子账号列表不完整，请刷新重试。') }
  if (!record(raw) || typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 0 || raw.limit > 100 ||
      !Array.isArray(raw.children) || raw.children.length > raw.limit || raw.used !== raw.children.length) return bad()
  const children = raw.children.map((item: unknown) => familyChild(item, parentId))
  if (new Set(children.map(child => child.id)).size !== children.length) return bad()
  return { limit: raw.limit, used: children.length, children }
}
export function delegatedCredential(raw: unknown, parent: AccountCredential, selectedId: string): AccountCredential {
  if (!validCredential(raw) || raw.recoveryKey !== undefined || raw.user.id !== selectedId || raw.user.id === parent.user.id ||
      raw.user.accountKind !== 'child' || raw.user.mainAccountActivated !== false || raw.user.tenantId === parent.user.tenantId || !managedChildTenant.test(raw.user.tenantId) ||
      !raw.user.sessionId || raw.user.sessionId === parent.user.sessionId || raw.accessToken === parent.accessToken || raw.refreshToken === parent.refreshToken || Date.parse(raw.expiresAt) <= Date.now()) {
    throw new Error('服务未返回所选子账号的独立登录会话，已保留主账号。')
  }
  const { user, accessToken, refreshToken, expiresAt } = raw
  return { user, accessToken, refreshToken, expiresAt }
}

