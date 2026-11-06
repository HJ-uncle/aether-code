/** Real Code and Work hosts: five-file reuse, stable Office child documents,
 * hidden-file refresh, close cleanup and fixed-scale PDF resize. No engine calls. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'

const root = resolve(__dirname, '..')
const source = process.env.AETHER_OFFICE_FIXTURE_ROOT
const names = ['02_Word_大型_图文报告.docx', '04_Excel_大型_12000行数据.xlsx', '06_PPT_中型_图文演示.pptx', '07_PPT_大型_高清图册.pptx', '09_PDF_大型_图文手册.pdf']
let app: ElectronApplication, page: Page, fixture = '', workspace = ''
const errors: string[] = []
const active = () => page.locator('.document-preview:visible').last()

async function ready(): Promise<void> {
  await expect(active()).toBeVisible()
  await expect.poll(() => active().evaluate(element => {
    if (element.querySelector('[role="alert"]')) return element.textContent
    const kind = element.getAttribute('data-document-preview')
    if (kind === 'xlsx') return [...element.querySelectorAll('td')].some(cell => cell.textContent?.trim())
    if (kind === 'pdf') return [...element.querySelectorAll<HTMLCanvasElement>('canvas')].some(canvas => Number(canvas.dataset.renderedPage) > 0)
    const child = element.querySelector('iframe')?.contentDocument
    return Boolean(child?.querySelector('section.docx, .slide-container') && [...child.images].every(image => image.complete && image.naturalWidth > 0))
  }), { timeout: 60000 }).toBe(true)
}

async function openCode(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const picker = page.locator('.palette[aria-label="快速打开文件"]')
  await picker.locator('.palette__input').fill(name)
  await picker.locator('.palette__item').filter({ hasText: name }).first().click()
  await ready()
}

test.describe.serial('办公预览保留与实际文件更新', () => {
  test.beforeAll(async () => {
    test.skip(!source, '需要 AETHER_OFFICE_FIXTURE_ROOT 真实办公夹具')
    mkdirSync(join(root, '.e2e-tmp'), { recursive: true })
    fixture = mkdtempSync(join(root, '.e2e-tmp', 'office-warm-reuse-'))
    workspace = join(fixture, 'workspace'); mkdirSync(workspace)
    const profile = join(fixture, 'profile'); mkdirSync(profile)
    for (const name of names) copyFileSync(join(source!, name), join(workspace, name))
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, appearance: 'light' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 950))
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== join(root, '.e2e-tmp') || !basename(absolute).startsWith('office-warm-reuse-')) throw new Error('Unsafe Office fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  })

  test('Code 五个文档巡回保留真实 iframe 文档、滚动位置与缩放', async () => {
    test.setTimeout(180000)
    for (const name of names) {
      await openCode(name)
      const frame = active().locator('iframe').first()
      if (await frame.count()) await frame.evaluate((element, marker) => { element.contentDocument!.documentElement.dataset.warmIdentity = marker }, name)
    }
    for (const name of names) {
      await page.locator('.editor-tab').filter({ hasText: name }).first().click(); await ready()
      const frame = active().locator('iframe').first()
      if (await frame.count()) expect(await frame.evaluate(element => element.contentDocument!.documentElement.dataset.warmIdentity)).toBe(name)
    }
    await page.locator('.editor-tab').filter({ hasText: names[3] }).first().click(); await ready()
    const frame = active().locator('iframe').first()
    await active().getByRole('button', { name: '缩放', exact: true }).click()
    await page.getByRole('menuitem', { name: '75%', exact: true }).click()
    await expect.poll(() => frame.evaluate(element => getComputedStyle(element.contentDocument!.querySelector('main')!).zoom)).toBe('0.75')
    expect(await frame.evaluate(element => element.contentDocument!.documentElement.dataset.warmIdentity)).toBe(names[3])
    const body = active().locator('.document-preview__body--continuous')
    await body.evaluate(element => { element.scrollTop = 150 })
    const position = await body.evaluate(element => element.scrollTop)
    await page.locator('.editor-tab').filter({ hasText: names[0] }).first().click(); await ready()
    await page.locator('.editor-tab').filter({ hasText: names[3] }).first().click(); await ready()
    expect(await body.evaluate(element => element.scrollTop)).toBe(position)
    await expect(active().getByRole('button', { name: '缩放', exact: true })).toContainText('75%')
    expect(await page.locator('.document-preview').count()).toBeLessThanOrEqual(6)
  })

  test('Code 隐藏期间磁盘更新会载入新内容；关闭释放对应预览', async () => {
    await page.locator('.editor-tab').filter({ hasText: names[1] }).first().click(); await ready()
    const file = join(workspace, names[0]), zip = await JSZip.loadAsync(readFileSync(file))
    const xml = await zip.file('word/document.xml')!.async('string')
    zip.file('word/document.xml', xml.replace(/<w:body>/, '<w:body><w:p><w:r><w:t>AETHER_UPDATED_HIDDEN_DOCUMENT</w:t></w:r></w:p>'))
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
    await page.locator('.editor-tab').filter({ hasText: names[0] }).first().click(); await ready()
    await expect.poll(() => active().locator('iframe').first().evaluate(element => element.contentDocument?.body.textContent?.includes('AETHER_UPDATED_HIDDEN_DOCUMENT')), { timeout: 15000 }).toBe(true)
    await page.locator('.editor-tab').filter({ hasText: names[0] }).first().getByRole('button').last().click()
    await expect(page.locator(`.document-preview[aria-label="${names[0]}文档预览"]`)).toHaveCount(0)
  })

  test('PDF 固定比例拖动宽度保留已绘制画布，滚到底可见最后页', async () => {
    await openCode(names[4])
    await active().getByRole('button', { name: '缩放', exact: true }).click()
    await page.getByRole('menuitem', { name: '100%', exact: true }).click()
    const canvas = active().locator('canvas').first()
    await expect(canvas).toHaveAttribute('data-rendered-page', '1')
    const expectedWidth = (await PDFDocument.load(readFileSync(join(workspace, names[4])))).getPage(0).getWidth()
    await expect.poll(() => canvas.evaluate(element => parseFloat(element.style.width))).toBeCloseTo(expectedWidth, 1)
    const original = await canvas.evaluate(element => ({ width: element.width, height: element.height }))
    // Count width/height mutations: clearing a canvas for repaint is observable,
    // unlike comparing only the persistent DOM canvas node.
    await canvas.evaluate(element => {
      element.dataset.resizeMutations = '0'
      new MutationObserver(records => { element.dataset.resizeMutations = String(Number(element.dataset.resizeMutations) + records.length) })
        .observe(element, { attributes: true, attributeFilter: ['width', 'height'] })
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1260, 850))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(1300)
    await page.waitForTimeout(250)
    expect(await canvas.evaluate(element => ({ width: element.width, height: element.height }))).toEqual(original)
    await expect(canvas).toHaveAttribute('data-resize-mutations', '0')
    await active().locator('.document-preview__body--pdf').evaluate(element => { element.scrollTop = element.scrollHeight })
    const count = Number(await active().locator('[data-document-pages]').getAttribute('data-document-pages'))
    await expect(active().locator('canvas').last()).toHaveAttribute('data-rendered-page', String(count), { timeout: 30000 })
  })

  test('Work 五文件切换和 Code/Work 切换保留预览；关闭文件清理', async ({}, testInfo) => {
    test.setTimeout(180000)
    await page.evaluate(workspace => {
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: 'work-office-test', title: '办公预览验证', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }], activeTaskId: 'work-office-test', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, workspace)
    await page.reload(); await expect(page.locator('.work-view')).toBeVisible()
    const input = page.locator('input.work-resource-tabs__file-input')
    for (const name of names) {
      await input.setInputFiles(join(workspace, name)); await ready()
      const frame = active().locator('iframe').first()
      if (await frame.count()) await frame.evaluate((element, marker) => { element.contentDocument!.documentElement.dataset.workIdentity = marker }, name)
    }
    for (const name of names) {
      await page.locator('.work-view').getByRole('tab').filter({ hasText: name }).last().click(); await ready()
      const frame = active().locator('iframe').first()
      if (await frame.count()) expect(await frame.evaluate(element => element.contentDocument!.documentElement.dataset.workIdentity)).toBe(name)
    }
    await page.getByRole('tab').filter({ hasText: names[3] }).last().click(); await ready()
    const frame = active().locator('iframe').first()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await expect(page.locator('.work-view')).not.toBeVisible()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click(); await ready()
    await expect(page.locator('#mode-code')).toBeHidden()
    expect(await frame.evaluate(element => element.contentDocument!.documentElement.dataset.workIdentity)).toBe(names[3])
    expect(await page.locator('.work-view .document-preview').count()).toBeLessThanOrEqual(6)
    await page.screenshot({ path: testInfo.outputPath('work-office-reuse.png'), animations: 'disabled' })
    await page.getByRole('button', { name: `关闭文档 ${names[3]}`, exact: true }).click()
    await expect(page.locator(`.work-view .document-preview[aria-label="${names[3]}文档预览"]`)).toHaveCount(0)
    await testInfo.attach('isolated-fixture', { body: fixture, contentType: 'text/plain' })
  })
})
