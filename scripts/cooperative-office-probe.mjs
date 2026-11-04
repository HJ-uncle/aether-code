/** Independent, model-free preview QA of frozen deliverables. Copies input bytes
 * into an isolated workspace; never launches an engine or changes source files. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { auditOffice } from './cooperative-office-audit.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i].startsWith('--') && process.argv[i + 1], 'Expected --key value')
  options[process.argv[i].slice(2)] = process.argv[i + 1]
}
for (const key of ['source', 'entry', 'out']) assert.ok(options[key], `Missing --${key}`)
const source = resolve(options.source), entry = resolve(options.entry), evidence = resolve(options.out)
assert.ok(!existsSync(evidence), 'Refusing to replace existing evidence')
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const manifest = JSON.parse(readFileSync(join(source, 'handoff/product-ready.json'), 'utf8'))
const candidates = options.files ? JSON.parse(readFileSync(resolve(options.files), 'utf8'))
  : manifest.files ? Object.values(manifest.files) : Object.keys(manifest.documents.current)
const files = [...new Set(candidates.filter(value => typeof value === 'string' && /\.(docx|xlsx|pptx|pdf|md|csv|tsv|txt|html|json)$/i.test(value)))]
assert.ok(files.length > 0 && files.length <= 32)
const phases = (options.phases || 'timing,pages,controls').split(',')
assert.ok(phases.every(value => ['timing', 'pages', 'controls'].includes(value)))
const parent = join(repo, '.e2e-tmp'); mkdirSync(parent, { recursive: true })
const temporary = mkdtempSync(join(parent, 'cooperative-office-probe-'))
const workspace = join(temporary, 'workspace'), profile = join(temporary, 'profile')
for (const directory of [workspace, profile, evidence]) mkdirSync(directory, { recursive: true })
const inside = (root, name) => { const full = resolve(root, name); assert.ok(full.startsWith(resolve(root) + sep), 'Path outside root'); return full }
const inputs = files.map(relative => {
  const original = inside(source, relative), copied = inside(workspace, relative)
  mkdirSync(dirname(copied), { recursive: true }); copyFileSync(original, copied)
  const sha256 = hash(original); assert.equal(hash(copied), sha256)
  return { relative, source: original, copy: copied, sha256 }
})
const artifact = (name, data) => { const file = inside(evidence, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2)); return file }
const record = { startedAt: new Date().toISOString(), source, entry, entrySha256: hash(entry), workspace, profile, inputs, phases: {}, errors: [], closed: false,
  boundary: 'Real Electron DOM/IPC; isolated empty conversation, no engine/model. Source bytes copied and verified. OS disk cache is not cleared. Native Windows dialogs are not separately verified.' }
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, appearance: 'light' }))
let app
try {
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(temporary, 'global') }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'AETHER_IDE_ENGINE_ENTRY']) delete env[key]
  app = await electron.launch({ args: [entry, '--user-data-dir=' + profile], cwd: repo, env })
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000)
  page.on('pageerror', error => record.errors.push(error.message))
  await expect(page.locator('.workbench')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1050))
  const sessionId = 'work-office-probe'
  await page.evaluate(({ workspace, sessionId }) => {
    localStorage.setItem('aether.app.mode', 'work')
    localStorage.setItem('aether.work.view.v1', JSON.stringify({ page: 'home', collapsed: false, workspace: true, tab: 'files', pane: 'conversation', ratio: 38.4 }))
    localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: sessionId, title: '独立办公验收', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }], activeTaskId: sessionId, homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
  }, { workspace, sessionId })
  await page.reload(); await expect(page.locator('#mode-work')).toHaveAttribute('aria-hidden', 'false')
  record.geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
  const context = { app, page, state: { workspace, evidence, round: Number(options.round || 2), roles: { product: { sessionId } } },
    select: async () => expect(page.locator('#mode-work')).toHaveAttribute('aria-hidden', 'false'), artifact, signal: new AbortController().signal }
  for (const phase of phases) {
    record.phases[phase] = await auditOffice(context, { phase, files, ...(phase === 'timing' ? { capacities: [...new Set([1, 5, 10, files.length].filter(value => value <= files.length))], closeAuditTabs: true } : {}) })
    for (const error of record.phases[phase].errors || []) record.errors.push({ phase, ...error })
    artifact('run.json', record); console.log(JSON.stringify({ phase, report: record.phases[phase].report, errors: record.phases[phase].errors.length }))
  }
  assert.equal(record.errors.length, 0, `Office audit recorded ${record.errors.length} errors; see phase reports`)
} catch (error) { record.failure = error.stack; process.exitCode = 1; console.error(error.message) }
finally {
  if (app) await app.close()
  record.closed = true; record.finishedAt = new Date().toISOString()
  record.sourcesUnchanged = inputs.every(input => hash(input.source) === input.sha256)
  record.copiesUnchanged = inputs.every(input => hash(input.copy) === input.sha256)
  if (!record.sourcesUnchanged || !record.copiesUnchanged) process.exitCode = 1
  artifact('run.json', record); console.log(JSON.stringify({ closed: true, evidence, failure: record.failure || null }))
}
