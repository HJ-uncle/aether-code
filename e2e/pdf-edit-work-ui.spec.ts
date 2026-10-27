/** Real PDF preview acceptance: continuous scrolling without annotation or editing surfaces. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(__dirname, '..')
let fixture = '', workspace = '', pdfPath = '', app: ElectronApplication | undefined, page: Page
const runtimeErrors: string[] = []

async function makePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < 3; index++) {
    const sheet = document.addPage([612, 792])
    sheet.drawText(`Aether PDF preview page ${index + 1}`, { x: 48, y: 720, size: 18, font })
  }
  return document.save()
}

test.describe.serial('PDF 连续滚动只读预览', () => {
  test.beforeAll(async () => {
    fixture = mkdtempSync(join(tmpdir(), 'aether-pdf-preview-'))
    workspace = join(fixture, 'workspace'); mkdirSync(workspace, { recursive: true })
    pdfPath = join(workspace, '预览验收.pdf')
    writeFileSync(pdfPath, await makePdf())
    const profile = join(fixture, 'profile'); mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({
      engineMode: 'embedded', preferredPort: 12467, autoStartEngine: false,
      lastSessionId: '', lastAgentId: '', lastModelId: '', lastFolder: workspace
    }), 'utf8')
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root,
      env: { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') } })
    page = await app.firstWindow()
    page.on('pageerror', error => runtimeErrors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(message.text()) })
    await expect(page.locator('.workbench')).toBeVisible({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    const absolute = resolve(fixture)
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('aether-pdf-preview-')) throw new Error('Unsafe PDF fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 3 })
  })

  test('保留连续滚动与缩放，不再提供批注、编辑和另存为', async () => {
    const explorer = page.locator('.explorer')
    if (!(await explorer.isVisible())) await page.locator('.activity-bar button[title="资源管理器"]').click()
    const row = page.locator(`.tree-row[data-path="${pdfPath.replace(/\\/g, '\\\\')}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await expect(page.locator('.document-preview[data-document-preview="pdf"]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.document-preview__pdf-shell canvas').first()).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 })
    await expect(page.getByRole('group', { name: 'PDF 编辑工具' })).toHaveCount(0)
    await expect(page.locator('.document-preview__pdf-overlay, .document-preview__pdf-annotation, .document-preview__pdf-draft')).toHaveCount(0)
    const body = page.locator('.document-preview__body--pdf')
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await body.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(page.locator('.document-preview__pdf-shell canvas').last()).toHaveAttribute('data-rendered-page', '3', { timeout: 30_000 })
    expect(runtimeErrors).toEqual([])
  })
})
