/** Pure identity/cancellation checks. Never launches or contacts a desktop. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertCovered, createAuditGuard, verifiedFileIdentity, resolveOfficeFiles, officeCapacityPlan, runOfficeControl, normalizeClipboardText } from './cooperative-office-audit.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.e2e-tmp')
const file = { name: '计划.docx', size: 18, sha256: 'a'.repeat(64), lastModified: 123 }
const source = join(root, file.name)
test('clipboard comparison permits Windows CRLF conversion but preserves content, spacing and lone CR', () => {
  assert.equal(normalizeClipboardText('中文\r\n next\r\n'), '中文\n next\n')
  assert.notEqual(normalizeClipboardText('中文\nnext'), '中文\n next')
  assert.equal(normalizeClipboardText('a\rb'), 'a\rb')
})
const within = async operation => {
  let timer
  try { return await Promise.race([operation(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Guard did not stop promptly')), 1000)
  })]) } finally { clearTimeout(timer) }
}

test('import identity binds exact bytes and actual File metadata, not a matching basename alone', () => {
  const identity = verifiedFileIdentity(source, file, file, 'product-session')
  assert.equal(identity.resourceId, 'external:计划.docx:18:123')
  assert.equal(identity.tabId, 'work-resource-tab-' + encodeURIComponent(identity.resourceId))
  assert.equal(identity.sessionId, 'product-session')
  assert.throws(() => verifiedFileIdentity(source, file, { ...file, sha256: 'b'.repeat(64) }, 's'), /bytes differ/)
  assert.throws(() => verifiedFileIdentity(source, file, { ...file, size: 19 }, 's'), /size differs/)
  assert.throws(() => verifiedFileIdentity(source, file, { ...file, name: '别的.docx' }, 's'), /name differs/)
  assert.throws(() => verifiedFileIdentity(source, file, { ...file, lastModified: NaN }, 's'), /modification time/)
})

test('abort cancels a pending read and forbids subsequent UI mutation', async () => {
  const controller = new AbortController(), guard = createAuditGuard({ page: { evaluate: async () => true }, signal: controller.signal })
  let mutations = 0
  try {
    await guard.start()
    await assert.rejects(within(async () => {
      const pending = guard.read(() => new Promise(() => {}))
      setTimeout(() => controller.abort(new Error('AUDIT_CANCELLED: test')), 20)
      await pending
    }), /AUDIT_CANCELLED/)
    await assert.rejects(guard.action(async () => mutations++), /AUDIT_CANCELLED/)
    assert.equal(mutations, 0)
  } finally { guard.dispose() }
})

test('switching out of Work interrupts a long read without reselecting the surface', async () => {
  let work = true, mutations = 0
  const guard = createAuditGuard({ page: { evaluate: async () => work } })
  try {
    await guard.start()
    await assert.rejects(within(async () => {
      const pending = guard.read(() => new Promise(() => {}))
      setTimeout(() => { work = false }, 20)
      await pending
    }), /AUDIT_MODE_CHANGED/)
    work = true
    await assert.rejects(guard.action(async () => mutations++), /AUDIT_MODE_CHANGED/)
    assert.equal(mutations, 0)
  } finally { guard.dispose() }
})

test('cancellation file interrupts a pending read and is never removed by the audit', async () => {
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'office-cancel-')), cancelFile = join(directory, 'cancel.flag')
  const guard = createAuditGuard({ page: { evaluate: async () => true }, cancelFile })
  try {
    await guard.start()
    await assert.rejects(within(async () => {
      const pending = guard.read(() => new Promise(() => {}))
      setTimeout(() => writeFileSync(cancelFile, 'stop'), 20)
      await pending
    }), /AUDIT_CANCELLED/)
  } finally {
    guard.dispose()
    assert.ok(resolve(directory).startsWith(root + sep) && resolve(directory) !== root)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('screenshot coverage rejects missing strips, empty pages and offscreen intervals', () => {
  assertCovered([{ start: 0, end: 60 }, { start: 50, end: 100 }], 100)
  assert.throws(() => assertCovered([{ start: 0, end: 20 }, { start: 30, end: 100 }], 100), /gap/)
  assert.throws(() => assertCovered([{ start: 0, end: 90 }], 100), /stopped/)
  assert.throws(() => assertCovered([], 0), /No visible/)
  assert.throws(() => assertCovered([{ start: 110, end: 100 }], 100), /gap/)
})

test('office manifests accept new role mappings and legacy snapshots; explicit files win', () => {
  assert.deepEqual(resolveOfficeFiles({}, { files: { prd: 'product/a.docx', sheet: 'product/b.xlsx', handoff: 'handoff/product-ready.json' } }), ['product/a.docx', 'product/b.xlsx'])
  assert.deepEqual(resolveOfficeFiles({}, { documents: { current: { 'product/a.pdf': {}, 'handoff/x.json': {} } } }), ['product/a.pdf'])
  assert.deepEqual(resolveOfficeFiles({ files: ['evidence/a.pptx'] }, { files: { invalid: 42 } }), ['evidence/a.pptx'])
  assert.throws(() => resolveOfficeFiles({ files: [] }, { files: { prd: 'product/a.docx' } }), /requires/)
  assert.throws(() => resolveOfficeFiles({}, { files: { invalid: 42 } }), /nonempty paths/)
})

test('capacity plan never relabels a smaller sample as ten simultaneously open files', () => {
  assert.deepEqual(officeCapacityPlan(10), [{ capacity: 1, available: true }, { capacity: 5, available: true }, { capacity: 10, available: true }])
  assert.equal(officeCapacityPlan(5)[2].available, false)
  assert.throws(() => officeCapacityPlan(10, [5, 1]), /increasing/)
  assert.throws(() => officeCapacityPlan(10, [1, 1]), /increasing/)
})

test('selection failure persists evidence and does not prevent copy/save controls; cancellation still escapes', async () => {
  const report = { controls: [], errors: [] }, guard = { check: async () => {} }, actions = []
  const base = { guard, report, path: 'product/a.pptx', save: () => actions.push('saved') }
  await runOfficeControl({ ...base, action: 'selection', operation: async result => { result.selection = { text: '' }; throw new Error('No actual selection') } })
  await runOfficeControl({ ...base, action: 'copy', operation: async () => actions.push('copied') })
  await runOfficeControl({ ...base, action: 'save', operation: async () => actions.push('downloaded') })
  assert.deepEqual(report.controls.map(item => item.status), ['failed', 'passed', 'passed'])
  assert.deepEqual(report.controls[0].selection, { text: '' })
  assert.equal(report.errors.length, 1)
  assert.ok(actions.includes('copied') && actions.includes('downloaded'))
  await assert.rejects(runOfficeControl({ ...base, guard: { check: async () => { throw new Error('AUDIT_CANCELLED') } }, action: 'cancelled', operation: async () => actions.push('forbidden') }), /AUDIT_CANCELLED/)
  assert.ok(!actions.includes('forbidden'))
})
