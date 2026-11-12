import { defineConfig } from '@playwright/test'

/** Isolated authenticated fixture: no real MCP process or user profile is used. Build first. */
export default defineConfig({
  testDir: '..', testMatch: 'mcp-settings-scope-ui.spec.ts',
  workers: 1, fullyParallel: false, timeout: 120_000, expect: { timeout: 20_000 },
  reporter: 'list', tsconfig: '../../tsconfig.web.json', use: { trace: 'retain-on-failure' },
  outputDir: '../../.e2e-tmp/mcp-settings-scope-results'
})
