import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '..', testMatch: 'xlsx-navigation.spec.ts', workers: 1,
  fullyParallel: false, timeout: 90_000, expect: { timeout: 15_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/xlsx-navigation-results',
  webServer: { cwd: '../..', command: 'node e2e/fixtures/xlsx-navigation-server.mjs', url: 'http://127.0.0.1:14631/.e2e-tmp/xlsx-navigation-fixture/index.html',
    reuseExistingServer: false, timeout: 60_000 } })
