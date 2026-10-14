import { sameRecoveryScope, type RecoveryScope } from './chat-recovery-loop'

export interface HistoryMutationToken {
  readonly scope: Readonly<RecoveryScope>
}

/** Passive history readers must not race a destructive write and its intended reload. */
export function createHistoryMutationGuard(): {
  begin: (scope: RecoveryScope) => HistoryMutationToken
  blocked: (scope: RecoveryScope) => boolean
  release: (token: HistoryMutationToken) => void
} {
  let current: HistoryMutationToken | null = null
  return {
    begin(scope) {
      const token = Object.freeze({ scope: Object.freeze({ ...scope }) })
      current = token
      return token
    },
    blocked: scope => Boolean(current && sameRecoveryScope(current.scope, scope)),
    // A slow old view's finally must not unlock a newer mutation after navigation.
    release(token) { if (current === token) current = null }
  }
}
