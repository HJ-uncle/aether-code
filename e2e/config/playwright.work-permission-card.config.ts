import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..', testMatch: 'work-permission-card-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list',
  outputDir: '../../.e2e-tmp/work-permission-card-results',
})
