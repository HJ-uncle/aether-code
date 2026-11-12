import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..', testMatch: 'work-cancelled-approval-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 150_000, expect: { timeout: 15_000 }, reporter: 'list',
  outputDir: '../../.e2e-tmp/work-cancelled-approval-results',
})
