/** Real pointer selection in scriptless DOCX/PPTX frames and PDF TextLayer,
 * exact quote delivery to Work composer, hidden-preview and zoom cleanup.
 * Uses isolated generated files, no model calls and no JS-created Range. */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import pptxgen from 'pptxgenjs'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const root = resolve(__dirname, '..'), parent = join(root, '.e2e-tmp')
let app: ElectronApplication | undefined, page: Page, fixture = '', workspace = ''
const errors: string[] = []
const names = { docx: '选区验收.docx', pptx: '选区验收.pptx', pdf: '选区验收.pdf', scan: '扫描页.pdf' }
const panel = () => page.locator('.work-artifact-panel-v2[data-document-active="true"]:visible').last()
const composer = () => page.getByRole('textbox', { name: '继续对话', exact: true })

async function makeFiles(): Promise<void> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="40"/></w:rPr><w:t>AlphaSelected</w:t></w:r></w:p><w:p><w:r><w:t>DoNotQuoteWord</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>')
  writeFileSync(join(workspace, names.docx), await zip.generateAsync({ type: 'nodebuffer' }))
  const presentation = new pptxgen()
  presentation.layout = 'LAYOUT_WIDE'
  const slide = presentation.addSlide()
  slide.addText('BetaSelected', { x: 1, y: 1, w: 5, h: 0.6, fontSize: 28 })
  slide.addText('DoNotQuoteSlide', { x: 1, y: 2, w: 5, h: 0.6, fontSize: 28 })
  await presentation.writeFile({ fileName: join(workspace, names.pptx) })
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < 8; index++) {
    const sheet = pdf.addPage([612, 792])
    sheet.drawText(index ? `Page${index + 1}Selected` : 'GammaSelected', { x: 48, y: 720, size: 24, font })
    sheet.drawText('DoNotQuotePDF', { x: 48, y: 670, size: 18, font })
  }
  writeFileSync(join(workspace, names.pdf), await pdf.save())
  const scan = await PDFDocument.create()
  const pixel = await scan.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'))
  scan.addPage([612, 792]).drawImage(pixel, { x: 30, y: 30, width: 500, height: 700 })
  writeFileSync(join(workspace, names.scan), await scan.save())
}

async function open(name: string): Promise<void> {
  const tab = page.locator('.work-view').getByRole('tab').filter({ hasText: name }).last()
  if (await tab.count()) await tab.click()
  else await page.locator('input.work-resource-tabs__file-input').setInputFiles(join(workspace, name))
  await expect(panel()).toHaveAttribute('data-file-read-status', 'current')
}

async function assertQuote(word: string, excluded: string): Promise<void> {
  const quote = panel().getByRole('button', { name: '引用选中内容', exact: true })
  await expect(quote).toBeVisible()
  await quote.click()
  await expect(composer()).toContainText(`> ${word}`)
  await expect(composer()).not.toContainText(excluded)
  await expect(page.locator('.work-attachments')).toHaveCount(0)
  await composer().fill('')
}

