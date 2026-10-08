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
export interface AccountApi {
  getState(): Promise<AccountState>
  register(): Promise<AccountState>
  login(recoveryKey: string): Promise<AccountState>
  updateProfile(input: AccountProfileInput): Promise<AccountState>
  logout(all?: boolean): Promise<AccountState>
  sessions(): Promise<AccountSession[]>
  revokeSession(id: string): Promise<void>
  exportRecovery(): Promise<boolean>
  importRecovery(): Promise<AccountState | null>
  externalLogin(providerId: string, mode: 'login' | 'link', credential?: string): Promise<AccountState>
  cancelExternalLogin(): Promise<void>
  unlink(providerId: string): Promise<AccountState>
  onChanged(listener: (state: AccountState) => void): () => void
}
