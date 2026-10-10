/** Pure tests: builtin/legacy coverage, safe MCP labels and unchanged approval identifiers. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { mcpToolDisplayName, toolDisplayName } from '../src/renderer/src/core/engine/tool-labels'
import { buildToolResponse, normalizePending } from '../src/renderer/src/core/engine/pending'

const browserTools = {
  browser_tabs: '浏览器标签',
  browser_open: '打开浏览器页面',
  browser_navigate: '浏览器导航',
  browser_snapshot: '读取浏览器页面',
  browser_screenshot: '浏览器截图',
  browser_click: '点击浏览器元素',
  browser_fill: '填写浏览器输入框',
  browser_scroll: '滚动浏览器页面',
  browser_press_key: '浏览器按键',
  browser_wait: '等待浏览器状态',
  browser_console: '读取浏览器控制台',
  browser_network: '筛选浏览器网络请求',
  browser_network_request: '读取浏览器请求详情',
  browser_set_viewport: '调整浏览器视口',
  browser_close: '关闭浏览器标签'
}

test('全部浏览器操作有明确中文名，网络列表与详情不混淆', () => {
  for (const [name, label] of Object.entries(browserTools)) expect(toolDisplayName(name)).toBe(label)
})

test('补齐历史检索、记忆、代理执行和内置技能工具', () => {
  expect(toolDisplayName('search_history')).toBe('检索会话原始历史')
  expect(toolDisplayName('forget')).toBe('删除记忆')
  expect(toolDisplayName('link_memories')).toBe('建立记忆关联')
  expect(toolDisplayName('agent_do_create')).toBe('执行创建代理')
  expect(toolDisplayName('agent_do_update')).toBe('执行更新代理')
  expect(toolDisplayName('agent_do_delete')).toBe('执行删除代理')
  expect(toolDisplayName('calculate')).toBe('计算器')
  expect(toolDisplayName('get_time')).toBe('获取时间')
})

test('旧历史别名仍显示中文，不改变未知名称或原型属性', () => {
  expect(toolDisplayName('run_command')).toBe('执行命令')
  expect(toolDisplayName('smart_read')).toBe('读取文件')
  expect(toolDisplayName('glob')).toBe('查找文件')
  expect(toolDisplayName('grep')).toBe('搜索内容')
  expect(toolDisplayName('')).toBe('未命名工具')
  for (const name of ['custom_tool', 'Browser_Screenshot', 'constructor', 'toString', '__proto__']) {
    expect(toolDisplayName(name)).toBe(name)
  }
})

test('MCP 保留服务身份；不凭有歧义的下划线猜测第三方工具', () => {
  expect(toolDisplayName('mcp__qa_browser__browser_screenshot')).toBe('浏览器截图（MCP · qa_browser）')
  expect(toolDisplayName('mcp__qa_browser__custom_probe')).toBe('mcp__qa_browser__custom_probe')
  expect(toolDisplayName('mcp_qa_browser_custom_browser_screenshot')).toBe('mcp_qa_browser_custom_browser_screenshot')
  expect(mcpToolDisplayName('qa_browser', 'mcp_qa_browser_browser_screenshot')).toBe('浏览器截图')
  expect(mcpToolDisplayName('qa_browser', 'mcp_qa_browser_custom_browser_screenshot')).toBe('custom_browser_screenshot')
  expect(mcpToolDisplayName('qa', 'mcp_other_browser_screenshot')).toBe('mcp_other_browser_screenshot')
})

test('审批中文仅用于显示，允许与拒绝仍回传原始工具名', () => {
  const pending = normalizePending({ permissionRequest: { requestId: 'permission-1', toolName: 'browser_click' } })
  expect(pending?.question).toBe('安全策略拦截了 点击浏览器元素，是否允许执行？')
  expect(buildToolResponse(pending!, ['approved'])).toEqual({ toolCallId: 'permission-1', name: 'browser_click', output: 'approved' })
  expect(buildToolResponse(pending!, ['rejected']).name).toBe('browser_click')
  expect(normalizePending({ permissionRequest: { requestId: 'permission-2', toolName: 'browser_click', description: '确认提交订单？' } })?.question).toBe('确认提交订单？')
})

test('当前引擎所有声明了显示名的内置工具都有中文映射', () => {
  const engineSource = resolve(__dirname, '../../ai-agent-engine/src')
  test.skip(!existsSync(join(engineSource, 'tools')), '未提供同级引擎源码，固定目录覆盖由上面的测试验证')
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === '__tests__') return []
      const path = join(directory, entry.name)
      return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
    })
  }
  // Read declarations only: importing the engine registry would initialize user DBs and external tools.
  const names = new Set<string>()
  for (const path of [...sourceFiles(join(engineSource, 'tools')), ...sourceFiles(join(engineSource, 'skills'))]) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\bname:\s*'([^']+)'\s*,\s*displayName:/g)) names.add(match[1])
    if (path.endsWith('browser-tools.ts')) {
      for (const match of source.matchAll(/\baction:\s*'([^']+)'\s*,\s*displayName:/g)) names.add(`browser_${match[1]}`)
    }
  }
  expect(names.size).toBeGreaterThanOrEqual(60)
  expect([...names].filter(name => !/[\u3400-\u9fff]/.test(toolDisplayName(name)))).toEqual([])
})
