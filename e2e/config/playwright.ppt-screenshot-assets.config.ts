import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: '..', testMatch: 'ppt-screenshot-assets.spec.ts', workers: 1,
  fullyParallel: false, timeout: 90_000, expect: { timeout: 12_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/ppt-screenshot-assets-results' })
