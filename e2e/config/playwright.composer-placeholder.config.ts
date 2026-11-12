import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '..', testMatch: 'composer-placeholder-ui.spec.ts', workers: 1,
  fullyParallel: false, timeout: 90_000, expect: { timeout: 12_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/composer-placeholder-results' })
