import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', testMatch: 'compact-reading-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 180_000, expect: { timeout: 20_000 }, reporter: 'list',
  tsconfig: './tsconfig.web.json', outputDir: '.e2e-tmp/compact-reading-results'
})
