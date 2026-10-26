/** 表格预览真机：工作表标签交互，以及带命名空间前缀和绝对表格引用的兼容性。 */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { Workbook } from 'exceljs'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const APP_ROOT = resolve(__dirname, '..')
const FIXTURE_ROOT = join(APP_ROOT, '.e2e-tmp')
let fixture = '', app: ElectronApplication | undefined

test.beforeEach(() => {
  mkdirSync(FIXTURE_ROOT, { recursive: true })
  fixture = mkdtempSync(join(FIXTURE_ROOT, 'spreadsheet-preview-'))
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  const child = relative(FIXTURE_ROOT, fixture)
  if (fixture && child.startsWith('spreadsheet-preview-') && !child.includes(sep)) rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function openSpreadsheet(file: string) {
  const page = await app!.firstWindow()
  await expect(page.locator('.workbench')).toBeVisible()
  await page.keyboard.press('Control+p')
  const picker = page.locator('.palette[aria-label="快速打开文件"]')
  await picker.locator('.palette__input').fill(file)
  await expect(picker.locator('.palette__item').first()).toContainText(file, { timeout: 30_000 })
  await page.keyboard.press('Enter')
  return page
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RENDERER_URL', 'ELECTRON_EXEC_PATH', 'ELECTRON_CLI_ARGS', 'NODE_ENV_ELECTRON_VITE']) delete env[key]
  return env
}

test('底部平铺工作表标签，支持鼠标与方向键切换', async () => {
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const workbook = new Workbook()
  workbook.addWorksheet('第一张').addRow(['第一张的内容'])
  workbook.addWorksheet('第二张').addRow(['第二张的内容'])
  await workbook.xlsx.writeFile(join(workspace, 'layout.xlsx'))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
    const page = await openSpreadsheet('layout.xlsx')
    const body = page.locator('.document-preview__body--sheet')
    const selector = page.getByRole('tablist', { name: '工作表', exact: true })
    const first = page.getByRole('tab', { name: '第一张', exact: true })
    const second = page.getByRole('tab', { name: '第二张', exact: true })
    await expect(page.getByRole('table', { name: '第一张', exact: true })).toContainText('第一张的内容')
    await expect(selector).toBeVisible()
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => body.evaluate(element => element.nextElementSibling?.classList.contains('document-preview__toolbar--sheets'))).toBe(true)
    expect(await body.evaluate(element => element.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(await selector.evaluate(element => element.getBoundingClientRect().top) + 1)
    await second.click()
    await expect(page.getByRole('table', { name: '第二张', exact: true })).toContainText('第二张的内容')
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await second.press('ArrowLeft')
    await expect(first).toBeFocused()
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('table', { name: '第一张', exact: true })).toContainText('第一张的内容')
  } finally {
    await app?.close()
    app = undefined
  }
})

test('带命名空间前缀和包内绝对表格引用的 XLSX 可预览', async () => {
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const workbook = new Workbook(), sheet = workbook.addWorksheet('银河系参数')
  sheet.addTable({
    name: 'MilkyWayParameters', ref: 'A1', headerRow: true, totalsRow: false,
    columns: [{ name: '类别' }, { name: '参数' }], rows: [['总体', '棒旋星系']],
  })
  const input = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  for (const name of Object.keys(input.files)) {
    if (!/^xl\/.*\.xml$/.test(name)) continue
    const xml = new DOMParser().parseFromString(await input.file(name)!.async('string'), 'application/xml')
    xml.documentElement.removeAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns')
    for (const element of Array.from(xml.getElementsByTagNameNS(namespace, '*'))) {
      const replacement = xml.createElementNS(namespace, 'x:' + element.localName)
      for (const attribute of Array.from(element.attributes)) replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
      while (element.firstChild) replacement.appendChild(element.firstChild)
      element.parentNode!.replaceChild(replacement, element)
    }
    input.file(name, new XMLSerializer().serializeToString(xml))
  }
  const relations = 'xl/worksheets/_rels/sheet1.xml.rels'
  const xml = new DOMParser().parseFromString(await input.file(relations)!.async('string'), 'application/xml')
  for (const relation of Array.from(xml.getElementsByTagNameNS('*', 'Relationship'))) {
    if (relation.getAttribute('Type')?.endsWith('/table')) relation.setAttribute('Target', '/xl/tables/table1.xml')
  }
  input.file(relations, new XMLSerializer().serializeToString(xml))
  writeFileSync(join(workspace, 'prefixed.xlsx'), await input.generateAsync({ type: 'nodebuffer' }))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
  try {
    const page = await openSpreadsheet('prefixed.xlsx')
    await expect(page.getByRole('table', { name: '银河系参数', exact: true })).toContainText('棒旋星系')
    await expect(page.getByText('Aether 暂时无法解析此文档，原文件已保留。', { exact: true })).toHaveCount(0)
  } finally {
    await app.close()
    app = undefined
  }
})
