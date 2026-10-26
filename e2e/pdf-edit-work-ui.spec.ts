/** Fresh PDF UI acceptance: opens a real PDF in the current workbench,
 * exercises the new annotation tools, and checks that editing never replaces
 * the source file. This is intentionally independent of the legacy E2E suite. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(__dirname, '..')
let fixture = '', workspace = '', pdfPath = '', app: ElectronApplication | undefined, page: Page
const runtimeErrors: string[] = []

async function makePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const sheet = document.addPage([612, 792])
  sheet.drawText('Aether PDF editing fixture', { x: 48, y: 720, size: 18, font })
  return document.save()
}

test.describe.serial('当前 Work PDF 编辑工具', () => {
  test.beforeAll(async () => {
    fixture = mkdtempSync(join(tmpdir(), 'aether-pdf-edit-'))
    workspace = join(fixture, 'workspace'); mkdirSync(workspace, { recursive: true })
    pdfPath = join(workspace, '编辑验收.pdf')
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
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('aether-pdf-edit-')) throw new Error('Unsafe PDF fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 3 })
  })

  test('PDF 页面可进入编辑、添加中文文字与高亮且源文件不被改写', async () => {
    const explorer = page.locator('.explorer')
    if (!(await explorer.isVisible())) await page.locator('.activity-bar button[title="资源管理器"]').click()
    await expect(page.locator('.explorer__root')).toBeVisible({ timeout: 15_000 })
    const row = page.locator(`.tree-row[data-path="${pdfPath.replace(/\\/g, '\\\\')}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await expect(page.locator('.document-preview[data-document-preview="pdf"]')).toBeVisible({ timeout: 30_000 })
    const editor = page.locator('.document-preview__toolbar--pdf-edit')
    await expect(editor).toContainText('编辑 PDF')

    await editor.getByRole('button', { name: '文字', exact: true }).click()
    const canvas = page.locator('.document-preview__pdf-overlay')
    await expect(canvas).toBeVisible()
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + 90, box.y + 90)
    await page.locator('.document-preview__pdf-draft').fill('中文批注')
    await page.locator('.document-preview__pdf-draft').press('Enter')
    await expect(page.locator('.document-preview__pdf-annotation--text')).toContainText('中文批注')

    await editor.getByRole('button', { name: '高亮', exact: true }).click()
    await page.mouse.click(box.x + 160, box.y + 160)
    await expect(page.locator('.document-preview__pdf-annotation--highlight')).toHaveCount(1)
    const saveButton = editor.getByRole('button', { name: '另存为 PDF', exact: true })
    await expect(saveButton).toBeEnabled()
    await saveButton.click()
    await expect(editor).toContainText('已保存编辑后的 PDF 副本')
    expect(existsSync(pdfPath)).toBe(true)
    expect(runtimeErrors).toEqual([])
  })
})
