import { defineConfig } from '@playwright/test'

/** Isolated UI fixtures plus status contracts. Build the application before running. */
export default defineConfig({
  testDir: '..',
  testMatch: ['work-home-ui.spec.ts', 'task-status-icons-ui.spec.ts'],
  grep: /Work 图标|异常状态|运行、等待|侧栏和首页/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  tsconfig: '../../tsconfig.web.json',
  use: { trace: 'retain-on-failure' },
  outputDir: '../../.e2e-tmp/work-icons-results',
})
