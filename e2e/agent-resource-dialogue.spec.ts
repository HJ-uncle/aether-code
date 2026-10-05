/** Real Electron agent dialogue: skills, stdio MCP, bound KB/RAG, retry and reload recovery. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
const model = 'agent-resource-dialogue-fixture'
const key = 'a'.repeat(64)
const sessionId = 'agent-resource-dialogue'
let fixture = ''
let baseUrl = ''
let app: ElectronApplication | undefined
let page: Page
let providerRequests = 0
let providerErrors: string[] = []
let ragSeen = false
let mcpToolName = ''
let skillsListed = false
let skillRead = false
let retrySeen = false
const toolDumps: string[] = []
let writeSeen = false
let readSeen = false
let resourceArtifact = ''
let skillEvidence = ''
let mcpEvidence = ''
let ragEvidence = ''

function sse(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'agent-resource', model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}
function done(response: ServerResponse, reason: string): void { sse(response, {}, reason); response.end('data: [DONE]\n\n') }
function callFrames(response: ServerResponse, calls: Array<{ id: string; name: string; args: unknown }>): void {
  sse(response, { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) })
  done(response, 'tool_calls')
}

/** OpenAI-compatible local provider. It drives one transient MCP failure, then retries it. */
const provider = createServer((incoming, response) => {
  void (async () => {
    let raw = ''
    for await (const chunk of incoming) raw += chunk.toString()
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>; tools?: Array<{ function?: { name?: string } }> }
    providerRequests++
    const system = String(body.messages.find(item => item.role === 'system')?.content ?? '')
    const userIndex = body.messages.findLastIndex(item => item.role === 'user')
    const prompt = String(body.messages[userIndex]?.content ?? '')
    ragSeen ||= system.includes('RAG_FIXTURE_TOKEN')
    if (system.includes('RAG_FIXTURE_TOKEN: bound knowledge content')) ragEvidence = 'RAG_FIXTURE_TOKEN: bound knowledge content'
    const toolMessages = body.messages.slice(Math.max(0, userIndex + 1)).filter(item => item.role === 'tool')
    if (toolMessages.length) toolDumps.push(JSON.stringify(toolMessages))
    // The adapter may normalize call IDs; validate the actual result payloads rather than
    // relying on provider supplied IDs (which is also the contract seen by real providers).
    skillsListed ||= toolMessages.some(item => String(item.content ?? '').includes('Fixture Skill'))
    skillRead ||= toolMessages.some(item => String(item.content ?? '').includes('Fixture instructions'))
    skillEvidence ||= String(toolMessages.find(item => String(item.content ?? '').includes('Fixture instructions'))?.content ?? '')
    mcpEvidence ||= String(toolMessages.find(item => String(item.content ?? '').includes('MCP_OK'))?.content ?? '')
    const tools = (body.tools ?? []).map(item => item.function?.name).filter((name): name is string => Boolean(name))
    mcpToolName ||= tools.find(name => name.startsWith('mcp_fixture-mcp_')) ?? ''
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (toolMessages.length === 0) {
      if (prompt.includes('[agent-resource-write]')) {
        if (!skillEvidence || !mcpEvidence || !ragEvidence) throw new Error('missing source evidence for resource artifact')
        resourceArtifact = [skillEvidence, mcpEvidence, ragEvidence].join('\n')
        callFrames(response, [{ id: 'write-resource', name: 'write_file', args: { path: 'resource-written.txt', data: resourceArtifact } }])
        return
      }
      if (!mcpToolName || !tools.includes('list_skills') || !tools.includes('get_skill')) throw new Error(`missing dialogue tools: ${tools.join(',')}`)
      callFrames(response, [
        { id: 'skill-list', name: 'list_skills', args: {} },
        { id: 'skill-get', name: 'get_skill', args: { name: 'Fixture Skill' } },
        { id: 'mcp-first', name: mcpToolName, args: { text: 'fixture' } },
      ])
      return
    }
    const transient = toolMessages.some(item => String(item.content ?? '').includes('transient fixture failure'))
    retrySeen ||= transient
    if (prompt.includes('[agent-resource-write]')) {
      if (!toolMessages.some(item => String(item.content ?? '').includes('Successfully written'))) throw new Error('write_file result missing')
      writeSeen = true
      if (toolMessages.length === 1) {
        callFrames(response, [{ id: 'read-resource', name: 'read_file', args: { path: 'resource-written.txt', mode: 'exact' } }])
        return
      }
      const readOutput = String(toolMessages.at(-1)?.content ?? '')
      const result = JSON.parse(readOutput) as { content?: string; expectedHash?: string }
      if (result.content !== resourceArtifact || !result.expectedHash?.startsWith('sha256:')) throw new Error('read_file did not return exact resource artifact')
      readSeen = true
      sse(response, { content: 'WRITE_DIALOGUE_OK' }); done(response, 'stop'); return
    }
    if (transient && !toolMessages.some(item => String(item.content ?? '').includes('MCP_OK'))) {
      callFrames(response, [{ id: 'mcp-retry', name: mcpToolName, args: { text: 'fixture retry' } }])
      return
    }
    if (!toolMessages.some(item => String(item.content ?? '').includes('MCP_OK'))) throw new Error('retry result missing MCP_OK')
    sse(response, { content: ragSeen ? 'AGENT_DIALOGUE_OK RAG_OK MCP_OK SKILL_OK RETRY_OK' : 'AGENT_DIALOGUE_OK MCP_OK SKILL_OK RETRY_OK' })
    done(response, 'stop')
  })().catch(error => { providerErrors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(String(error)) })
})

