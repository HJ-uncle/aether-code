import { defineConfig } from '@playwright/test'

// New targeted renderer acceptance; it never runs the legacy E2E collection.
export default defineConfig({
  testDir: '..', testMatch: 'docx-preview-regions.spec.ts', workers: 1, fullyParallel: false,
  timeout: 30_000, expect: { timeout: 10_000 }, reporter: 'list',
  outputDir: '../../.e2e-tmp/docx-preview-regions-results',
})
