import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '..', testMatch: ['plugins-ui.spec.ts','plugins-real-engine-ui.spec.ts','plugin-form.spec.ts','plugins-application-ui.spec.ts'], workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 15_000 }, reporter: 'list', outputDir: '../../.e2e-tmp/plugins/results', use: { trace: 'retain-on-failure' } })
