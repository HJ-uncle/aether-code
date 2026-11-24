/** A real renderer and two loopback engines; keep sensitive drafts out of trace/DOM snapshots and screenshots. */
import { expect, type Locator } from '@playwright/test'
import { credentialTest as test } from './fixtures/private-credential-test'
import { createHash } from 'node:crypto'
import { fixtureRecoveryKey } from './fixtures/engine-candidate'
import {
  observeCredentialDrafts,
  readDraftEvidence,
  refuseClipboardWrites
} from './fixtures/credential-draft-probe'
import {
  a,
  b,
  page,
  settings,
  draft,
  address,
  action,
  accountAdvanced,
  accountCredentials,
  live,
  open,
  advanced,
  launch,
  stillA,
  registerConnectionHarness
} from './fixtures/engine-connection-harness'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
registerConnectionHarness({ captureOnFailure: false })

test.describe('自建服务凭据', { tag: '@credential-draft' }, () => {
  const token = (): Locator => draft().getByLabel('实例令牌', { exact: true })
  const auth = (): Locator => accountCredentials().getByLabel('远端用户认证凭据', { exact: true })
  const generateToken = (): Locator =>
    draft().getByRole('button', { name: '生成随机实例令牌', exact: true })
  const copyToken = (): Locator =>
    draft().getByRole('button', { name: '复制实例令牌', exact: true })
  const generateKey = (): Locator =>
    accountCredentials().getByRole('button', { name: '生成随机 API Key', exact: true })
  const copyKey = (): Locator =>
    accountCredentials().getByRole('button', { name: '复制 API Key', exact: true })
  const applyCredential = (): Locator =>
    accountCredentials().getByRole('button', { name: '应用凭据', exact: true })
  const setup = async (): Promise<void> => {
    await launch()
    await page.evaluate(observeCredentialDrafts)
    await open()
    await address().fill(b.origin)
    await advanced()
  }
  const useAccount = async (): Promise<void> => {
    await expect(action()).toHaveText('前往登录')
    await action().click()
    await expect(settings().locator('.account-service__address')).toHaveText(b.origin)
    await accountAdvanced()
  }
  const showSource = async (kind: string): Promise<void> => {
    await accountCredentials().getByRole('button', { name: '远端认证方式', exact: true }).click()
    await page.getByRole('menuitem', { name: kind, exact: true }).click()
  }
  const empty = (input: Locator): Promise<boolean> =>
    input.evaluate((el) => !(el as HTMLInputElement).value)
  const scopes = (): Promise<string[][]> =>
    page.evaluate(
      async ([one, two]) => {
        const lookup = async (url: string): Promise<string[]> => [
          (await window.aether.settings.remoteTokenStatus(url)).source,
          (await window.aether.settings.remoteAuthStatus(url)).source
        ]
        return Promise.all([lookup(one), lookup(two)])
      },
      [a.origin, b.origin]
    )
  const untouched = [
    ['environment', 'environment'],
    ['none', 'none']
  ]
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  const identityTraffic = (): number =>
    b.requests.filter((r) => r.path === '/api/v1/tools' || !['GET', 'HEAD'].includes(r.method))
      .length

  test('引擎页只有实例令牌；随机生成、复制、切换地址和取消连接均不保存', async () => {
    await setup()
    await expect(draft().getByLabel('远端用户认证凭据', { exact: true })).toHaveCount(0)
    await expect(copyToken()).toHaveCount(0)
    await generateToken().click()
    const first = await readDraftEvidence(token())
    await expect(token()).toHaveAccessibleDescription(/AETHER_INSTANCE_TOKEN.*重启/)
    expect(first).toMatchObject({ fresh: true, masked: true, exposed: false, copies: 0 })
    await generateToken().click()
    const second = await readDraftEvidence(token())
    expect(second).toMatchObject({ fresh: true, exposed: false, copies: 0 })
    expect(second.digest).not.toBe(first.digest)
    await copyToken().click()
    expect(await readDraftEvidence(token())).toMatchObject({
      lastCopyMatches: true,
      copies: 1,
      masked: true
    })
    await address().fill(a.origin)
    expect(await empty(token())).toBe(true)
    await address().fill(b.origin)
    expect(await empty(token())).toBe(true)
    await generateToken().click()
    await settings().getByRole('tab', { name: '外观', exact: true }).click()
    await settings().getByRole('tab', { name: '引擎管理', exact: true }).click()
    await advanced()
    expect(await empty(token())).toBe(true)
    expect(b.requests).toHaveLength(0)
    await generateToken().click()
    const pending = (await readDraftEvidence(token())).digest
    b.behavior = 'hold'
    await action().click()
    await expect.poll(() => b.activeProbes()).toBe(1)
    await expect(action()).toHaveText('取消连接')
    await action().click()
    await expect.poll(() => b.activeProbes()).toBe(0)
    await expect
      .poll(() => readDraftEvidence(token()))
      .toMatchObject({ digest: pending, masked: true })
    expect(await scopes()).toEqual(untouched)
    await stillA()
  })

  test('个人账号中的随机 API Key 仅是草稿；复制失败可手动复制，切换认证方式或离开会丢弃', async () => {
    await setup()
    b.behavior = 'login'
    await action().click()
    await useAccount()
    await expect(accountCredentials()).toContainText(/管理员登记/)
    await expect(copyKey()).toHaveCount(0)
    const before = identityTraffic()
    await generateKey().click()
    const first = await readDraftEvidence(auth())
    await expect(auth()).toHaveAccessibleDescription(/管理员.*登记/)
    expect(first).toMatchObject({ fresh: true, masked: true, exposed: false, copies: 0 })
    await generateKey().click()
    const second = await readDraftEvidence(auth())
    expect(second.digest).not.toBe(first.digest)
    expect(second.fresh).toBe(true)
    await copyKey().click()
    expect(await readDraftEvidence(auth())).toMatchObject({
      lastCopyMatches: true,
      copies: 1,
      masked: true
    })
    await page.evaluate(refuseClipboardWrites)
    await copyKey().click()
    await expect(auth()).toHaveAccessibleDescription(/剪贴板不可用/)
    expect(await readDraftEvidence(auth())).toMatchObject({ masked: true, copies: 1 })
    await accountCredentials()
      .getByRole('button', { name: '显示并选中 API Key', exact: true })
      .click()
    await expect
      .poll(() => readDraftEvidence(auth()))
      .toMatchObject({ masked: false, allSelected: true, exposed: false, copies: 1 })
    await auth().press('Escape')
    await expect(auth()).toHaveAttribute('type', 'password')
    await showSource('JWT（Bearer）')
    await expect(generateKey()).toHaveCount(0)
    expect(await empty(auth())).toBe(true)
    await expect(accountCredentials()).toContainText(/签发/)
    await auth().fill('fixture-issued-bearer')
    await showSource('API Key')
    expect(await empty(auth())).toBe(true)
    await generateKey().click()
    await accountCredentials().locator('summary').click()
    await accountAdvanced()
    expect(await empty(auth())).toBe(true)
    await generateKey().click()
    await settings().getByRole('tab', { name: '外观', exact: true }).click()
    await settings().getByRole('tab', { name: '个人账号', exact: true }).click()
    await accountAdvanced()
    expect(await empty(auth())).toBe(true)
    await expect(applyCredential()).toBeDisabled()
    expect(identityTraffic()).toBe(before)
    expect(await scopes()).toEqual(untouched)
  })

  test('实例令牌和用户凭据分别验证：错误不保存，成功只绑定到 B，已撤销的凭据可替换或移除', async () => {
    const aHeaders = new Set<string>()
    a.observeRequestHeaders = (headers) => {
      for (const value of [
        headers['x-api-key'],
        headers['x-aether-instance-token'],
        headers.authorization?.replace(/^Bearer /, '')
      ])
        if (typeof value === 'string') aHeaders.add(hash(value))
    }
    await setup()
    await generateToken().click()
    const tokenHash = (await readDraftEvidence(token())).digest
    b.behavior = 'token'
    await action().click()
    await expect(draft().getByRole('alert')).toContainText('令牌')
    expect(await scopes()).toEqual(untouched)
    await stillA()
    b.behavior = 'ready'
    b.expectedCredentialDigests = { instanceToken: tokenHash, apiKey: hash('unregistered-fixture') }
    await action().click()
    await useAccount()
    expect(await scopes()).toEqual([untouched[0], ['stored', 'none']])
    const before = identityTraffic()
    await generateKey().click()
    const keyHash = (await readDraftEvidence(auth())).digest
    expect(identityTraffic()).toBe(before)
    await applyCredential().click()
    await expect(accountCredentials().getByRole('alert')).toContainText(/拒绝.*凭据/)
    expect(
      b.requests.some(
        (r) =>
          r.path === '/api/v1/tools' &&
          hash(r.token) === tokenHash &&
          hash(r.apiKey) === keyHash &&
          !r.bearer
      )
    ).toBe(true)
    expect(await readDraftEvidence(auth())).toMatchObject({
      digest: keyHash,
      masked: true,
      exposed: false
    })
    expect(await scopes()).toEqual([untouched[0], ['stored', 'none']])
    b.expectedCredentialDigests.apiKey = keyHash
    await applyCredential().click()
    await expect.poll(live).toMatchObject({ phase: 'ready', baseUrl: b.origin })
    const apiIdentity = (await live()).accountId
    expect(apiIdentity).toMatch(/^advanced-/)
    await expect.poll(scopes).toEqual([untouched[0], ['stored', 'stored']])
    await expect.poll(() => empty(auth())).toBe(true)
    // If the registered key expires, a saved B must remain selectable so its account page can repair it.
    await settings().getByRole('tab', { name: '引擎管理', exact: true }).click()
    await address().fill(a.origin)
    await action().click()
    await stillA()
    b.expectedCredentialDigests.apiKey = hash('revoked-fixture-replacement')
    await address().fill(b.origin)
    await action().click()
    await useAccount()
    await expect(auth()).toHaveAttribute('placeholder', /已保存 API Key/)
    expect(await empty(auth())).toBe(true)
    const jwt = 'fixture-issued-b-jwt'
    await showSource('JWT（Bearer）')
    await auth().fill(jwt)
    b.expectedCredentialDigests = { instanceToken: tokenHash, bearer: hash(jwt) }
    await applyCredential().click()
    await expect
      .poll(() => page.evaluate((url) => window.aether.settings.remoteAuthStatus(url), b.origin))
      .toMatchObject({ source: 'stored', type: 'bearer', effective: 'advanced' })
    await expect.poll(async () => (await live()).accountId).not.toBe(apiIdentity)
    expect(
      b.requests.some(
        (r) => r.path === '/api/v1/tools' && r.bearer === `Bearer ${jwt}` && !r.apiKey
      )
    ).toBe(true)
    await accountCredentials().getByRole('button', { name: '清除凭据', exact: true }).click()
    await applyCredential().click()
    await expect.poll(scopes).toEqual([untouched[0], ['stored', 'none']])
    await expect
      .poll(live)
      .toMatchObject({ phase: 'error', connectionIssue: 'authentication-required' })
    const publicRequests = b.requests.filter((r) => ['/health', '/meta'].includes(r.path))
    expect(new Set(publicRequests.map((r) => r.path))).toEqual(new Set(['/health', '/meta']))
    expect(publicRequests.every((r) => !r.token && !r.apiKey && !r.bearer)).toBe(true)
    expect(b.requests.some((r) => r.path === '/auth/user')).toBe(false)
    expect(aHeaders.size).toBeGreaterThan(0)
    expect([tokenHash, keyHash, hash(jwt)].every((value) => !aHeaders.has(value))).toBe(true)
  })

  test('曾选的地址、旧的编辑版本和已开始登录的个人账号都不接受迟到的凭据修改', async () => {
    await setup()
    const revisionOf = (url: string): Promise<number> =>
      page.evaluate(
        async (target) =>
          (await window.aether.account.getServiceCredentialContext(target)).revision,
        url
      )
    const apply = (url: string, revision: number, value: string | null): Promise<string> =>
      page.evaluate(
        async (input) => {
          try {
            await window.aether.account.applyServiceCredential(
              input.url,
              input.revision,
              input.value ? { type: 'api-key', value: input.value } : null
            )
            return 'saved'
          } catch (error) {
            return error instanceof Error ? error.message : 'unknown'
          }
        },
        { url, revision, value }
      )
    const beforeA = await revisionOf(a.origin)
    await action().click()
    await expect.poll(live).toMatchObject({ phase: 'ready', baseUrl: b.origin })
    expect(await apply(a.origin, beforeA, null)).toMatch(/连接已切换/)
    const beforeB = await revisionOf(b.origin),
      kept = 'registered-fixture-b-key'
    b.expectedCredentialDigests = { apiKey: hash(kept) }
    expect(await apply(b.origin, beforeB, kept)).toBe('saved')
    const currentB = await revisionOf(b.origin)
    expect(currentB).toBeGreaterThan(beforeB)
    const count = identityTraffic()
    expect(await apply(b.origin, beforeB, null)).toMatch(/已变化/)
    expect(identityTraffic()).toBe(count)
    expect(await scopes()).toEqual([untouched[0], ['none', 'stored']])
    expect((await live()).accountId).toMatch(/^advanced-/)
    b.expectedCredentialDigests = undefined
    b.behavior = 'hold'
    const pending = apply(b.origin, currentB, 'late-fixture-key'),
      goodLogin = 'fixture-account-b'
    await expect.poll(() => b.activeProbes()).toBe(1)
    const login = page.evaluate(
      async (key) => (await window.aether.account.login(key)).user?.id,
      fixtureRecoveryKey
    )
    await expect.poll(() => b.requests.some((r) => r.path === '/auth/account/login')).toBe(true)
    expect(await pending).toMatch(/取消|变化|个人账号/)
    b.release()
    expect(await login).toBe(goodLogin)
    await expect
      .poll(live)
      .toMatchObject({ baseUrl: b.origin, accountId: goodLogin, phase: 'ready' })
    expect(
      await page.evaluate((url) => window.aether.settings.remoteAuthStatus(url), b.origin)
    ).toMatchObject({ source: 'stored', type: 'api-key', effective: 'account' })
    expect(b.requests.some((r) => r.apiKey === 'late-fixture-key')).toBe(false)
  })
})
