import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..', testMatch: 'colored-buttons-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 10_000 }, reporter: 'list',
  outputDir: '../../.e2e-tmp/colored-buttons-results',
})
