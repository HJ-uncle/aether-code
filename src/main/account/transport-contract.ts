import type { AccountState } from '../../shared/account'
import { remoteAuthTarget } from '../engine/remote-auth-contract'

/** Trust includes the port and path: confirming one service cannot approve another. */
export function accountTransport(value: string, trustedServices: readonly string[]): NonNullable<AccountState['transport']> {
  const target = remoteAuthTarget(value)
  const url = new URL(target)
  if (url.protocol === 'https:') return 'secure'
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'local'
  return trustedServices.includes(target) ? 'http-trusted' : 'http-untrusted'
}
