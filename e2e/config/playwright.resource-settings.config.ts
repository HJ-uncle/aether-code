import { defineConfig } from '@playwright/test'

/** Build first; one real Electron window and a disposable authenticated engine. */
export default defineConfig({
  testDir: '..', testMatch: 'resource-settings-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/resource-settings-results', use: { trace: 'retain-on-failure' }
})
