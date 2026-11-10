import { invalidateCommandSession } from './command-job-store'
import { forgetSubagentSession } from './subagent-store'

/** Call only after a confirmed history mutation. The replacement snapshot will
 * rehydrate retained work; resident or in-flight old work cannot become orphan
 * messages and billing in the new transcript. */
export function invalidateHistoryRuntimeCache(sessionId: string): void {
  forgetSubagentSession(sessionId)
  invalidateCommandSession(sessionId)
}
