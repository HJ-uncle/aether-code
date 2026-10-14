import assert from 'node:assert/strict'
import { stressCronEditableSHA256 } from './stress-subagent-archive.mjs'

const shaPattern = /^[a-f0-9]{64}$/
const positiveRevision = value => Number.isSafeInteger(value) && value > 0

function validateOwner(owner) {
  assert.ok(owner && ['tenantId', 'ownerRunId', 'lane', 'sessionId', 'jobId'].every(key => typeof owner[key] === 'string' && owner[key]), 'Owned Cron receipt identity is required')
}

function validateJob(job, owner) {
  validateOwner(owner)
  assert.equal(job?.id, owner.jobId, 'Foreign Cron job')
  assert.equal(job.tenantId, owner.tenantId, 'Foreign Cron tenant')
  assert.equal(job.sessionId, owner.sessionId, 'Foreign Cron session')
  assert.deepEqual(job.configuration?.target, { kind: 'session', sessionId: owner.sessionId }, 'Foreign Cron target')
  assert.ok(positiveRevision(job.revision) && positiveRevision(job.scheduleRevision), 'Owned Cron update lacks durable revisions')
}

/** A receipt is written only after the exact conditional mutation has returned its durable row. */
export function createStressCronUpdateReceipt(before, after, owner, { method = 'PUT', path = `/api/v1/cron/${encodeURIComponent(owner.jobId)}`, at = new Date().toISOString() } = {}) {
  validateJob(before, owner); validateJob(after, owner)
  assert.equal(method, 'PUT', 'Owned Cron writes require the revision-aware update route')
  assert.equal(path, `/api/v1/cron/${encodeURIComponent(owner.jobId)}`, 'Foreign Cron mutation route')
  assert.ok(Number.isFinite(Date.parse(at)), 'Invalid Cron receipt timestamp')
  assert.equal(after.revision, before.revision + 1, 'Cron mutation must advance exactly one revision')
  const changedSchedule = before.enabled !== after.enabled || JSON.stringify(before.configuration.schedule) !== JSON.stringify(after.configuration.schedule)
  assert.equal(after.scheduleRevision, before.scheduleRevision + Number(changedSchedule), 'Cron schedule revision does not match its mutation')
  return {
    type: 'owned-cron-config-update', schemaVersion: 1, at, ...owner, method, path,
    beforeRevision: before.revision, beforeScheduleRevision: before.scheduleRevision, beforeEditableSHA256: stressCronEditableSHA256(before),
    revision: after.revision, scheduleRevision: after.scheduleRevision, editableSHA256: stressCronEditableSHA256(after)
  }
}

/** Responses can complete out of order; revisions, identities and linked hashes prove the chain. */
export function verifyStressCronReceiptChain(before, after, events, owner) {
  validateJob(before, owner); validateJob(after, owner)
  assert.ok(after.revision > before.revision, 'Automation changed without an advancing owned revision')
  assert.ok(Array.isArray(events), 'Cron update receipt list is required')
  const chain = events.filter(event => event?.type === 'owned-cron-config-update' && event.jobId === owner.jobId
    && event.revision > before.revision && event.revision <= after.revision).sort((left, right) => left.revision - right.revision)
  assert.equal(chain.length, after.revision - before.revision, 'Incomplete Cron receipt revision chain')
  let revision = before.revision, scheduleRevision = before.scheduleRevision, editableSHA256 = stressCronEditableSHA256(before)
  for (const event of chain) {
    assert.equal(event.schemaVersion, 1, 'Unknown Cron receipt schema')
    for (const key of ['tenantId', 'ownerRunId', 'lane', 'sessionId', 'jobId']) assert.equal(event[key], owner[key], `Foreign Cron receipt ${key}`)
    assert.equal(event.method, 'PUT', 'Foreign Cron receipt method')
    assert.equal(event.path, `/api/v1/cron/${encodeURIComponent(owner.jobId)}`, 'Foreign Cron receipt path')
    assert.ok(Number.isFinite(Date.parse(event.at)), 'Invalid Cron receipt timestamp')
    assert.equal(event.beforeRevision, revision, 'Cron receipt previous revision mismatch')
    assert.equal(event.revision, revision + 1, 'Missing or duplicate Cron receipt revision')
    assert.equal(event.beforeScheduleRevision, scheduleRevision, 'Cron receipt previous schedule revision mismatch')
    assert.ok(positiveRevision(event.scheduleRevision) && event.scheduleRevision >= scheduleRevision && event.scheduleRevision <= scheduleRevision + 1, 'Cron receipt schedule revision regressed or skipped')
    assert.ok(shaPattern.test(event.beforeEditableSHA256) && shaPattern.test(event.editableSHA256), 'Invalid Cron receipt hash')
    assert.equal(event.beforeEditableSHA256, editableSHA256, 'Cron receipt hash chain mismatch')
    revision = event.revision; scheduleRevision = event.scheduleRevision; editableSHA256 = event.editableSHA256
  }
  assert.equal(scheduleRevision, after.scheduleRevision, 'Final Cron schedule revision mismatch')
  assert.equal(editableSHA256, stressCronEditableSHA256(after), 'Final Cron editable hash mismatch')
  return chain
}

