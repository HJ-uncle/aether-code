import { defineConfig } from '@playwright/test'

/** Isolated authenticated fixture; no user profile, provider or MCP process is used. Build first. */
export default defineConfig({
  testDir: '..', testMatch: 'attachment-references-ui.spec.ts',
  grep: /MCP 管理|工具包目录|@ 单列分组/,
  workers: 1, fullyParallel: false, timeout: 180_000, expect: { timeout: 20_000 },
  reporter: 'list', tsconfig: '../../tsconfig.web.json', use: { trace: 'retain-on-failure' },
  outputDir: '../../.e2e-tmp/mcp-toolkit-results'
})
