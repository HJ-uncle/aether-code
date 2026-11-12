import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..',
  testMatch: 'image-markup-ui.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  tsconfig: '../../tsconfig.web.json',
  use: { trace: 'retain-on-failure' },
  outputDir: '../../.e2e-tmp/image-color-picker-results'
})