/** The workload driver uses direct HTTP, so renderer Cron writes are never expected during cancel. */
export function isStressCronRendererMutation(input) {
  const method = String(input?.method ?? 'GET').toUpperCase(), pathname = String(input?.path ?? '').split('?')[0]
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !(pathname === '/cron' || pathname.startsWith('/cron/'))) return false
  return !(method === 'POST' && pathname === '/cron/preview')
}

/** Serialize each owned job without blocking independent jobs or retrying an ambiguous write. */
export class StressCronMutationRecorder {
  constructor({ owners, readJob, writeJob, record }) {
    assert.ok(Array.isArray(owners) && owners.length && typeof readJob === 'function' && typeof writeJob === 'function' && typeof record === 'function', 'Cron mutation dependencies are required')
    owners.forEach(validateOwner)
    assert.equal(new Set(owners.map(owner => owner.jobId)).size, owners.length, 'Duplicate owned Cron job')
    this.owners = new Map(owners.map(owner => [owner.jobId, owner]))
    this.readJob = readJob; this.writeJob = writeJob; this.record = record
    this.tails = new Map(); this.heads = new Map()
  }

  mutate(jobId, patch) {
    const owner = this.owners.get(jobId)
    assert.ok(owner, 'Cannot mutate an unowned Cron job')
    assert.ok(patch && typeof patch === 'object' && !Array.isArray(patch), 'Cron patch object is required')
    const mutationPatch = structuredClone(patch)
    const operation = (this.tails.get(jobId) ?? Promise.resolve()).then(async () => {
      const before = await this.readJob(jobId)
      validateJob(before, owner)
      const head = this.heads.get(jobId)
      assert.ok(!head || head.revision === before.revision && head.scheduleRevision === before.scheduleRevision && head.editableSHA256 === stressCronEditableSHA256(before), 'Cron changed outside the owned mutation chain')
      assert.ok(mutationPatch.expectedRevision === undefined || mutationPatch.expectedRevision === before.revision, 'Caller supplied a stale Cron revision')
      const after = await this.writeJob(jobId, { ...mutationPatch, expectedRevision: before.revision })
      const receipt = createStressCronUpdateReceipt(before, after, owner)
      // A confirmed server row remains owned even if evidence storage fails; cleanup must still disable it.
      this.heads.set(jobId, { revision: after.revision, scheduleRevision: after.scheduleRevision, editableSHA256: receipt.editableSHA256 })
      await this.record(receipt)
      return after
    })
    // A rejected operation still releases the queue; the owner sees the original rejection and decides to stop.
    const tail = operation.then(() => {}, () => {})
    this.tails.set(jobId, tail)
    void tail.then(() => { if (this.tails.get(jobId) === tail) this.tails.delete(jobId) })
    return operation
  }
}
