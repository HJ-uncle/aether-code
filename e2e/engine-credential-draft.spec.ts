/** A real renderer and two loopback engines; keep sensitive drafts out of trace/DOM snapshots and screenshots. */
import { expect, test as base, type Locator } from '@playwright/test'
import { createHash } from 'node:crypto'
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
  current,
  open,
  advanced,
  launch,
  stillA,
  registerConnectionHarness
} from './fixtures/engine-connection-harness'

// A failure during deliberate manual reveal can expose the text field in Playwright's automatic page snapshot.
// Limit the setting to this private worker and restore it before other worker fixtures may run.
const test = base.extend<object, { privateReports: void }>({
  privateReports: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument; this worker owns no browser.
    async ({}, runTests) => {
      const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT
      process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'
      try {
        await runTests()
      } finally {
        if (previous === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previous
      }
    },
    { scope: 'worker', auto: true }
  ]
})
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
registerConnectionHarness({ captureOnFailure: false })

test.describe('自建服务凭据', { tag: '@credential-draft' }, () => {
  const token = (): Locator => draft().getByLabel('实例令牌', { exact: true })
  const auth = (): Locator => draft().getByLabel('远端用户认证凭据', { exact: true })
  const generateToken = (): Locator => draft().getByRole('button', { name: /生成.*实例令牌/ })
  const generateKey = (): Locator => draft().getByRole('button', { name: /生成.*API Key/i })
  const copyToken = (): Locator => draft().getByRole('button', { name: /复制.*实例令牌/ })
  const copyKey = (): Locator =>
    draft().getByRole('button', { name: /复制.*(?:API Key|用户凭据)/i })
  const setup = async (): Promise<void> => {
    await launch()
    await page.evaluate(observeCredentialDrafts)
    await open()
    await address().fill(b.origin)
    await advanced()
  }
  const showSource = async (kind: string): Promise<void> => {
    await draft().getByRole('button', { name: '远端认证方式', exact: true }).click()
    await page.getByRole('menuitem', { name: kind, exact: true }).click()
  }
  const empty = (input: Locator): Promise<boolean> =>
    input.evaluate((element) => !(element as HTMLInputElement).value)
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

  test('生成与复制只改本地草稿，切换 JWT、地址或离开页面不会带走凭据', async () => {
    await setup()
    await expect(draft()).toContainText(/管理员|部署方/)
    await expect(copyToken()).toHaveCount(0)
    await expect(copyKey()).toHaveCount(0)
    await expect(draft()).toContainText(/登记/)
    const before = b.requests.length
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
    await generateKey().click()
    const key = await readDraftEvidence(auth())
    await expect(auth()).toHaveAccessibleDescription(/管理员.*登记/)
    expect(key).toMatchObject({ fresh: true, masked: true, exposed: false, copies: 1 })
    expect(key.digest).not.toBe(second.digest)
    await copyKey().click()
    expect(await readDraftEvidence(auth())).toMatchObject({
      lastCopyMatches: true,
      copies: 2,
      masked: true
    })
    // Simulate a denied OS copy; manual reveal is deliberate, selected and reversible with Esc.
    await page.evaluate(refuseClipboardWrites)
    await copyKey().click()
    await expect(auth()).toHaveAccessibleDescription(/剪贴板不可用/)
    expect(await readDraftEvidence(auth())).toMatchObject({ masked: true, copies: 2 })
    await draft().getByRole('button', { name: '显示并选中 API Key', exact: true }).click()
    await expect
      .poll(() => readDraftEvidence(auth()))
      .toMatchObject({ masked: false, allSelected: true, exposed: false, copies: 2 })
    await auth().press('Escape')
    await expect(auth()).toHaveAttribute('type', 'password')
    await showSource('JWT（Bearer）')
    await expect(generateKey()).toHaveCount(0)
    expect(await empty(auth())).toBe(true)
    await expect(draft()).toContainText(/签发/)
    expect((await readDraftEvidence(token())).digest).toBe(second.digest)
    await auth().fill('fixture-issued-bearer')
    await showSource('API Key')
    expect(await empty(auth())).toBe(true)
    await generateKey().click()
    await address().fill(a.origin)
    expect(await empty(token())).toBe(true)
    expect(await empty(auth())).toBe(true)
    await address().fill(b.origin)
    expect(await empty(token())).toBe(true)
    expect(await empty(auth())).toBe(true)
    await generateKey().click()
    await settings().getByRole('tab', { name: '外观', exact: true }).click()
    await settings().getByRole('tab', { name: '引擎管理', exact: true }).click()
    await advanced()
    expect(await empty(auth())).toBe(true)
    expect(b.requests.length).toBe(before)
    expect(await scopes()).toEqual([
      ['environment', 'environment'],
      ['none', 'none']
    ])
    await stillA()
    // Cancellation keeps only this address's uncommitted drafts for a manual retry.
    await generateToken().click()
    const pendingToken = (await readDraftEvidence(token())).digest
    await generateKey().click()
    const pendingKey = (await readDraftEvidence(auth())).digest
    b.behavior = 'hold'
    await action().click()
    await expect.poll(() => b.activeProbes()).toBe(1)
    await expect(action()).toHaveText('取消连接')
    await action().click()
    await expect.poll(() => b.activeProbes()).toBe(0)
    await expect
      .poll(() => readDraftEvidence(token()))
      .toMatchObject({ digest: pendingToken, masked: true })
    expect(await readDraftEvidence(auth())).toMatchObject({ digest: pendingKey, masked: true })
    expect(await scopes()).toEqual([
      ['environment', 'environment'],
      ['none', 'none']
    ])
    await stillA()
  })

  test('只有应用才向 B 验证随机凭据，拒绝不落盘，成功只保存到 B', async () => {
    const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
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
    const before = b.requests.length
    await generateToken().click()
    const tokenHash = (await readDraftEvidence(token())).digest
    await generateKey().click()
    const keyHash = (await readDraftEvidence(auth())).digest
    expect(b.requests.length).toBe(before)
    expect(await scopes()).toEqual([
      ['environment', 'environment'],
      ['none', 'none']
    ])
    b.behavior = 'login'
    await action().click()
    await expect(draft().getByRole('alert')).toBeVisible()
    expect(
      b.requests.some(
        (r) =>
          r.path === '/api/v1/tools' &&
          hash(r.token) === tokenHash &&
          hash(r.apiKey) === keyHash &&
          !r.bearer
      )
    ).toBe(true)
    expect((await readDraftEvidence(auth())).exposed).toBe(false)
    await stillA()
    expect(await scopes()).toEqual([
      ['environment', 'environment'],
      ['none', 'none']
    ])
    b.behavior = 'ready'
    b.expectedCredentialDigests = { instanceToken: tokenHash, apiKey: keyHash }
    await action().click()
    await expect(current()).toContainText(b.origin)
    expect(await scopes()).toEqual([
      ['environment', 'environment'],
      ['stored', 'stored']
    ])
    expect(await empty(token())).toBe(true)
    expect(await empty(auth())).toBe(true)
    const publicDiscovery = b.requests.filter((r) => ['/health', '/meta'].includes(r.path))
    expect(new Set(publicDiscovery.map((r) => r.path))).toEqual(new Set(['/health', '/meta']))
    expect(publicDiscovery.every((r) => !r.token && !r.apiKey && !r.bearer)).toBe(true)
    expect(aHeaders.size).toBeGreaterThan(0)
    expect(b.requests.some((r) => r.path === '/auth/user')).toBe(false)
    expect([tokenHash, keyHash].some((value) => aHeaders.has(value))).toBe(false)
  })
})