test.describe.serial('办公文档真实选区引用', () => {
  test.beforeAll(async () => {
    mkdirSync(parent, { recursive: true }); fixture = mkdtempSync(join(parent, 'office-selection-'))
    workspace = join(fixture, 'workspace'); mkdirSync(workspace)
    await makeFiles()
    const profile = join(fixture, 'profile'); mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace, appearance: 'light' }))
    const env = { ...process.env, AETHER_GLOBAL_DIR: join(fixture, 'global') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: root, env })
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.workbench')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 950))
    await page.evaluate(workspace => {
      localStorage.setItem('aether.app.mode', 'work')
      localStorage.setItem('aether.work.state.v1', JSON.stringify({ tasks: [{ id: 'work-selection-test', title: '选区验证', draft: '', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspace, modelId: '', attachments: [], sources: [] }], activeTaskId: 'work-selection-test', homeDraft: '', homeWorkspacePath: null, homeAttachments: [], homeModelId: '', homeSessionId: null, homeAgentId: '', homeMentions: [], homeResources: { skills: [], mcpServers: [], knowledgeBases: [] } }))
    }, workspace)
    await page.reload(); await expect(page.locator('.work-view')).toBeVisible()
    await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    await expect(page.locator('input.work-resource-tabs__file-input')).toBeAttached()
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    if (!fixture) return
    const absolute = resolve(fixture)
    if (dirname(absolute) !== parent || !basename(absolute).startsWith('office-selection-')) throw new Error('Unsafe selection fixture cleanup')
    rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  test('DOCX 与 PPTX 鼠标双击只引用选中文本，iframe 继续禁止脚本', async () => {
    for (const [name, word, excluded] of [[names.docx, 'AlphaSelected', 'DoNotQuoteWord'], [names.pptx, 'BetaSelected', 'DoNotQuoteSlide']]) {
      await open(name)
      const frame = panel().locator('iframe').first()
      await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin')
      expect(await frame.getAttribute('srcdoc')).toContain("script-src 'none'")
      const target = frame.contentFrame().getByText(word, { exact: true }).first()
      // PPT text boxes retain their authored width; the center can be blank
      // space to the right of the actual word. Hit its left-aligned glyphs.
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      await target.dblclick(name === names.pptx ? { position: { x: 8, y: box!.height / 2 } } : {})
      await expect.poll(() => target.evaluate(element => element.ownerDocument.getSelection()?.toString())).toBe(word)
      await test.info().attach(`selection-${word}`, { body: JSON.stringify(await target.evaluate(element => ({
        element: element.outerHTML, rect: element.getBoundingClientRect().toJSON(), selection: element.ownerDocument.getSelection()?.toString(),
      }))), contentType: 'application/json' })
      await assertQuote(word, excluded)
    }
  })

  test('换文件、隐藏 Work 和 Escape 清理旧选区，点击引用不丢选区', async () => {
    await open(names.docx)
    await panel().locator('iframe').first().contentFrame().getByText('AlphaSelected', { exact: true }).dblclick()
    await expect(panel().getByRole('button', { name: '引用选中内容', exact: true })).toBeVisible()
    await open(names.pptx)
    await expect(panel().getByRole('button', { name: '添加到对话', exact: true })).toBeVisible()
    await open(names.docx)
    await expect(panel().getByRole('button', { name: '添加到对话', exact: true })).toBeVisible()
    await panel().locator('iframe').first().contentFrame().getByText('AlphaSelected', { exact: true }).dblclick()
    await page.keyboard.press('Escape')
    await expect(panel().getByRole('button', { name: '添加到对话', exact: true })).toBeVisible()
    await panel().locator('iframe').first().contentFrame().getByText('AlphaSelected', { exact: true }).dblclick()
    await page.getByRole('tab', { name: 'Code 开发', exact: true }).click()
    await page.getByRole('tab', { name: 'Work 办公', exact: true }).click()
    await expect(panel().getByRole('button', { name: '添加到对话', exact: true })).toBeVisible()
  })

  test('PDF 缩放后真实鼠标选择进入输入框，出屏和隐藏页释放文字 DOM', async () => {
    await open(names.pdf)
    const pdf = panel().locator('[data-document-preview="pdf"]')
    const firstLayer = pdf.locator('.document-preview__pdf-text').first()
    await expect(firstLayer).toHaveAttribute('data-text-status', 'ready')
    await firstLayer.getByText('GammaSelected', { exact: true }).dblclick()
    await assertQuote('GammaSelected', 'DoNotQuotePDF')
    await pdf.getByRole('combobox', { name: '缩放', exact: true }).selectOption('0.75')
    await expect(firstLayer).toHaveAttribute('data-text-status', 'ready')
    await firstLayer.getByText('GammaSelected', { exact: true }).dblclick()
    await assertQuote('GammaSelected', 'DoNotQuotePDF')
    await pdf.locator('.document-preview__body--pdf').evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(pdf.locator('.document-preview__pdf-text').last()).toHaveAttribute('data-text-status', 'ready')
    await expect(firstLayer.locator('span')).toHaveCount(0)
    await pdf.locator('.document-preview__pdf-text').last().getByText('Page8Selected', { exact: true }).dblclick()
    await assertQuote('Page8Selected', 'DoNotQuotePDF')
    await open(names.docx)
    const hiddenPdf = page.locator('.work-view [data-document-preview="pdf"]')
    await expect(hiddenPdf.locator('.document-preview__pdf-text span')).toHaveCount(0)
  })

  test('扫描 PDF 无文字层内容，不提供虚假的文本选区', async () => {
    await open(names.scan)
    const layer = panel().locator('.document-preview__pdf-text')
    await expect(layer).toHaveAttribute('data-text-status', 'empty')
    await expect(layer.locator('span')).toHaveCount(0)
    await layer.dblclick()
    await expect(panel().getByRole('button', { name: '添加到对话', exact: true })).toBeVisible()
    await expect(composer()).toBeEmpty()
  })
})
