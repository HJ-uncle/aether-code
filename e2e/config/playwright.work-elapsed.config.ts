import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..',
  testMatch: ['work-subagent-timing.spec.ts', 'work-dependency-progress.spec.ts'],
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  tsconfig: '../../tsconfig.web.json',
  outputDir: '../../.e2e-tmp/work-elapsed-results'
})
