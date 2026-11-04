import test from 'node:test'
import assert from 'node:assert/strict'
import { assertResendBranch, assertProbeCalls } from './live-steering-phases.mjs'

function fixture() {
  const original = { id: 'old-user', role: 'user', content: 'exact prompt', conversationId: 'old-turn' }
  const call = { id: 'old-call', role: 'assistant', conversationId: 'old-turn', toolCall: { id: 'c1', name: 'execute_cmd', args: { command: 'node', args: ['validation/probe.mjs','window','code','stop'] } } }
  return { original, prompt: 'exact prompt', cancelled: { runId: 'old-run', turnId: 'old-turn' }, next: { runId: 'new-run', turnId: 'new-turn' },
    cancelledHistory: [original, call, { id: 'old-result', role: 'tool', toolCallId: 'c1', conversationId: 'old-turn', metadata: { status: 'cancelled' } }],
    history: [{ id: 'new-user', role: 'user', content: 'exact prompt', conversationId: 'new-turn', metadata: { rootRunId: 'new-run' } }] }
}
test('confirmed resend replaces active history while audit snapshots keep cancellation', () => {
  const value = fixture(), originalIds = value.history.map(row => row.id)
  const result = assertResendBranch(value)
  assert.deepEqual(result.deletedMessageIds, ['old-user','old-call','old-result'])
  assert.deepEqual(value.history.map(row => row.id), originalIds)
  assert.equal(assertProbeCalls(result.commandEvidence, [{ turnId: 'old-turn', args: ['window','code','stop'] }]).length, 1)
})
test('rejects cancelled tool context leaking into the resent turn archive', () => {
  const value = fixture(); value.history.push(value.cancelledHistory[2])
  assert.throws(() => assertResendBranch(value), /kept deleted old-turn/)
})
test('rejects edited resend content and duplicate seeds', () => {
  const edited = fixture(); edited.history[0].content = 'changed'
  assert.throws(() => assertResendBranch(edited), /exact original prompt/)
  const duplicate = fixture(); duplicate.history.push({ ...duplicate.history[0], id: 'duplicate' })
  assert.throws(() => assertResendBranch(duplicate), /exact original prompt/)
})
test('requires cancellation receipt and new root identity', () => {
  const missing = fixture(); missing.cancelledHistory.pop()
  assert.throws(() => assertResendBranch(missing), /cancellation result/)
  const wrong = fixture(); wrong.history[0].metadata.rootRunId = 'old-run'
  assert.throws(() => assertResendBranch(wrong))
})
