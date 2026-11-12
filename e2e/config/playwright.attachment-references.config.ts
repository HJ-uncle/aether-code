import { defineConfig } from '@playwright/test'

/** Isolated Electron profile and authenticated fixture server; build before running. */
export default defineConfig({
  testDir: '..',
  testMatch: ['attachment-references-ui.spec.ts', 'attachment-references.spec.ts', 'attachment-editor-transfer.spec.ts', 'work-attachments.spec.ts',
    'resource-mentions.spec.ts', 'resource-queue-mentions.spec.ts', 'toolkit-queue-mentions.spec.ts'],
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  tsconfig: '../../tsconfig.web.json',
  use: { trace: 'retain-on-failure' },
  outputDir: '../../.e2e-tmp/attachment-references-results'
})
