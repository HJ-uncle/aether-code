/** Paired-engine acceptance only, never used by the desktop runtime. */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const engine = process.env.AETHER_ENGINE_SOURCE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../ai-agent-engine')
export async function fixtureEnrollment(database) {
  const { issueIsolatedActivation }=await import(pathToFileURL(join(engine,'scripts/diagnostics/issue-fixture-activation.mjs')).href)
  return issueIsolatedActivation(database)
}
export async function registerFixtureAccount(page, suppliedDatabase) {
  const state=await page.evaluate(() => window.aether.engine.getSnapshot())
  const database=suppliedDatabase || (state.mode==='embedded' && !state.adopted && state.dataDir)
  if (!database || !state.baseUrl) throw new Error('Expected a paired, isolated account service')
  return page.evaluate(activation => window.aether.account.register(activation), {code:await fixtureEnrollment(database), serviceUrl:state.baseUrl})
}
