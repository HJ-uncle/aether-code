import { defineConfig } from '@playwright/test'

/** Build before running: real Electron result cards use an isolated fixture. */
export default defineConfig({
  testDir: '..', testMatch: 'work-result-visibility-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/result-card-results', use: { trace: 'retain-on-failure' }
})
