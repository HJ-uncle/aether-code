import { defineConfig } from '@playwright/test'

/** Build first; serial real Electron settings checks use an isolated profile. */
export default defineConfig({
  testDir: '..', testMatch: 'security-appearance-ui.spec.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list', tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/security-appearance-results', use: { trace: 'retain-on-failure' }
})
