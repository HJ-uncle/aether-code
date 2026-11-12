import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..', testMatch: 'remote-search-preview.spec.ts',
  workers: 1, fullyParallel: false, reporter: 'list',
  outputDir: '../../.e2e-tmp/remote-search-preview-results'
})
