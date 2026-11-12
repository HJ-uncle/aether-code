import { defineConfig } from '@playwright/test'

/** Real Electron against an authenticated disposable engine fixture. Build first. */
export default defineConfig({
  testDir: '..', testMatch: 'mcp-settings-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/mcp-settings-results', use: { trace: 'retain-on-failure' }
})
