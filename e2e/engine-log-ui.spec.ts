/** Native IPC integration: ordered batch/legacy delivery, hidden Output freeze, bounded retention and clear. */
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { monitorElectronHealth } from './helpers/electron-health'

test('日志批次在隐藏 Work 期间只缓存，返回输出后显示最新500条且可清空', async ({}, testInfo) => {
  const root = resolve(__dirname, '..'),
    parent = join(root, '.e2e-tmp')
  mkdirSync(parent, { recursive: true })
  const fixture = mkdtempSync(join(parent, 'engine-log-ui-'))
  writeFileSync(
    join(fixture, 'settings.json'),
    JSON.stringify({ autoStartEngine: false, graphicsMode: 'software' })
  )
  const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root, env })
  const health = await monitorElectronHealth(app, 'engine-log-ui')
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.app-mode-switch')).toBeVisible()
    await page.locator('.status-bar button').first().click()
    const output = page.locator('.output')
    await expect(output).toBeVisible()
    await output.getByRole('button', { name: '清空', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.send('engine:log', { ts: Date.now(), level: 'info', line: '兼容中文日志' })
      contents.send('engine:logs', [
        { ts: Date.now(), level: 'info', line: '批次第一条' },
        { ts: Date.now(), level: 'warn', line: '服务器长日志已截断…', truncated: true }
      ])
    })
    await expect(output.locator('.output__line')).toHaveCount(3)
    expect(await output.locator('.output__text').allTextContents()).toEqual([
      '兼容中文日志',
      '批次第一条',
      '服务器长日志已截断…'
    ])
    await expect(output.locator('.output__text').last()).toHaveAttribute(
      'title',
      '日志过长，已截断显示'
    )
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(output).toBeHidden()
    await page.evaluate(() => {
      let received = 0
      const off = window.aether.engine.onLog((entry) => {
        if (entry.line.startsWith('HIDDEN_LOG_') && ++received === 600) {
          document.documentElement.dataset.logUiReceived = String(received)
          off()
        }
      })
    })
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      for (let offset = 0; offset < 600; offset += 100)
        contents.send(
          'engine:logs',
          Array.from({ length: 100 }, (_, index) => ({
            ts: Date.now(),
            level: 'info',
            line: `HIDDEN_LOG_${offset + index}`
          }))
        )
    })
    await expect(page.locator('html')).toHaveAttribute('data-log-ui-received', '600')
    // This asserts the retained DOM itself, not just display:none.
    await expect(output.locator('.output__line')).toHaveCount(3)
    await page.getByRole('tab', { name: /Code/ }).click()
    await expect(output).toBeVisible()
    await expect(output.locator('.output__line')).toHaveCount(500)
    await expect(output.locator('.output__text').first()).toHaveText('HIDDEN_LOG_100')
    await expect(output.locator('.output__text').last()).toHaveText('HIDDEN_LOG_599')
    await output.getByRole('button', { name: '清空', exact: true }).click()
    await expect(output.locator('.output__line')).toHaveCount(0)
    health.assertHealthy()
  } finally {
    await health.closeAndAssert(testInfo)
    const target = resolve(fixture)
    if (dirname(target) === parent && basename(target).startsWith('engine-log-ui-'))
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
