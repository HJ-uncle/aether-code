/**
 * Real MCP settings acceptance:
 * - embedded engine and owned instance token (AUTH_ENABLED is intentionally omitted)
 * - project and global config files with no accidental cross-layer overlay
 * - stdio discovery, tool enablement, server enablement and credentials
 * - streamable HTTP discovery with request headers
 * - validation failure recovery and destructive cleanup
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { AetherIdeApi } from '../src/preload'

declare global {
  interface Window { aether: AetherIdeApi }
}

const root = resolve(__dirname, '..')
const fixtureRoot = join(root, '.e2e-tmp')
const engineRoot = resolve(root, '..', 'ai-agent-engine')
let fixture = ''
let workspace = ''
let profile = ''
let marker = ''
let app: ElectronApplication | undefined
let page: Page
let httpServer: Server | undefined
let httpUrl = ''
const httpHeaders: Array<Record<string, string | string[] | undefined>> = []
const rendererErrors: string[] = []

function stdioServerScript(): string {
  return [
    "const fs=require('node:fs'); if(process.env.MCP_UI_MARKER) fs.writeFileSync(process.env.MCP_UI_MARKER, process.env.MCP_UI_SECRET || 'missing');",
    "process.stdin.setEncoding('utf8'); let b='';",
    "process.stdin.on('data', c => { b += c; for (;;) { const i=b.indexOf('\\n'); if(i<0) return; const line=b.slice(0,i).trim(); b=b.slice(i+1); if(!line) continue; const m=JSON.parse(line); if(!m.id) continue; let result={}; if(m.method==='initialize') result={protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'mcp-ui-fixture',version:'1'}}; else if(m.method==='tools/list') result={tools:[{name:'echo',description:'MCP UI echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}},{name:'second',description:'MCP UI second',inputSchema:{type:'object'}}]}; else if(m.method==='tools/call') result={content:[{type:'text',text:String(m.params?.arguments?.text ?? process.env.MCP_UI_SECRET ?? '')}]}; const payload=JSON.stringify({jsonrpc:'2.0',id:m.id,result}); process.stdout.write(payload+'\\n'); }});",
  ].join('')
}

async function readBody(request: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of request) raw += chunk.toString()
  return raw
}

function jsonResponse(response: ServerResponse, id: number, data: unknown, headers: Record<string, string> = {}): void {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value)
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result: data }))
}

function launchEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !['AUTH_ENABLED', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'MCP_CONFIG_PATH'].includes(key.toUpperCase())) env[key] = value
  }
  return {
    ...env,
    // The embedded host supplies AUTH_ENABLED=false to its child by default;
    // this test deliberately does not supply the flag itself.
    AETHER_IDE_ENGINE_ENTRY: join(engineRoot, 'dist', 'main.js'),
    AETHER_GLOBAL_DIR: join(fixture, 'global'),
    WORKSPACE_ROOT: workspace,
    SKILLS_ROOT: join(fixture, 'skills'),
    // The isolated HTTP fixture is loopback; full-access permits the guarded
    // MCP client to reach it while this test uses no external URL.
    DEFAULT_SECURITY_MODE: 'full-access',
    ENABLE_LONG_TERM_MEMORY: 'false'
  }
}

function projectConfig(): string { return join(workspace, '.aether', 'mcp.json') }
function globalConfig(): string { return join(fixture, 'global', 'mcp.json') }

function serverBlock(id: string) {
  return page.locator('.mcp-server-block').filter({ hasText: id }).first()
}

async function openMcp(): Promise<void> {
  if (!(await page.locator('.app-settings').isVisible())) await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: 'MCP', exact: true }).click()
  await expect(page.locator('.settings-view--mcp')).toBeVisible()
}

async function addStdio(id: string, name: string, scope: 'project' | 'global' = 'project'): Promise<void> {
  await page.getByRole('button', { name: '新增服务器', exact: true }).click()
  await page.getByLabel('MCP id', { exact: true }).fill(id)
  await page.getByLabel('MCP 名称', { exact: true }).fill(name)
  await page.getByLabel('MCP 命令', { exact: true }).fill(process.execPath)
  await page.getByLabel('MCP 参数', { exact: true }).fill(`-e\n${stdioServerScript()}`)
  await page.getByLabel('MCP 环境变量', { exact: true }).fill(JSON.stringify({ MCP_UI_SECRET: 'fixture-secret', MCP_UI_MARKER: marker }))
  await page.locator('.mcp-scope select').selectOption(scope)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.mcp-form')).toHaveCount(0)
  await expect(serverBlock(id)).toContainText(name)
}

async function confirmDelete(): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '删除 MCP 配置', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test.describe.serial('MCP 设置真实引擎闭环', () => {
  test.beforeAll(async () => {
    mkdirSync(fixtureRoot, { recursive: true })
    fixture = mkdtempSync(join(fixtureRoot, 'mcp-ui-'))
    workspace = join(fixture, 'workspace')
    profile = join(fixture, 'profile')
    marker = join(fixture, 'stdio-env-marker.txt')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(profile, { recursive: true })
    mkdirSync(join(fixture, 'skills'), { recursive: true })
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12487, autoStartEngine: true, lastFolder: workspace,
      lastSessionId: 'mcp-ui-session'
    }))

    httpServer = createServer(async (request, response) => {
      const body = await readBody(request)
      if (request.method !== 'POST') { response.statusCode = 405; response.end(); return }
      httpHeaders.push(request.headers)
      const message = JSON.parse(body) as { id?: number; method: string }
      if (request.headers['x-mcp-ui'] !== 'fixture-header') {
        response.statusCode = 401
        response.end('Fixture header missing')
        return
      }
      if (message.id === undefined) { response.statusCode = 202; response.end(); return }
      if (message.method === 'initialize') {
        jsonResponse(response, message.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-ui-fixture', version: '1' } }, { 'mcp-session-id': 'mcp-ui-session' })
      } else if (message.method === 'tools/list') {
        jsonResponse(response, message.id, { tools: [{ name: 'http_echo', description: 'HTTP UI echo', inputSchema: { type: 'object' } }] })
      } else {
        jsonResponse(response, message.id, { content: [{ type: 'text', text: 'http fixture' }] })
      }
    })
    await new Promise<void>(resolveListen => httpServer?.listen(0, '127.0.0.1', resolveListen))
    httpUrl = `http://127.0.0.1:${(httpServer?.address() as AddressInfo).port}`

    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env: launchEnvironment() })
    page = await app.firstWindow()
    page.on('pageerror', error => rendererErrors.push(error.message))
    await expect(page.locator('.status-bar')).toContainText('引擎：就绪', { timeout: 90_000 })
    await expect(page.locator('.explorer__root')).toHaveAttribute('title', workspace)
    await openMcp()
  })

  test.afterEach(() => expect(rendererErrors).toEqual([]))

  test.afterAll(async () => {
    await app?.close()
    if (httpServer) await new Promise<void>(resolveClose => { httpServer!.close(() => resolveClose()); httpServer!.closeAllConnections() })
    if (!fixture) return
    if (dirname(fixture) !== fixtureRoot || !basename(fixture).startsWith('mcp-ui-')) throw new Error('Unsafe MCP fixture cleanup')
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  test('项目 stdio CRUD、环境变量、工具发现和启停均真实落盘', async () => {
    await addStdio('ui-stdio', 'UI stdio')
    expect(existsSync(projectConfig())).toBe(true)
    const block = serverBlock('ui-stdio')
    await block.getByRole('button', { name: '测试', exact: true }).click()
    await expect(page.locator('.mcp-notice')).toContainText('连接成功')
    await expect.poll(() => existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('fixture-secret')
    await expect(block.getByRole('switch', { name: 'echo 启用', exact: true })).toBeVisible()
    await expect(block.getByRole('switch', { name: 'second 启用', exact: true })).toBeVisible()

    const echo = block.getByRole('switch', { name: 'echo 启用', exact: true })
    await echo.click()
    await expect(echo).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-stdio'].disabledTools).toEqual(['echo'])
    await echo.click()
    await expect(echo).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-stdio'].disabledTools).toEqual([])

    const serverToggle = block.getByRole('switch', { name: 'UI stdio 启用', exact: true })
    await serverToggle.click()
    await expect(serverToggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-stdio'].enabled).toBe(false)
    await serverToggle.click()
    await expect(serverToggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-stdio'].enabled).toBe(true)

    await block.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()
    await page.getByLabel('MCP 描述', { exact: true }).fill('edited project server')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.mcp-form')).toHaveCount(0)
    await expect.poll(() => JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-stdio'].description).toBe('edited project server')
  })

  test('全局服务器编辑与停用只改全局文件，不创建项目覆盖', async () => {
    await addStdio('ui-global', 'UI global', 'global')
    const block = serverBlock('ui-global')
    await expect.poll(() => existsSync(globalConfig())).toBe(true)
    expect(existsSync(projectConfig())).toBe(true)
    const before = JSON.parse(readFileSync(projectConfig(), 'utf8'))
    expect(before.mcpServers['ui-global']).toBeUndefined()

    await block.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByLabel('MCP 名称', { exact: true }).fill('UI global edited')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.mcp-form')).toHaveCount(0)
    await expect.poll(() => JSON.parse(readFileSync(globalConfig(), 'utf8')).mcpServers['ui-global'].name).toBe('UI global edited')
    expect(JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-global']).toBeUndefined()
    expect(JSON.parse(readFileSync(projectConfig(), 'utf8'))).toEqual(before)

    const toggle = serverBlock('ui-global').getByRole('switch', { name: 'UI global edited 启用', exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => JSON.parse(readFileSync(globalConfig(), 'utf8')).mcpServers['ui-global'].enabled).toBe(false)
    expect(JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-global']).toBeUndefined()
    expect(JSON.parse(readFileSync(projectConfig(), 'utf8'))).toEqual(before)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await serverBlock('ui-global').getByRole('button', { name: '测试', exact: true }).click()
    await expect(page.locator('.mcp-notice')).toContainText('连接成功')
    const echo = serverBlock('ui-global').getByRole('switch', { name: 'echo 启用', exact: true })
    await echo.click()
    await expect(echo).toHaveAttribute('aria-checked', 'false')
    expect(JSON.parse(readFileSync(globalConfig(), 'utf8')).mcpServers['ui-global'].disabledTools).toEqual(['echo'])
    expect(JSON.parse(readFileSync(projectConfig(), 'utf8'))).toEqual(before)
  })

  test('HTTP MCP 输入请求头并完成真实工具发现', async () => {
    await page.getByRole('button', { name: '新增服务器', exact: true }).click()
    await page.getByLabel('MCP id', { exact: true }).fill('ui-http')
    await page.getByLabel('MCP 名称', { exact: true }).fill('UI HTTP')
    await page.getByLabel('MCP 传输类型', { exact: true }).selectOption('streamableHttp')
    await page.getByLabel('MCP URL', { exact: true }).fill(httpUrl)
    await page.getByLabel('MCP 请求头', { exact: true }).fill(JSON.stringify({ 'X-MCP-UI': 'fixture-header' }))
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.mcp-form')).toHaveCount(0)
    const block = serverBlock('ui-http')
    await block.getByRole('button', { name: '测试', exact: true }).click()
    await expect(page.locator('.mcp-notice')).toContainText('连接成功')
    await expect(block.getByRole('switch', { name: 'http_echo 启用', exact: true })).toBeVisible()
    expect(httpHeaders.length).toBeGreaterThanOrEqual(2)
    expect(httpHeaders.every(headers => headers['x-mcp-ui'] === 'fixture-header')).toBe(true)
    expect(httpHeaders.some(headers => headers['mcp-session-id'] === 'mcp-ui-session')).toBe(true)
  })

  test('JSON 编辑器可批量导入、读取并保留标准 type 配置', async () => {
    const jsonServer = {
      'json-ui': {
        type: 'stdio',
        name: 'JSON UI',
        command: process.execPath,
        args: ['-e', stdioServerScript()],
        env: {}
      }
    }
    await page.getByLabel('MCP JSON 配置', { exact: true }).fill(JSON.stringify({ mcpServers: jsonServer }, null, 2))
    await page.getByRole('button', { name: '应用 JSON', exact: true }).click()
    await expect(serverBlock('json-ui')).toBeVisible()
    await expect.poll(() => JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['json-ui'].transportType).toBe('stdio')
    await page.getByRole('button', { name: '读取当前配置', exact: true }).click()
    await expect(page.getByLabel('MCP JSON 配置', { exact: true })).toContainText('json-ui')
  })

  test('错误配置可恢复，删除项目和全局记录并验证磁盘清理', async () => {
    await page.getByRole('button', { name: '新增服务器', exact: true }).click()
    await page.getByLabel('MCP id', { exact: true }).fill('ui-invalid')
    await page.getByLabel('MCP 名称', { exact: true }).fill('UI invalid')
    await page.getByLabel('MCP 环境变量', { exact: true }).fill('[]')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.settings-view--mcp [role="alert"]')).toContainText(/环境变量.*JSON 对象/)
    expect(JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers['ui-invalid']).toBeUndefined()
    await page.getByLabel('MCP 环境变量', { exact: true }).fill('{}')
    await page.getByLabel('MCP 命令', { exact: true }).fill(process.execPath)
    await page.getByLabel('MCP 参数', { exact: true }).fill('-e\nprocess.exit(17)')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.mcp-form')).toHaveCount(0)
    await expect(serverBlock('ui-invalid')).toBeVisible()
    await serverBlock('ui-invalid').getByRole('button', { name: '测试', exact: true }).click()
    await expect(page.locator('.settings-view--mcp [role="alert"]')).toContainText('MCP stdio exited with code 17')
    await expect(serverBlock('ui-invalid').getByRole('button', { name: '编辑', exact: true })).toBeEnabled()
    await serverBlock('ui-invalid').getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByLabel('MCP 参数', { exact: true }).fill(`-e\n${stdioServerScript()}`)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.mcp-form')).toHaveCount(0)
    await serverBlock('ui-invalid').getByRole('button', { name: '测试', exact: true }).click()
    await expect(page.locator('.mcp-notice')).toContainText('UI invalid 连接成功')
    await expect(serverBlock('ui-invalid').getByRole('switch', { name: 'echo 启用', exact: true })).toBeVisible()
    await expect(page.locator('.settings-view--mcp [role="alert"]')).toHaveCount(0)

    for (const id of ['ui-invalid', 'ui-http', 'json-ui', 'ui-global', 'ui-stdio']) {
      const block = serverBlock(id)
      await block.getByRole('button', { name: '删除', exact: true }).click()
      await confirmDelete()
      await expect(serverBlock(id)).toHaveCount(0)
    }
    await expect.poll(() => JSON.parse(readFileSync(projectConfig(), 'utf8')).mcpServers).toEqual({})
    await expect.poll(() => JSON.parse(readFileSync(globalConfig(), 'utf8')).mcpServers).toEqual({})
  })
})
