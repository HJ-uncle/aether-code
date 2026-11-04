/** Preparation is read-only by default. --start launches, but sends zero prompts.
 * Parent explicitly POSTs /work then /code to the separate authenticated phase controller.
 * Existing base control.json remains available for manual screenshots/status/stop/close.
 */
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkedBuilds, launchController, parseArguments } from './cooperative-product-dev-acceptance.mjs'
import { createPhases, officeNames, prepareInputs } from './live-steering-phases.mjs'

export function settings(argv) {
  const supplied = parseArguments(argv)
  assert.ok(!supplied.resume && !supplied['resume-inspection'], 'Use fresh isolated sessions; inspection resume belongs to the base controller')
  return { root: 'D:/trust-test/cooperative-acceptance-20261103/live-steering-validation', round: '1',
    'app-entry': 'D:/dev/aether-code/.e2e-tmp/cooperative-round-3-root-followup-r2/main/index.js',
    'engine-entry': 'D:/dev/ai-agent-engine/.e2e-tmp/cooperative-round-4-csv-source-read/main.js',
    'office-source': 'D:/trust-test/cooperative-acceptance-20261103/round-2/workspace/product', ...supplied }
}
export function check(options) {
  const builds = checkedBuilds(options)
  const office = officeNames.map(name => { const path = resolve(options['office-source'], name), data = readFileSync(path)
    return { name, path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') } })
  assert.ok(!existsSync(join(resolve(options.root), 'round-' + options.round)), 'Round already exists; inspect before choosing a new one')
  return { checked: true, builds, office, campaign: resolve(options.root), modelSeed: 'Existing configured model via launchController; credentials remain in memory',
    launchedElectron: false, modelRequests: 0, mutations: 0, phases: ['Work immediate + explicit next turn', 'Code stop + original-message retry + immediate + native Office read'] }
}
export async function start(options) {
  const preflight = check(options)
  const controller = await launchController(options)
  const prepared = prepareInputs(controller, options), phases = createPhases(controller, prepared, options)
  const token = randomBytes(32).toString('hex'), records = { work: null, code: null }
  let active = null
  const save = () => writeFileSync(join(phases.output, 'phase-status.json'), JSON.stringify({ active, records }, null, 2))
  const server = createServer(async (incoming, outgoing) => {
    const respond = (status, data) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify(data)) }
    try {
      if (incoming.headers.origin || incoming.headers['x-controller-token'] !== token || incoming.headers.host !== `127.0.0.1:${server.address().port}`)
        return respond(403, { error: 'Local phase controller authorization required' })
      let raw = ''; for await (const chunk of incoming) { raw += chunk; if (raw.length > 1024) throw new Error('Unexpected control payload') }
      assert.ok(!raw || raw.trim() === '{}', 'Phase requests have no custom model prompt')
      const route = new URL(incoming.url, 'http://127.0.0.1').pathname
      if (incoming.method === 'GET' && route === '/status') {
        // A disconnected engine must not hide the retained phase outcome.
        // Phase assertions still require their own successful identity-bound reads.
        try { return respond(200, { active, records, controller: await controller.status() }) }
        catch (error) { return respond(200, { active, records, controller: null, controllerError: String(error.message) }) }
      }
      if (incoming.method === 'POST' && ['/work', '/code'].includes(route)) {
        const name = route.slice(1)
        if (active || records[name]) return respond(409, { error: 'Phase is active or already attempted; inspect retained evidence, never automatically replay' })
        if (name === 'code' && records.work?.status !== 'passed') return respond(409, { error: 'Run and inspect Work first; phases are serial' })
        active = name; records[name] = { status: 'running', startedAt: Date.now() }; save()
        void phases[name]().then(result => { records[name] = { ...records[name], status: 'passed', completedAt: Date.now(), report: join(phases.output, name + '-result.json') } })
          .catch(async error => {
            // Keep the app/session/run alive for manual diagnosis. Never fake a
            // stop, mailbox ACK, resend, or run status to make a phase finish.
            records[name] = { ...records[name], status: 'failed', completedAt: Date.now(), error: String(error.message) }
            phases.event('phase-failed', { phase: name, error: String(error.message) })
            try { await controller.screenshot({ name: 'live-' + name + '-failure' }) } catch { /* retain primary failure */ }
          }).finally(() => { active = null; save() })
        return respond(202, { started: name, inspect: '/status' })
      }
      if (incoming.method === 'POST' && route === '/close') {
        if (active) return respond(409, { error: 'Phase active. Use base controller actual Stop if necessary, then inspect and close.' })
        await controller.close(); respond(200, { closed: true }); server.close(); return
      }
      return respond(404, { error: 'Unknown phase endpoint' })
    } catch (error) { return respond(400, { error: String(error.message) }) }
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(Number(options['phase-port'] || 0), '127.0.0.1', done) })
  const path = join(controller.state.root, 'phase-control.json')
  writeFileSync(path, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token,
    phaseEndpoints: ['/work', '/code'], status: '/status', close: '/close', baseControlPath: join(controller.state.root, 'control.json') }, null, 2), { flag: 'wx' })
  save(); writeFileSync(join(phases.output, 'preflight.json'), JSON.stringify(preflight, null, 2))
  console.log(JSON.stringify({ ready: true, phaseControlPath: path, evidence: phases.output, modelRequests: 0,
    instruction: 'Explicit authenticated POST /work, inspect, then POST /code. Control tokens are only in the file.' }))
  return { controller, server, records }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = settings(process.argv.slice(2))
  if (options.start) await start(options)
  else console.log(JSON.stringify(check(options), null, 2))
}
