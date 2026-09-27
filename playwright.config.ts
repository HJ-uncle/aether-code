import { defineConfig } from '@playwright/test'

/**
 * E2E 配置
 *
 * workers 必须为 1：应用用了 requestSingleInstanceLock（第二个实例会直接退出），
 * 且多个实例会争抢引擎端口，并行跑必然互相干扰。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
