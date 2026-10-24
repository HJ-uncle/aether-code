/** Offline statistics/order checks only: importing the helper never touches the runner. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessRootActivity, classifyOfficeUiLoadReport, compareStableRows, rendererMeasurementComplete, summarizeNumbers } from '../office-ui-load-probe.mjs'
const row = (id, group = 'active') => ({ id, group })
test('empty/unsupported samples do not masquerade as zero latency', () => {
  assert.deepEqual(summarizeNumbers([null, undefined, NaN, -1, Infinity]), { count: 0, p50: null, p95: null, p99: null, max: null, over34: 0 })
})
test('nearest-rank percentiles and slow-frame count retain real outliers', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1)
  assert.deepEqual(summarizeNumbers(values), { count: 100, p50: 50, p95: 95, p99: 99, max: 100, over34: 66 })
  assert.equal(values[0], 1)
})

test('complete renderer coverage requires a full visible window and supported real samples', () => {
  const data = { elapsedMs: 90000, everHidden: false, visibility: [{ hidden: false }], longTaskSupported: true,
    frames: [{ hidden: false, interval: 16.6 }], heaps: [{ hidden: false, usedJSHeapSize: 1000000 }] }
  assert.equal(rendererMeasurementComplete(data), true)
  for (const patch of [{ elapsedMs: 89000 }, { everHidden: true }, { visibility: [{ hidden: true }] },
    { longTaskSupported: false }, { frames: [] }, { heaps: [{ hidden: false, usedJSHeapSize: null }] },
    { dropped: { frames: 1 } }, { dropped: { heaps: 1 } }]) {
    assert.equal(rendererMeasurementComplete({ ...data, ...patch }), false)
  }
})
test('new child insertion does not reorder persistent members', () => {
  assert.equal(compareStableRows([row('a'), row('b')], [row('new'), row('a'), row('b')]).stable, true)
})
test('completion/resumption moves are allowed across fixed sections', () => {
  assert.equal(compareStableRows([row('a'), row('b'), row('c', 'completed')],
    [row('b'), row('c'), row('a', 'completed')]).stable, true)
})
test('live updates cannot invert two existing members in the same section', () => {
  const result = compareStableRows([row('a'), row('b')], [row('b'), row('a')])
  assert.equal(result.stable, false); assert.deepEqual(result.reordered[0], { group: 'active', before: ['a', 'b'], after: ['b', 'a'] })
})
test('duplicate child across sections fails and bounded omission is allowed', () => {
  assert.deepEqual(compareStableRows([], [row('a'), row('a', 'completed')]).duplicates, ['a'])
  assert.equal(compareStableRows([row('a'), row('b')], [row('b')]).stable, true)
})

const activeRoles = ['finance', 'people', 'sales', 'operations', 'compliance']
const allRoles = [...activeRoles, 'pmo']
function activityFixture() {
  const pinned = Object.fromEntries(allRoles.map(role => [role, { runId: 'root-' + role, sessionId: 'session-' + role }]))
  const state = (role, active) => ({ running: active, run: { ...pinned[role], status: active ? 'running' : 'succeeded' } })
  const visits = allRoles.flatMap(role => Array.from({ length: 2 }, () => ({ role, checks: {}, apiBefore: state(role, role !== 'pmo'), apiAfter: state(role, role !== 'pmo') })))
  const samples = [{ roots: Object.fromEntries(allRoles.map(role => [role, state(role, role !== 'pmo')])) }]
  const report = activity => ({ errors: [], visits, performance: { measurementComplete: true, longTaskSupported: true },
    coverage: { rolesVisitedTwice: allRoles, rolesWithChildRows: allRoles, rootActivity: activity,
      stablePairsCompared: 2, activeRowsObserved: 5, completedRowsObserved: 1 } })
  return { pinned, visits, samples, state, report }
}

test('five real application roots and the completed PMO session satisfy this phase', () => {
  const f = activityFixture(), activity = assessRootActivity(f.visits, f.samples, f.pinned, activeRoles)
  assert.equal(activity.complete, true)
  assert.equal(activity.peak, 5)
  assert.equal(activity.completedPmoVerified, true)
  assert.deepEqual(activity.observedRunningRoles, activeRoles)
  assert.equal(classifyOfficeUiLoadReport(f.report(activity)), 'passed')
})

test('missing running coverage for any one of the five roles cannot pass', () => {
  for (const missing of activeRoles) {
    const f = activityFixture()
    for (const visit of f.visits.filter(visit => visit.role === missing)) visit.apiBefore = visit.apiAfter = f.state(missing, false)
    f.samples[0].roots[missing] = f.state(missing, false)
    const activity = assessRootActivity(f.visits, f.samples, f.pinned, activeRoles)
    assert.deepEqual(activity.missingActiveRoles, [missing])
    assert.equal(classifyOfficeUiLoadReport(f.report(activity)), 'incomplete', missing)
  }
})

test('a running or failed PMO root cannot substitute for the expected completed session', () => {
  for (const status of ['running', 'failed']) {
    const f = activityFixture()
    for (const visit of f.visits.filter(visit => visit.role === 'pmo')) {
      visit.apiBefore.run.status = visit.apiAfter.run.status = status
      visit.apiBefore.running = visit.apiAfter.running = status === 'running'
    }
    const activity = assessRootActivity(f.visits, f.samples, f.pinned, activeRoles)
    assert.equal(activity.completedPmoVerified, false)
    assert.equal(classifyOfficeUiLoadReport(f.report(activity)), 'incomplete')
  }
})

test('an old running root cannot supply the pinned role activity evidence', () => {
  const f = activityFixture()
  for (const visit of f.visits.filter(visit => visit.role === 'sales')) visit.apiBefore.run.runId = visit.apiAfter.run.runId = 'old-sales-root'
  const activity = assessRootActivity(f.visits, f.samples, f.pinned, activeRoles)
  assert.deepEqual(activity.missingActiveRoles, ['sales'])
  assert.equal(classifyOfficeUiLoadReport(f.report(activity)), 'incomplete')
})

test('separate single-role activity batches do not masquerade as five-role concurrency', () => {
  const f = activityFixture()
  const samples = activeRoles.map(active => ({ roots: Object.fromEntries(allRoles.map(role => [role, f.state(role, role === active)])) }))
  const activity = assessRootActivity(f.visits, samples, f.pinned, activeRoles)
  assert.deepEqual(activity.observedRunningRoles, activeRoles)
  assert.equal(activity.peak, 1)
  assert.equal(activity.fiveRoleBatchObserved, false)
  assert.equal(classifyOfficeUiLoadReport(f.report(activity)), 'incomplete')
})

test('phase configuration rejects six active roots, missing roles and duplicates', () => {
  const f = activityFixture()
  for (const roles of [allRoles, activeRoles.slice(1), ['finance', 'finance', 'sales', 'operations', 'compliance']]) {
    assert.throws(() => assessRootActivity(f.visits, f.samples, f.pinned, roles), /five application roles/)
  }
})
