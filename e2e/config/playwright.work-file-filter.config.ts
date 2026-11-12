import { defineConfig } from '@playwright/test'

// Only the fresh Work file-filter acceptance; never the legacy E2E suite.
export default defineConfig({
  testDir: '..', testMatch: ['work-file-filter-ui.spec.ts', 'work-file-filter.spec.ts'], workers: 1, fullyParallel: false,
  timeout: 45_000, expect: { timeout: 15_000 }, reporter: 'list',
  outputDir: '../../.e2e-tmp/work-file-filter-results',
})
