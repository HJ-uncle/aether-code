import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', testMatch: 'builtin-agent-team-*.spec.ts', workers: 1,
  timeout: 90_000, expect: { timeout: 15_000 }, reporter: 'list',
  tsconfig: './tsconfig.web.json', outputDir: '.e2e-tmp/builtin-agent-team-results'
})