function env(): NodeJS.ProcessEnv {
  return { ...process.env, AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist/main.js'), AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl',
    LLM_PROVIDER: 'openai', LLM_PRIMARY_MODEL: model, LLM_MODEL: model, LLM_FALLBACK_MODEL: '', OPENAI_API_KEY: 'agent-resource-key', OPENAI_BASE_URL: baseUrl,
    DEFAULT_SECURITY_MODE: 'full-access', OSM_MODE: 'methodology', MAX_ITERATIONS: '8', ENABLE_LONG_TERM_MEMORY: 'false', AETHER_GLOBAL_DIR: join(fixture, 'global'),
    WORKSPACE_ROOT: join(fixture, 'workspace'), MCP_CONFIG_PATH: join(fixture, 'mcp.json'), SKILLS_ROOT: join(fixture, 'skills') }
}
async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env: env() })
  page = await app.firstWindow()
  await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
}
async function send(text: string): Promise<void> {
  // A picker is a portal sibling of the composer. Close it explicitly before
  // sending so a stale/open model menu cannot cover the send hit target after
  // a reload or a previous resource selection.
  await page.keyboard.press('Escape')
  await page.locator('.chat__input').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
async function seedEngine(kbFile: string): Promise<void> {
  const url = (file: string) => pathToFileURL(join(engineRoot, 'dist', file)).href
  const config = Object.fromEntries(Object.entries(env()).filter(([name]) => ['LLM_PRIMARY_MODEL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEFAULT_SECURITY_MODE', 'OSM_MODE', 'MAX_ITERATIONS', 'HISTORY_BACKEND'].includes(name)))
  const seed = `const fs=await import('node:fs');const {initDb,getDb}=await import(${JSON.stringify(url('storage/sqlite/db.js'))});const {ModelsStore}=await import(${JSON.stringify(url('storage/sqlite/models.js'))});const {systemConfigStore}=await import(${JSON.stringify(url('storage/sqlite/system-config.js'))});const {createKnowledgeBase,addDocument}=await import(${JSON.stringify(url('storage/knowledge/kb-repo.js'))});await initDb();await new ModelsStore().createModel({tenantId:'default',provider:'openai',modelId:${JSON.stringify(model)},apiKey:'agent-resource-key',baseUrl:${JSON.stringify(baseUrl)},displayName:'agent fixture',isEnabled:true,capabilities:{toolCalling:true,parallelTools:true,streamUsage:true,contextWindow:128000}});for(const[name,value]of Object.entries(${JSON.stringify(config)}))await systemConfigStore.set(name,value,name==='OPENAI_API_KEY');const b=await createKnowledgeBase('default','Fixture KB','fixture');await addDocument('default','fixture.md','text/plain','RAG_FIXTURE_TOKEN: bound knowledge content',b.id);fs.writeFileSync(${JSON.stringify(kbFile)},b.id);getDb().close();`
  execFileSync(process.execPath, ['--input-type=module', '-e', seed], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...env(), DATA_DIR: join(fixture, 'engine', 'state', 'agent.db'), ENCRYPTION_KEY: key } })
}

