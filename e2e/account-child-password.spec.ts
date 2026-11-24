/** Real child-password forms → preload → account IPC → a disposable paired engine and SQLite.
 * The clipboard is captured inside the isolated Electron main process. No OS clipboard is read or written. */
import { expect, type Locator } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AccountState, ChildPasswordScope, FamilyIdentity } from '../src/shared/account'
import { registerFixtureAccount } from './fixtures/account-enrollment'
import { app, b, launch, live, page, profile, registerConnectionHarness, root, settings } from './fixtures/engine-connection-harness'
import { credentialTest as test } from './fixtures/private-credential-test'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
registerConnectionHarness({ captureOnFailure: false, profileArea: 'child-password-desktop' })

const account = (): Locator => settings().locator('.account-settings')
const memberName = '密码验收成员'
const button = (scope: Locator, name: string): Locator => scope.getByRole('button', { name, exact: true })
const readAccount = (): Promise<AccountState> => page.evaluate(() => window.aether.account.getState())
const signedOutScope = (url: string): ChildPasswordScope => ({ serviceUrl: url, userId: null, tenantId: null, sessionId: null })
function identity(state: AccountState): FamilyIdentity {
  const user = state.user
  if (state.status !== 'authenticated' || !user?.sessionId) throw new Error('Expected an authenticated fixture account and session')
  return { serviceUrl: state.serviceUrl, userId: user.id, tenantId: user.tenantId, sessionId: user.sessionId }
}
async function launchPaired(): Promise<string> {
  const engineEntry = process.env.AETHER_IDE_ENGINE_ENTRY || resolve(process.env.AETHER_ENGINE_SOURCE_DIR || join(root, '../ai-agent-engine'), 'dist/main.js')
  await launch('local', { engineEntry, preferredPort: 12573 })
  await expect.poll(live, { timeout: 90_000 }).toMatchObject({ phase: 'ready', mode: 'embedded', adopted: false })
  const database = (await live()).dataDir
  if (!database || realpathSync(database) !== realpathSync(join(profile, 'engine', 'state', 'agent.db'))) throw new Error('Refusing to enroll outside the isolated desktop profile')
  await expect.poll(async () => (await readAccount()).childPasswordAvailable, { message: 'Build the paired engine with child-password support before running this spec' }).toBe(true)
  return database
}
async function openAccount(): Promise<void> {
  await page.locator('.menu-bar').getByRole('button', { name: /^(登录账号|个人账号)$/ }).click()
  await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
  await expect(account()).toBeVisible()
}
const disclosure = (scope: Locator, title: string): Locator => scope.locator('summary').filter({ has: page.getByText(title, { exact: true }) })
async function expand(scope: Locator, title: string): Promise<void> {
  const summary = disclosure(scope, title)
  await expect(summary).toBeVisible()
  if (!await summary.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) await summary.click()
}
// Locator.fill can disclose its argument in a timeout call log. Deliver the same native input event without reporting the value.
function fillSecret(form: Locator, name: string, value: string): Promise<void> {
  return fillMaskedField(form.locator('input[name="' + name + '"]'), value)
}
async function fillMaskedField(field: Locator, value: string): Promise<void> {
  await expect(field).toBeVisible(); await expect(field).toBeEditable(); await expect(field).toHaveAttribute('type', 'password')
  await field.evaluate((node, text) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!(node instanceof HTMLInputElement) || node.type !== 'password' || !set) throw new Error('Expected a masked credential field')
    node.focus(); set.call(node, text); node.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
// A native <details> looks closed even if a visible password field is only hidden by CSS.
// Verify the draft has actually been discarded and the reveal toggle resets on reopening.
async function expectPrivateDisclosure(scope: Locator, title: string, form: Locator, fieldLabel: string): Promise<void> {
  const field = form.locator('input[name="password"]'), marker = secret(), toggle = disclosure(scope, title)
  await fillMaskedField(field, marker)
  await button(form, '显示' + fieldLabel).click()
  await expect(field).toHaveAttribute('type', 'text')
  expect(await field.evaluate((el, expected) => (el as HTMLInputElement).value === expected, marker)).toBe(true)
  await toggle.click(); await expect(field).toBeHidden()
  await expect.poll(() => scope.evaluate((element, value) => Array.from(element.querySelectorAll('input')).some(input => input.value === value), marker), { message: 'Closing this disclosure must discard the exposed credential' }).toBe(false)
  await expand(scope, title)
  await expect(field).toHaveAttribute('type', 'password')
  expect(await field.evaluate(el => (el as HTMLInputElement).value.length)).toBe(0)
  await expect(button(form, '显示' + fieldLabel)).toHaveAttribute('aria-pressed', 'false')
}
async function noEcho(secrets: string[]): Promise<void> {
  const exposed = await page.evaluate(async values => {
    const scope = document.querySelector('.account-settings')
    if (!scope) throw new Error('Missing account view')
    const state = await window.aether.account.getState()
    const surfaces = [scope.textContent ?? '', JSON.stringify(state)]
    if (state.status === 'authenticated' && state.user?.accountKind === 'primary' && state.user.mainAccountActivated && state.user.sessionId) {
      const { id, tenantId, sessionId } = state.user
      surfaces.push(JSON.stringify(await window.aether.account.family({ serviceUrl: state.serviceUrl, userId: id, tenantId, sessionId })))
    }
    for (const el of scope.querySelectorAll('[title], [aria-label], input')) {
      surfaces.push(el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? '')
      if (el instanceof HTMLInputElement) surfaces.push(el.value)
    }
    return values.some(secret => secret.length > 0 && surfaces.some(text => text.includes(secret)))
  }, secrets)
  expect(exposed, 'A credential remained in the account view or public account state').toBe(false)
}
async function signOut(): Promise<void> {
  await button(account(), '退出登录').click()
  await button(page.getByRole('dialog', { name: '退出账号', exact: true }), '退出登录').click()
  await expect.poll(async () => (await readAccount()).status).toBe('signed-out')
  await expect(button(account(), '登录已有账号')).toBeVisible()
}
async function loginForm(): Promise<Locator> {
  const entry = button(account(), '登录已有账号')
  if ((await entry.getAttribute('aria-expanded')) !== 'true') await entry.click()
  const panel = account().getByRole('region', { name: '登录已有账号', exact: true })
  await expand(panel, '用子账号密码登录')
  return panel
}
async function login(loginName: string, password: string, expectedId?: string): Promise<void> {
  const panel = await loginForm()
  await panel.getByLabel('子账号登录名', { exact: true }).fill(loginName)
  await fillSecret(panel, 'password', password)
  await button(panel, '登录子账号').click()
  if (expectedId) {
    await expect(account().getByRole('heading', { name: memberName, exact: true })).toBeVisible()
    expect((await readAccount()).user?.id).toBe(expectedId)
  } else {
    await expect(panel.getByRole('alert')).toHaveText('子账号登录名或密码不正确。')
    expect((await readAccount()).status).toBe('signed-out')
  }
}
type Recheck = { database: string; owner: FamilyIdentity; child: string; parentKey: string }
// Age only the test session. Real server time and real recovery verification remain untouched.
function withFixtureDatabase<T>(file: string, work: (db: DatabaseSync) => T): T {
  const parent = join(realpathSync(root), '.e2e-tmp', 'child-password-desktop')
  if (!/^profile-[a-z0-9]{6}$/i.test(basename(profile)) || relative(parent, dirname(realpathSync(profile))) !== '' ||
      relative(join(realpathSync(profile), 'engine/state/agent.db'), realpathSync(file)) !== '') throw new Error('Refusing to open a database outside the assigned profile')
  const db = new DatabaseSync(file)
  try { db.exec('PRAGMA busy_timeout=3000'); return work(db) } finally { db.close() }
}
function childHash(db: DatabaseSync, id: string): string {
  const hash = db.prepare('SELECT password_hash FROM account_child_passwords WHERE user_id=?').get(id)?.password_hash
  if (typeof hash !== 'string' || !hash) throw new Error('Missing initialized test credential')
  return hash
}
async function openManagedLogin(): Promise<{ family: Locator; dialog: Locator }> {
  const family = account().getByRole('region', { name: '子账号管理' })
  await expand(family, '管理子账号'); await expand(family, memberName)
  await button(family, '设置登录').click()
  return { family, dialog: page.getByRole('dialog', { name: '管理子账号登录：' + memberName, exact: true }) }
}
function ageRecentAuth(db: DatabaseSync, owner: FamilyIdentity): void {
  const modified = db.prepare('UPDATE account_sessions SET authenticated_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').run(Date.now() - 11 * 60_000, owner.sessionId, owner.userId)
  if (Number(modified.changes) !== 1) throw new Error('Expected exactly one isolated parent session')
}
async function manage(loginName: string, password: string, initial: boolean, challenge?: Recheck): Promise<void> {
  const { family, dialog } = await openManagedLogin()
  const name = dialog.getByLabel('子账号登录名', { exact: true })
  await expect(name).toHaveValue(initial ? '' : loginName.toLowerCase())
  if (initial) await name.fill(loginName)
  await expect.poll(() => dialog.locator('input[name="newPassword"]').evaluate(el => (el as HTMLInputElement).value.length)).toBe(0)
  await fillSecret(dialog, 'newPassword', password)
  const previous = challenge && withFixtureDatabase(challenge.database, db => {
    ageRecentAuth(db, challenge.owner)
    return childHash(db, challenge.child)
  })
  await button(dialog, '保存登录设置').click()
  if (challenge) {
    const verify = page.getByRole('dialog', { name: '重新验证身份', exact: true })
    await expect(verify).toBeVisible()
    expect(withFixtureDatabase(challenge.database, db => childHash(db, challenge.child) === previous), 'A stale parent must not update the password before reauth').toBe(true)
    await fillMaskedField(verify.getByLabel('恢复码', { exact: true }), challenge.parentKey)
    await button(verify, '验证并继续').click(); await expect(verify).toHaveCount(0)
  }
  await expect(dialog).toHaveCount(0)
  await expect(family.getByText('子账号的登录设置已保存。', { exact: true })).toBeVisible()
}

async function privateClipboard() {
  if (!app) throw new Error('Fixture desktop did not start')
  const clipboard = await app.evaluateHandle(({ clipboard }) => {
    const memory = { value: '', writes: 0 }
    clipboard.writeText = text => { memory.value = text; memory.writes++ }
    return memory
  })
  const takeCopy = async (): Promise<string> => clipboard.evaluate(memory => {
    if (memory.writes !== 1 || !memory.value) throw new Error('Expected one write to the private test clipboard')
    const result = memory.value; memory.value = ''; memory.writes = 0; return result
  })
  return { takeCopy, dispose: () => clipboard.dispose() }
}
// Sign in with the actual UI after each credential change; a success notice alone cannot establish which credentials are still valid.
test('主账号配置和重置、子账号本人改密、用一次性恢复码找回', async () => {
  const db = await launchPaired(), clipboard = await privateClipboard()
  const loginName = 'QA.' + randomBytes(8).toString('hex'), initial = secret(), reset = secret(), changed = secret(), recovered = secret()
  const parent = identity(await registerFixtureAccount(page, db))
  await page.evaluate(() => window.aether.account.copyRecovery())
  const parentKey = await clipboard.takeCopy()
  await openAccount()
  const family = account().getByRole('region', { name: '子账号管理' })
  await expand(family, '管理子账号'); await button(family, '添加子账号').click()
  await family.getByLabel('子账号名称', { exact: true }).fill(memberName); await button(family, '创建子账号').click()
  await expect(family.getByText(memberName, { exact: true })).toBeVisible()
  const child = await page.evaluate(async ({ parent, memberName }) => (await window.aether.account.family(parent)).children.find(c => c.name === memberName)?.id, { parent, memberName })
  if (!child) throw new Error('Created child missing from the real family list')
  await manage(loginName, initial, true); await noEcho([initial, parentKey]); await signOut()
  await login(loginName, initial, child)
  const firstSession = identity(await readAccount())
  await expect(family).toHaveCount(0)
  expect(await staleFamilyOperations(parent, child), 'A parent form cannot remain valid when signed in as the child').toBe(true)
  await signOut()
  const restored = identity(await page.evaluate(key => window.aether.account.login(key), parentKey))
  expect(restored.userId).toBe(parent.userId); expect(restored.sessionId).not.toBe(parent.sessionId)
  expect(await staleFamilyOperations(parent, child), 'An earlier session of the same parent must be rejected').toBe(true)
  await manage(loginName, reset, false, { database: db, owner: restored, child, parentKey }); await noEcho([initial, reset, parentKey]); await signOut()
  await login(loginName, initial); await login(loginName, reset, child)
  const childScope = identity(await readAccount()); expect(childScope.sessionId).not.toBe(firstSession.sessionId)
  const security = account().getByRole('region', { name: '账号安全' })
  await expand(security, '修改子账号密码')
  const self = security.locator('form').filter({ has: page.getByRole('button', { name: '保存新密码', exact: true }) })
  await fillSecret(self, 'password', initial); await fillSecret(self, 'newPassword', changed); await button(self, '保存新密码').click()
  await expect(self.getByRole('alert')).toHaveText('当前密码或子账号恢复码不正确。')
  await fillSecret(self, 'password', reset); await button(self, '保存新密码').click()
  await expect(security.getByText('新密码已生效，其他设备已退出。', { exact: true })).toBeVisible()
  expect(identity(await readAccount()).sessionId).toBe(childScope.sessionId)
  await expand(security, '备用密码恢复码')
  const issue = security.locator('form').filter({ has: page.getByRole('button', { name: '生成并复制恢复码', exact: true }) })
  await expectPrivateDisclosure(security, '备用密码恢复码', issue, '当前密码')
  await fillSecret(issue, 'password', changed); await button(issue, '生成并复制恢复码').click()
  await expect(security.getByText('恢复码已复制，请妥善保存。', { exact: true })).toBeVisible()
  const recoveryCode = await clipboard.takeCopy()
  expect(/^aether_child_reset_[A-Za-z0-9_-]{43}$/.test(recoveryCode), 'Expected a child-only reset code').toBe(true)
  await noEcho([parentKey, initial, reset, changed, recoveryCode]); await signOut(); await login(loginName, reset)
  const panel = await loginForm()
  const attemptRecovery = async (newPassword: string): Promise<void> => {
    await button(panel, '忘记子账号密码').click()
    await panel.getByLabel('子账号登录名', { exact: true }).fill(loginName)
    await fillSecret(panel, 'recoveryKey', recoveryCode); await fillSecret(panel, 'newPassword', newPassword)
    await button(panel, '重置密码').click()
  }
  await attemptRecovery(recovered)
  await expect(panel.getByText('密码已重置，请用新密码登录。', { exact: true })).toBeVisible()
  await expect(panel.getByLabel('子账号登录名', { exact: true })).toHaveValue(loginName.toLowerCase())
  await attemptRecovery(secret())
  await expect(panel.getByRole('alert')).toHaveText('子账号登录名或恢复码不正确。')
  await button(panel, '返回密码登录').click()
  await login(loginName, changed); await login(loginName, recovered, child)
  await noEcho([initial, reset, changed, recovered, parentKey, recoveryCode]); await clipboard.dispose()
})

function secret(): string { return randomBytes(24).toString('base64url') }
function staleFamilyOperations(scope: FamilyIdentity, id: string): Promise<boolean> {
  return page.evaluate(async ({ scope, id, unused }) => {
    const api = window.aether.account
    for (const op of [() => api.getChildLoginInfo(scope, id), () => api.setManagedChildLogin(scope, id, { password: unused })]) {
      try { await op(); return false } catch (error) { if (!/服务或账号已切换/.test(String(error))) return false }
    }
    return true
  }, { scope, id, unused: secret() })
}

test('主账号同一会话过期会立即取消待验证的子账号改密，重新登录不会续办', async () => {
  const database = await launchPaired(), clipboard = await privateClipboard()
  const owner = identity(await registerFixtureAccount(page, database))
  await page.evaluate(() => window.aether.account.copyRecovery())
  const parentKey = await clipboard.takeCopy(), loginName = 'qa.' + randomBytes(8).toString('hex'), initial = secret(), abandoned = secret()
  const child = await page.evaluate(async ({ owner, memberName, loginName, initial }) => {
    const api = window.aether.account
    await api.createChild(owner, memberName)
    const child = (await api.family(owner)).children.find(member => member.name === memberName)
    if (!child) throw new Error('Missing fixture family member')
    await api.setManagedChildLogin(owner, child.id, { loginName, password: initial })
    return child.id
  }, { owner, memberName, loginName, initial })
  await openAccount()
  const { dialog } = await openManagedLogin()
  await fillSecret(dialog, 'newPassword', abandoned)
  const original = withFixtureDatabase(database, db => { ageRecentAuth(db, owner); return childHash(db, child) })
  await button(dialog, '保存登录设置').click()
  const proof = page.getByRole('dialog', { name: '重新验证身份', exact: true })
  await fillMaskedField(proof.getByLabel('恢复码', { exact: true }), parentKey)
  await expect(button(proof, '验证并继续')).toBeEnabled()

  // The service really expires this very session; the desktop keeps the same cached user/session when reporting the rejection.
  withFixtureDatabase(database, db => {
    const result = db.prepare('UPDATE account_sessions SET expires_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').run(Date.now() - 1000, owner.sessionId, owner.userId)
    if (Number(result.changes) !== 1) throw new Error('Expected exactly one isolated parent session to expire')
  })
  const expired = await readAccount()
  expect(expired).toMatchObject({ status: 'expired', serviceUrl: owner.serviceUrl, user: { id: owner.userId, tenantId: owner.tenantId, sessionId: owner.sessionId } })
  await expect(button(account(), '重新登录')).toBeVisible()
  await expect(proof).toHaveCount(0); await expect(dialog).toHaveCount(0)
  await noEcho([abandoned, parentKey])
  await button(account(), '重新登录').click()
  const signIn = account().getByRole('region', { name: '登录已有账号', exact: true })
  await fillMaskedField(signIn.getByLabel('恢复码', { exact: true }), parentKey); await button(signIn, '登录').click()
  await expect(account().locator('.account-status')).toHaveText('已登录')
  expect(identity(await readAccount()).sessionId).not.toBe(owner.sessionId)
  await expect(proof).toHaveCount(0); await expect(dialog).toHaveCount(0)
  expect(withFixtureDatabase(database, db => childHash(db, child) === original), 'Logging in again must not replay the expired password change').toBe(true)
  await signOut(); await login(loginName, abandoned); await login(loginName, initial, child)
  await clipboard.dispose()
})

test('切换服务会关闭子账号密码草稿，并在 IPC 拒绝原服务的匿名凭据', async () => {
  await launchPaired(); const source = signedOutScope((await live()).baseUrl)
  await openAccount(); const draft = await loginForm(), name = 'switch-fixture', password = secret()
  await expectPrivateDisclosure(draft, '用子账号密码登录', draft, '子账号密码')
  await draft.getByLabel('子账号登录名', { exact: true }).fill(name); await fillSecret(draft, 'password', password)
  const result = await page.evaluate(async url => {
    const settings = await window.aether.settings.get()
    return window.aether.engine.applyConnection({ engineMode: 'remote', preferredPort: settings.preferredPort, remoteBaseUrl: url, remoteWorkspaceRoot: '', autoStartEngine: true })
  }, b.origin)
  expect(result).toMatchObject({ phase: 'ready', baseUrl: b.origin })
  await expect(account().locator('.account-service__address')).toHaveText(b.origin)
  await expect(draft).toHaveCount(0)
  // Both services are signed out, so only the address distinguishes this valid-looking stale submission.
  expect((await readAccount()).status).toBe('signed-out')
  const rejected = await page.evaluate(async ({ source, name, password, code }) => {
    const api = window.aether.account
    const operations = [() => api.childPasswordLogin(source, name, password), () => api.childPasswordRecover(source, name, code, password)]
    const result: boolean[] = []
    for (const operation of operations) {
      try { await operation(); result.push(false) } catch (error) { result.push(/服务或账号已切换/.test(String(error))) }
    }
    return result
  }, { source, name, password, code: 'aether_child_reset_' + randomBytes(32).toString('base64url') })
  expect(rejected).toEqual([true, true]); expect(b.requests.some(r => r.path.startsWith('/auth/account/child-password'))).toBe(false)
  await noEcho([password])
})
