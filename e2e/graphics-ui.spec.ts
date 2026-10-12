/** Real-window contracts: software material safety, immediate settings, persisted restart policy and recovery. */
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { monitorElectronHealth } from './helpers/electron-health'

const root = resolve(__dirname, '..'),
  parent = join(root, '.e2e-tmp')
test.describe.serial('图形与视觉效果回退', () => {
  for (const recovery of ['none', 'gpu-process-failed', 'startup-interrupted'] as const) {
    test(`${recovery}: 软件路径不会开启昂贵模糊，并保持重启与恢复契约`, async ({}, testInfo) => {
      mkdirSync(parent, { recursive: true })
      const fixture = mkdtempSync(join(parent, 'graphics-policy-'))
      writeFileSync(
        join(fixture, 'settings.json'),
        JSON.stringify({
          autoStartEngine: false,
          graphicsMode: recovery === 'none' ? 'software' : 'auto',
          visualEffects: 'full'
        })
      )
      if (recovery !== 'none')
        writeFileSync(
          join(fixture, 'graphics-recovery.json'),
          JSON.stringify(
            recovery === 'startup-interrupted'
              ? { version: 1, pendingSince: '2026-10-12T00:00:00Z' }
              : {
                  version: 1,
                  failure: { reason: recovery, at: '2026-10-12T00:00:00Z', exitCode: -1 }
                }
          )
        )
      const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.AETHER_ENABLE_GPU
      const app = await electron.launch({
        args: ['.', `--user-data-dir=${fixture}`],
        cwd: root,
        env
      })
      const health = await monitorElectronHealth(app, `graphics-${recovery}`)
      try {
        const page = await app.firstWindow()
        await expect(page.locator('.app-mode-switch')).toBeVisible()
        await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
        await page
          .locator('.work-sidebar__bottom')
          .getByRole('button', { name: '设置', exact: true })
          .click()
        const dialog = page.locator('.work-settings-dialog')
        await expect(dialog).toBeVisible()
        await dialog.locator('.app-settings__nav-item').filter({ hasText: '外观' }).click()
        await expect(page.locator('html')).toHaveAttribute('data-visual-effects', 'solid')
        const snapshot = await page.evaluate(() => window.aether.graphics.getSnapshot())
        expect(snapshot.hardwareAcceleration).toBe(false)
        expect(snapshot.environmentOverride).toBe(false)
        expect(snapshot.recovery?.reason ?? 'none').toBe(recovery)
        const filters = await dialog.evaluate((panel) =>
          [
            panel,
            panel.querySelector('.app-settings__nav'),
            panel.querySelector('.app-settings__toolbar')
          ].map((element) => element && getComputedStyle(element).backdropFilter)
        )
        expect(filters).toEqual(['none', 'none', 'none'])
        const remainingFilters = await page.evaluate(() =>
          [...document.querySelectorAll('*')]
            .filter((element) => getComputedStyle(element).backdropFilter !== 'none')
            .map((element) => ({
              className: element.className,
              filter: getComputedStyle(element).backdropFilter
            }))
        )
        expect(remainingFilters).toEqual([])
        expect(
          await page
            .locator('.modal-overlay')
            .evaluate((element) => getComputedStyle(element).backdropFilter)
        ).toBe('none')
        await dialog.getByRole('radio', { name: '实色', exact: true }).click()
        await expect
          .poll(
            () => JSON.parse(readFileSync(join(fixture, 'settings.json'), 'utf8')).visualEffects
          )
          .toBe('solid')
        if (recovery === 'none') {
          await dialog.getByRole('radio', { name: '自动', exact: true }).first().click()
          await expect(dialog).toContainText('重启应用后生效')
          expect(
            (await page.evaluate(() => window.aether.graphics.getSnapshot())).restartRequired
          ).toBe(true)
        } else {
          await dialog.getByRole('button', { name: '清除回退记录（重启后重试）' }).click()
          await expect
            .poll(
              async () => (await page.evaluate(() => window.aether.graphics.getSnapshot())).recovery
            )
            .toBeNull()
          expect(
            (await page.evaluate(() => window.aether.graphics.getSnapshot())).restartRequired
          ).toBe(true)
          await page.evaluate(() => window.aether.settings.update({ graphicsMode: 'software' }))
        }
        health.assertHealthy()
      } finally {
        await health.closeAndAssert(testInfo)
        const target = resolve(fixture)
        if (dirname(target) === parent && basename(target).startsWith('graphics-policy-'))
          rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })
  }
})
