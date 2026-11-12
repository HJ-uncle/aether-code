import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..', testMatch: 'engine-status-bar-ui.spec.ts', workers: 1, fullyParallel: false,
  tsconfig: '../../tsconfig.web.json', timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list',
  outputDir: '../../.e2e-tmp/engine-status-results', use: { trace: 'retain-on-failure' }
})
