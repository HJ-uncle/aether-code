import type { EngineSnapshot, RemoteAuthCredential, RemoteAuthStatus } from './ipc'

/** Public account state deliberately excludes access, refresh and recovery credentials. */
export type AccountData = { [key: string]: unknown }
export interface AccountIdentity {
  providerId: string
  subject: string
  name?: string | null
  email?: string | null
  avatarUrl?: string | null
  userData?: AccountData
  createdAt?: string
}
export interface AccountUser {
  accountKind?: 'primary' | 'child'
  id: string
  tenantId: string
  name: string
  email: string | null
  avatarUrl: string | null
  bio: string | null
  userData: AccountData
  createdAt: string
  identities: AccountIdentity[]
  sessionId?: string
  authenticatedAt?: string
  mainAccountActivated?: boolean
  roles?: string[]
}
export interface AccountProvider {
  id: string
  name: string
  type: 'oidc' | 'oauth2' | 'credential'
}
export interface AccountState {
  status: 'signed-out' | 'authenticated' | 'offline' | 'expired' | 'unavailable'
  user: AccountUser | null
  providers: AccountProvider[]
  serviceUrl: string
  persistence: 'encrypted' | 'session' | 'none'
  message: string | null
  registrationEnabled: boolean
  childPasswordAvailable?: boolean
  transport?: 'secure' | 'local' | 'http-trusted' | 'http-untrusted'
  connectionMode?: 'embedded' | 'remote'
  recovery?: { available: boolean; exportedAt: string | null }
}
export interface AccountProfileInput {
  name?: string
  email?: string | null
  avatarUrl?: string | null
  bio?: string | null
  userData?: AccountData
}
export interface AccountSession {
  id: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string
  current: boolean
}
/** A revision is a compare-and-save token, never an identity, key, or fingerprint of a secret. */
export interface ServiceCredentialContext { revision: number; status: RemoteAuthStatus | null }
export interface MainAccountActivation { code: string; serviceUrl: string }
export interface ChildPasswordScope { serviceUrl: string; userId: string | null; tenantId: string | null; sessionId: string | null }
export interface ChildLoginInfo { loginName: string | null }
export type ChildPasswordProof = { currentPassword: string } | { recoveryKey: string }
export interface FamilyIdentity { serviceUrl: string; userId: string; tenantId: string; sessionId: string }
export interface FamilyChild { id: string; name: string; status: 'active' | 'disabled'; createdAt: string }
export interface FamilyOverview { limit: number; used: number; children: FamilyChild[] }
export interface AccountApi {
  family(scope: FamilyIdentity): Promise<FamilyOverview>
  createChild(scope: FamilyIdentity, name: string): Promise<void>
  setChildStatus(scope: FamilyIdentity, childId: string, enabled: boolean): Promise<void>
  enterChild(scope: FamilyIdentity, childId: string): Promise<AccountState>
  childPasswordLogin(scope: ChildPasswordScope, loginName: string, password: string): Promise<AccountState>
  copyChildResetCode(scope: ChildPasswordScope, currentPassword: string): Promise<void>
  childPasswordRecover(scope: ChildPasswordScope, loginName: string, recoveryKey: string, newPassword: string): Promise<void>
  getChildLoginInfo(scope: ChildPasswordScope, childId?: string): Promise<ChildLoginInfo>
  setManagedChildLogin(scope: ChildPasswordScope, childId: string, input: { loginName?: string; password?: string }): Promise<ChildLoginInfo>
  changeOwnChildPassword(scope: ChildPasswordScope, proof: ChildPasswordProof, newPassword: string): Promise<void>
  getServiceCredentialContext(serviceUrl: string): Promise<ServiceCredentialContext>
  applyServiceCredential(serviceUrl: string, revision: number, credential: RemoteAuthCredential | null): Promise<EngineSnapshot>
  getState(): Promise<AccountState>
  setHttpTrust(serviceUrl: string, trusted: boolean): Promise<AccountState>
  activatePrimary(activation: MainAccountActivation & { userId: string }): Promise<AccountState>
  register(activation: MainAccountActivation): Promise<AccountState>
  login(recoveryKey: string): Promise<AccountState>
  reauthenticate(recoveryKey: string): Promise<AccountState>
  updateProfile(input: AccountProfileInput): Promise<AccountState>
  logout(all?: boolean): Promise<AccountState>
  sessions(): Promise<AccountSession[]>
  revokeSession(id: string): Promise<void>
  exportRecovery(): Promise<boolean>
  regenerateRecovery(): Promise<AccountState>
  copyRecovery(): Promise<void>
  importRecovery(): Promise<AccountState | null>
  externalLogin(providerId: string, mode: 'login' | 'link' | 'reauth', credential?: string, activation?: MainAccountActivation): Promise<AccountState>
  cancelExternalLogin(): Promise<void>
  unlink(providerId: string): Promise<AccountState>
  onChanged(listener: (state: AccountState) => void): () => void
}
