/** One real desktop and paired engine use the same private profile through two full process restarts. */
import { expect } from '@playwright/test'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AccountState, FamilyIdentity } from '../src/shared/account'
import { app, launch, live, page, profile, registerConnectionHarness, root, settings } from './fixtures/engine-connection-harness'
import { registerFixtureAccount } from './fixtures/account-enrollment'
import { credentialTest as test } from './fixtures/private-credential-test'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
registerConnectionHarness({ captureOnFailure: false, profileArea: 'account-family-handoff' })

const state = (): Promise<AccountState> => page.evaluate(() => window.aether.account.getState())
function stamp(state: AccountState): FamilyIdentity {
  const user = state.user
  if (state.status !== 'authenticated' || !user?.sessionId) throw new Error('Expected a signed-in fixture account')
  return { serviceUrl: state.serviceUrl, userId: user.id, tenantId: user.tenantId, sessionId: user.sessionId }
}

async function start(): Promise<string> {
  const engineEntry = process.env.AETHER_IDE_ENGINE_ENTRY || resolve(process.env.AETHER_ENGINE_SOURCE_DIR || join(root, '../ai-agent-engine'), 'dist/main.js')
  await launch('local', { engineEntry, preferredPort: 12759 })
  await expect.poll(async () => {
    const { phase, mode, adopted, error } = await live()
    if (phase === 'error') throw new Error('Isolated embedded engine could not start: ' + (error ?? 'no error detail'))
    return { phase, mode, adopted }
  }, { timeout: 90_000 }).toEqual({ phase: 'ready', mode: 'embedded', adopted: false })
  const database = (await live()).dataDir
  if (!database || realpathSync(database) !== realpathSync(join(profile, 'engine/state/agent.db'))) throw new Error('Expected the isolated profile database')
  // All copies and file pickers stay in this fixture; the physical system clipboard is never used.
  if (!app) throw new Error('Missing isolated desktop')
  await app.evaluate(({ clipboard, dialog }, file) => {
    let memory = ''
    clipboard.writeText = value => { memory = value }
    clipboard.readText = () => memory
    clipboard.clear = () => { memory = '' }
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, join(profile, 'fixture-parent-recovery.json'))
  return database
}

test('主账号交接设备：无备份拦截，真实切换、进程重启和退出后不会恢复父登录', async () => {
  const database = await start()
  const parent = stamp(await registerFixtureAccount(page, database))
  const childId = await page.evaluate(async parent => {
    const api = window.aether.account
    await api.createChild(parent, '设备成员')
    const family = await api.family(parent)
    if (family.limit !== 3 || family.used !== 1) throw new Error('Unexpected initial quota')
    return family.children[0].id
  }, parent)

  const refused = await page.evaluate(async ({ parent, childId }) => {
    try { await window.aether.account.enterChild(parent, childId); return false }
    catch (error) { return String(error).includes('主账号恢复文件') }
  }, { parent, childId })
  expect(refused).toBe(true)
  expect(stamp(await state())).toEqual(parent)
  expect(await page.evaluate(() => window.aether.account.exportRecovery())).toBe(true)
  await page.evaluate(() => window.aether.account.copyRecovery())
  expect(await app!.evaluate(({ clipboard }) => !!clipboard.readText())).toBe(true)

  await page.locator('.menu-bar').getByRole('button', { name: '个人账号' }).click()
  await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
  const family = settings().getByRole('region', { name: '子账号管理' })
  await family.locator('summary').filter({ has: page.getByText('管理子账号', { exact: true }) }).click()
  await family.locator('summary').filter({ has: page.getByText('设备成员', { exact: true }) }).click()
  await family.getByRole('button', { name: '在此设备使用', exact: true }).click()
  await page.getByRole('dialog', { name: '在此设备使用子账号', exact: true }).getByRole('button', { name: '切换到子账号' }).click()
  await expect(settings().locator('.account-summary h2')).toHaveText('设备成员')
  const child = stamp(await state())
  expect(child.userId).toBe(childId)
  expect(child.tenantId).not.toBe(parent.tenantId)
  expect(child.sessionId).not.toBe(parent.sessionId)
  expect(await app!.evaluate(({ clipboard }) => !!clipboard.readText())).toBe(false)
  await expect.poll(live).toMatchObject({ accountId: childId })
  await expect(family).toHaveCount(0)

  await app!.close()
  await start()
  const after = await state()
  // Embedded identity survives a port change if another local process has claimed the old port.
  expect(stamp(after)).toEqual({ ...child, serviceUrl: (await live()).baseUrl })
  expect(after.recovery).toEqual({ available: false, exportedAt: null })
  await expect.poll(live).toMatchObject({ accountId: childId })
  const forbidden = await page.evaluate(async parent => {
    const api = window.aether.account
    const results = await Promise.allSettled([api.family(parent), api.copyRecovery(), api.exportRecovery(), api.regenerateRecovery()])
    return results.every(r => r.status === 'rejected')
  }, parent)
  expect(forbidden).toBe(true)

  expect((await page.evaluate(() => window.aether.account.logout())).status).toBe('signed-out')
  await app!.close()
  await start()
  expect(await state()).toMatchObject({ status: 'signed-out', user: null })
  await expect.poll(async () => (await live()).accountId ?? null).toBeNull()
  // A separately held backup and an explicit import are the only return path in this fixture.
  const restored = await page.evaluate(() => window.aether.account.importRecovery())
  expect(restored?.user).toMatchObject({ id: parent.userId, tenantId: parent.tenantId, accountKind: 'primary' })
  expect(restored?.user?.sessionId).not.toBe(parent.sessionId)
})
