import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: '..', testMatch: 'browser-actionability.spec.ts', workers: 1,
  fullyParallel: false, timeout: 60_000, expect: { timeout: 12_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/browser-actionability-results' })
