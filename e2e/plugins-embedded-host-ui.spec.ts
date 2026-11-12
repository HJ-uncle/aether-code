/** Real Electron-owned engine (no external Node or remote mock): plugin stdin,
 * exact nondefault arguments and environment isolation through the production launcher. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EngineRequestInput, EngineRequestResult, EngineSnapshot } from '../src/shared/ipc'
import type { PluginRecord } from '../src/renderer/src/core/engine/plugins'
import { newPlugin } from './fixtures/plugin'

const root = resolve(__dirname, '..'), fixtureRoot = join(root, '.e2e-tmp/plugins-embedded-host')
const engineEntry = resolve(root, '../ai-agent-engine/dist/main.js')
let app: ElectronApplication | undefined, page: Page | undefined
const errors: string[] = []
async function call<T>(input: EngineRequestInput): Promise<EngineRequestResult<T>> {
  return page!.evaluate(value => window.aether.engine.request(value),input) as Promise<EngineRequestResult<T>>
}
function cleanEnv(): Record<string,string> {
  return Object.fromEntries(Object.entries(process.env).flatMap(([key,value]) => value === undefined ||
    /(?:API_KEY|TOKEN|SECRET|ENCRYPTION|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|^AETHER_|^DATA_DIR$|^MEMORY_DB_PATH$|^WORKSPACE_ROOT$|^SKILLS_ROOT$|^MCP_CONFIG_PATH$)/i.test(key) ? [] : [[key,value]]))
}

test('Electron嵌入式宿主使用真实启动链路向插件传入完整stdin，且不泄漏引擎环境',async ({},info) => {
  test.setTimeout(120_000)
  mkdirSync(fixtureRoot,{ recursive: true })
  const fixture = mkdtempSync(join(fixtureRoot,'profile-')), runtime = join(fixture,'runtime-proxy')
  mkdirSync(join(runtime,'runtime'),{ recursive: true }); mkdirSync(join(fixture,'skills'))
  // Only relocate cwd; import the actual built server without substituting its launcher or routes.
  const proxy = join(runtime,'entry.mjs')
  writeFileSync(proxy,`import ${JSON.stringify(pathToFileURL(engineEntry).href)}\n`)
  copyFileSync(join(dirname(engineEntry),'runtime/build-manifest.json'),join(runtime,'runtime/build-manifest.json'))
  writeFileSync(join(fixture,'settings.json'),JSON.stringify({ engineMode: 'embedded', autoStartEngine: true, preferredPort: 12581,
    lastFolder: '', lastSessionId: '', appearance: 'light', thinkingMode: 'off' }))
  const marker = 'PLUGIN_PARENT_SECRET_MUST_NOT_LEAK'
  try {
    app = await electron.launch({ args: [join(root,'out/main/index.js'),`--user-data-dir=${fixture}`], cwd: root,
      env: { ...cleanEnv(), AETHER_IDE_ENGINE_ENTRY: proxy, AETHER_GLOBAL_DIR: join(fixture,'global'),
        MEMORY_DB_PATH: join(fixture,'memory.db'), SKILLS_ROOT: join(fixture,'skills'), MCP_CONFIG_PATH: join(fixture,'mcp.json'),
        AUTH_ENABLED: 'false', HISTORY_BACKEND: 'jsonl', OSM_MODE: 'off', LOG_LEVEL: 'warn', QA_LOG_ENABLED: 'false',
        DEFAULT_SECURITY_MODE: 'standard', ENABLE_LONG_TERM_MEMORY: 'false', OPENAI_API_KEY: marker } })
    page = await app.firstWindow(); page.on('pageerror',error => errors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪',{ timeout: 90_000 })
    const snapshot: EngineSnapshot = await page.evaluate(() => window.aether.engine.getSnapshot())
    expect(snapshot).toMatchObject({ mode: 'embedded', phase: 'ready', adopted: false, runtimeSource: 'env', entryPath: proxy })
    expect(resolve(snapshot.dataDir!)).toBe(join(fixture,'engine/state/agent.db'))
    const desktop = await app.evaluate(() => ({ execPath: process.execPath, electron: process.versions.electron }))
    expect(desktop.electron).toBeTruthy()
    const template = newPlugin(), id = 'embedded-stdin-check'
    const source = `import process from 'node:process'
const timeout = setTimeout(() => { process.stderr.write('PLUGIN_STDIN_EOF_NOT_RECEIVED'); process.exit(73) },3000)
let raw = ''
for await (const chunk of process.stdin) raw += chunk
clearTimeout(timeout)
if (!raw.trim()) throw new Error('PLUGIN_STDIN_EMPTY')
const payload = JSON.parse(raw)
console.log(JSON.stringify({result:{tool:payload.tool,args:payload.args,rawBytes:Buffer.byteLength(raw),execPath:process.execPath,
  runAsNode:process.env.ELECTRON_RUN_AS_NODE ?? null,secretLeaked:Boolean(process.env.OPENAI_API_KEY || process.env.AETHER_INSTANCE_TOKEN || process.env.ENCRYPTION_KEY)}}))
`
    const created = await call<{ plugin: PluginRecord }>({ method: 'POST',path: '/plugins',toolProfile: 'general',
      body: { manifest: { ...template.manifest,id,name: '嵌入式传参验证' },files: { 'tools/greet.mjs':source } } })
    expect(created.ok,created.message).toBe(true)
    const args = { name: '真实宿主 🚀 非默认参数 42' }
    const result = await call<{ result: { tool: string; args: unknown; rawBytes: number; execPath: string; runAsNode: string | null; secretLeaked: boolean } }>({
      method: 'POST',path: `/plugins/${id}/test`,toolProfile: 'general',body: { revision: 1,tool: 'greet',args } })
    const receipt = info.outputPath('embedded-host-receipt.json')
    writeFileSync(receipt,JSON.stringify({ snapshot,desktop,result },null,2))
    await info.attach('embedded-host-receipt',{ path: receipt,contentType: 'application/json' })
    expect(result.ok,result.message).toBe(true)
    expect(result.data?.result).toMatchObject({ tool: 'greet',args,secretLeaked:false })
    expect(result.data!.result.rawBytes).toBeGreaterThan(40)
    if (resolve(result.data!.result.execPath) === resolve(desktop.execPath)) expect(result.data!.result.runAsNode).toBe('1')
    const saved = await call<{ plugin: PluginRecord }>({ method: 'GET',path:`/plugins/${id}`,toolProfile:'general' })
    expect(saved.data?.plugin.files?.['tools/greet.mjs']).toBe(source)
    expect(errors).toEqual([])
  } finally {
    try { await app?.close() } finally {
      if (dirname(resolve(fixture)) !== fixtureRoot) throw new Error('Unsafe embedded profile cleanup')
      // Fixture cleanup is restricted to this newly-created profile, never the real app data.
      rmSync(fixture,{ recursive:true,force:true,maxRetries:5,retryDelay:100 })
    }
  }
})