test.describe.serial('真实 Agent 资源对话闭环', () => {
  test.beforeAll(async () => {
    await new Promise<void>(resolveListen => provider.listen(0, '127.0.0.1', resolveListen))
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error('provider address missing')
    baseUrl = `http://127.0.0.1:${address.port}/v1`
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true }); fixture = mkdtempSync(join(root, '.e2e-tmp', 'agent-resource-dialogue-'))
    mkdirSync(join(fixture, 'workspace', '.aether', 'skills', 'fixture-skill'), { recursive: true }); mkdirSync(join(fixture, 'engine', 'secrets'), { recursive: true }); mkdirSync(join(fixture, 'skills', 'fixture-skill'), { recursive: true })
    const skill = '---\nname: Fixture Skill\ndescription: Fixture dialogue skill\n---\n\nFixture instructions'
    // Keep a project-scoped copy: the renderer sends workspacePaths and the engine
    // intentionally resolves project skills from <workspace>/.aether/skills.
    writeFileSync(join(fixture, 'workspace', '.aether', 'skills', 'fixture-skill', 'SKILL.md'), skill)
    writeFileSync(join(fixture, 'skills', 'fixture-skill', 'SKILL.md'), skill)
    const state = join(fixture, 'mcp-state')
    const script = `const fs=require('node:fs');let b='';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');process.stdin.on('data',c=>{b+=c;for(const line of b.split('\\n').slice(0,-1)){b=b.slice(line.length+1);let q;try{q=JSON.parse(line)}catch{continue}if(q.method==='initialize')send({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});else if(q.method==='notifications/initialized'){}else if(q.method==='tools/list')send({jsonrpc:'2.0',id:q.id,result:{tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}});else if(q.method==='tools/call'){if(!fs.existsSync(process.env.MCP_FIXTURE_STATE)){fs.writeFileSync(process.env.MCP_FIXTURE_STATE,'1');send({jsonrpc:'2.0',id:q.id,error:{code:-32001,message:'transient fixture failure'}})}else send({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:'MCP_OK'}]}})}}})`
    writeFileSync(join(fixture, 'mcp.json'), JSON.stringify({ mcpServers: { 'fixture-mcp': { name: 'Fixture MCP', description: 'fixture', enabled: true, transportType: 'stdio', command: process.execPath, args: ['-e', script], env: { MCP_FIXTURE_STATE: state }, disabledTools: [], isBuiltIn: false, createdAt: 1, updatedAt: 1 } } }))
    writeFileSync(join(fixture, 'engine', 'secrets', 'engine-secrets.json'), JSON.stringify({ encrypted: false, encryptionKey: key }))
    writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ engineMode: 'embedded', preferredPort: 12439, autoStartEngine: true, lastSessionId: sessionId, lastModelId: model, lastFolder: join(fixture, 'workspace'), thinkingMode: 'off' }))
    await seedEngine(join(fixture, 'kb-id'))
    await launch()
  })
  test.afterAll(async () => {
    await app?.close(); provider.closeAllConnections(); await new Promise<void>(resolveClose => provider.close(() => resolveClose()))
    if (!fixture) return; const absolute = resolve(fixture); if (dirname(absolute) !== resolve(root, '.e2e-tmp') || !basename(absolute).startsWith('agent-resource-dialogue-')) throw new Error('unsafe fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  test('skills + stdio MCP + KB/RAG + transient retry + reload/history', async () => {
    const kbId = readFileSync(join(fixture, 'kb-id'), 'utf8')
    const composer = page.locator('.chat__input')
    await composer.click()
    await composer.fill('')
    await composer.type('/kb')
    const resources = page.getByRole('listbox', { name: '选择 MCP、技能或知识库', exact: true })
    const item = resources.getByRole('option', { name: /Fixture KB/ })
    await expect(item).toBeVisible()
    await item.click()
    await expect(page.locator('.resource-binding-chip.is-kb')).toContainText(kbId)
    expect(await page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), kbId)).toBe(true)

    // Slash resource selection is session-scoped and represented by one binding
    // chip. The protocol token is consumed rather than left as duplicate prompt
    // text; removing and re-adding the chip must stay in sync with the composer.
    await composer.click(); await composer.type('/mcp')
    await expect(resources).toBeVisible()
    await resources.getByRole('option').filter({ hasText: 'Fixture MCP' }).click()
    await expect(page.locator('.resource-binding-chip.is-mcp')).toContainText('fixture-mcp')
    await expect(composer).not.toContainText('/mcp:fixture-mcp')
    await page.locator('.resource-binding-chip.is-mcp').click()
    await expect(page.locator('.resource-binding-chip.is-mcp')).toHaveCount(0)
    await composer.click(); await composer.type('/mcp')
    await resources.getByRole('option').filter({ hasText: 'Fixture MCP' }).click()
    await expect(page.locator('.resource-binding-chip.is-mcp')).toContainText('fixture-mcp')

    await send('请使用技能和 MCP，并引用 RAG_FIXTURE_TOKEN [agent-resource]')
    await expect(page.locator('.message--assistant')).toContainText('AGENT_DIALOGUE_OK', { timeout: 90_000 })
    expect(providerErrors).toEqual([]); expect(ragSeen).toBe(true); expect(mcpToolName).toBeTruthy(); expect(providerRequests).toBe(3)
    expect(skillsListed, toolDumps.join('\n')).toBe(true); expect(skillRead, toolDumps.join('\n')).toBe(true); expect(retrySeen).toBe(true)
    await expect(page.locator('.message--assistant')).toContainText('RAG_OK MCP_OK SKILL_OK RETRY_OK')
    await expect.poll(async () => {
      const snapshot = await page.evaluate(id => window.aether.engine.request<{ run?: { status: string } }>({ method: 'GET', path: '/chat/snapshot', query: { sessionId: id } }), sessionId)
      return snapshot.data?.run?.status
    }).toBe('succeeded')
    await page.reload(); await expect(page.locator('.message--assistant')).toContainText('AGENT_DIALOGUE_OK')
    expect(providerRequests).toBe(3)
    await send('[agent-resource-write]')
    await expect(page.locator('.message--assistant').last()).toContainText('WRITE_DIALOGUE_OK', { timeout: 90_000 })
    await expect.poll(async () => existsSync(join(fixture, 'workspace', 'resource-written.txt'))).toBe(true)
    expect(readFileSync(join(fixture, 'workspace', 'resource-written.txt'), 'utf8')).toBe(resourceArtifact)
    expect(resourceArtifact).toContain('Fixture instructions'); expect(resourceArtifact).toContain('MCP_OK'); expect(resourceArtifact).toContain('RAG_FIXTURE_TOKEN')
    expect(writeSeen).toBe(true); expect(readSeen).toBe(true)
    await expect.poll(async () => {
      const snapshot = await page.evaluate(id => window.aether.engine.request<{ run?: { status: string } }>({ method: 'GET', path: '/chat/snapshot', query: { sessionId: id } }), sessionId)
      return snapshot.data?.run?.status
    }).toBe('succeeded')
    await app!.close(); await launch()
    await expect(page.locator('.message--assistant')).toHaveCount(2)
    await expect(page.locator('.message--assistant').last()).toContainText('WRITE_DIALOGUE_OK')
    await expect(page.locator('.message--assistant').first()).toContainText('AGENT_DIALOGUE_OK')
    expect(providerRequests).toBe(6)
    expect(existsSync(join(fixture, 'mcp-state'))).toBe(true)
  })
})
