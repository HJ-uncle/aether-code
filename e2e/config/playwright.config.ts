import { defineConfig } from '@playwright/test'

/** Default Electron suite: keep collection scoped to real e2e specs.
 * Contract probes under scripts/ and source folders have their own loaders and
 * are intentionally run by their dedicated commands/configurations. */
export default defineConfig({
  testDir: '..',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  outputDir: '../../.e2e-tmp/default-results',
  use: { trace: 'retain-on-failure' }
})
