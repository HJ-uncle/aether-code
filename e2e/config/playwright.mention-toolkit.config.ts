import { defineConfig } from '@playwright/test'

/** Uses the attachment fixture's isolated profile and authenticated HTTP server. Build first. */
export default defineConfig({
  testDir: '..',
  testMatch: 'attachment-references-ui.spec.ts',
  grep: /@ 单列分组|工具包目录|MCP 管理工具包与插件共同选择|\/ 资源菜单/,
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  tsconfig: '../../tsconfig.web.json',
  use: { trace: 'retain-on-failure' },
  outputDir: '../../.e2e-tmp/mention-toolkit-results'
})
