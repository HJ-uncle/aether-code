/** This function is also injected into an already-owned runner through
 * Runtime.evaluate, which has no dynamic-import callback. Keep its body
 * self-contained and load the side-effect-free controller with Node's
 * synchronous ESM bridge; importing this file starts no app or probe. */
export async function recover(c, options = {}) {
  const { createRequire } = process.getBuiltinModule('node:module')
  const { basename, dirname, resolve } = process.getBuiltinModule('node:path')
  const entrypoint = resolve(process.argv[1] ?? '')
  if (basename(entrypoint) !== 'run-office-company-campaign.mjs') {
    throw new Error('Context probe recovery requires the existing owned office runner')
  }
  const repository = dirname(dirname(entrypoint))
  const expectedRoot = resolve(options.expectedRoot ?? c?.state?.runRoot ?? '')
  if (dirname(expectedRoot) !== resolve(repository, '.ae')) {
    throw new Error('The office campaign must belong to the owned runner repository')
  }
  const requireOwned = createRequire(entrypoint)
  if (resolve(c?.state?.runRoot ?? '') !== expectedRoot) throw new Error('The probe controller root changed')
  const { startOfficeContextProbe, queryOfficeContextProbe, reconcileOfficeContextProbe } = requireOwned(resolve(repository, 'scripts', 'office-context-probe-control.mjs'))
  if (options.action === 'query') return queryOfficeContextProbe(c)
  if (options.action === 'reconcile') {
    if (c.state.contextCompactionProbeControl?.reconciliationActive) throw new Error('A probe reconciliation is already running')
    c.contextProbeReconcilePromise = reconcileOfficeContextProbe(c).catch(error => ({ released: false, error: String(error.message) }))
    return { accepted: true, action: 'reconcile', promise: 'contextProbeReconcilePromise', query: 'queryOfficeContextProbe' }
  }
  if (options.action !== undefined && options.action !== 'start') throw new Error('Unknown probe action')
  return startOfficeContextProbe(c, {
    ...options,
    expectedRoot,
    packetTokens: options.packetTokens ?? 60_000,
    maxDurationMs: options.maxDurationMs ?? 12 * 60 * 60_000,
  })
}
