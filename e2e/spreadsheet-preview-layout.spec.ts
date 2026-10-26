/** 表格预览真机：工作表交互、真实格式还原、后台会话复用及 Office XML 兼容性。 */
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { Workbook } from 'exceljs'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
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

test('还原 Excel 背景、字体、边框与行列尺寸，切换文件不重复整本解析', async () => {
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const workbook = new Workbook(), sheet = workbook.addWorksheet('项目概览')
  sheet.addRow(['项目', '内容'])
  sheet.addRow(['项目名称', '五子棋 Web 应用'])
  sheet.getCell('A1').style = {
    font: { bold: true, color: { argb: 'FF243247' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } },
    border: { bottom: { style: 'hair', color: { argb: 'FFDCE3EB' } } },
    alignment: { vertical: 'middle', wrapText: true },
  }
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } }
  sheet.getColumn(1).width = 20
  sheet.getRow(1).height = 28
  await workbook.xlsx.writeFile(join(workspace, 'styled.xlsx'))
  const other = new Workbook()
  other.addWorksheet('其他').addRow(['另一个表格'])
  await other.xlsx.writeFile(join(workspace, 'other.xlsx'))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
  app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
  const page = await app.firstWindow()
  const workerLoads: string[] = []
  page.on('worker', worker => { if (worker.url().includes('spreadsheet-preview')) workerLoads.push(worker.url()) })
  try {
    await openSpreadsheet('styled.xlsx')
    const table = page.getByRole('table', { name: '项目概览', exact: true })
    await expect(table).toContainText('五子棋 Web 应用')
    const header = table.locator('tbody td').first()
    await expect(header).toHaveCSS('background-color', 'rgb(232, 238, 245)')
    await expect(header).toHaveCSS('color', 'rgb(36, 50, 71)')
    await expect(header).toHaveCSS('border-bottom-color', 'rgb(220, 227, 235)')
    await expect(header).toHaveCSS('white-space', 'pre-wrap')
    expect(await table.locator('tbody tr').first().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(35)
    expect(await table.locator('thead th').nth(1).evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(135)
    await expect(table.locator('tbody td').nth(2)).toHaveCSS('background-color', 'rgb(247, 249, 252)')
    await expect.poll(() => workerLoads.length).toBe(1)
    await openSpreadsheet('other.xlsx')
    await expect(page.getByRole('table', { name: '其他', exact: true })).toContainText('另一个表格')
    await expect.poll(() => workerLoads.length).toBe(2)
    await openSpreadsheet('styled.xlsx')
    await expect(page.getByRole('table', { name: '项目概览', exact: true })).toContainText('五子棋 Web 应用')
    expect(workerLoads).toHaveLength(2)
    await expect(header).toBeVisible()
    await header.click()
    await expect(page.locator('.document-preview__body--sheet')).toHaveAttribute('data-document-sheet', '0')
  } finally {
    await app.close()
    app = undefined
  }
})

test('真实交付 XLSX 的六个工作表保留背景与行列尺寸', async () => {
  test.skip(!process.env.AETHER_XLSX_FIXTURE, '未提供真实 XLSX 验证路径')
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(profile, { recursive: true })
  copyFileSync(process.env.AETHER_XLSX_FIXTURE!, join(workspace, 'delivery.xlsx'))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
  app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
  const page = await app.firstWindow()
  try {
    await openSpreadsheet('delivery.xlsx')
    const table = page.getByRole('table', { name: '项目概览', exact: true })
    await expect(table).toContainText('五子棋 Web 应用')
    await expect(table.locator('tbody td').first()).toHaveCSS('background-color', 'rgb(232, 238, 245)')
    await expect(table.locator('tbody td').first()).toHaveCSS('color', 'rgb(36, 50, 71)')
    expect(await table.locator('tbody tr').first().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(35)
    for (const name of ['文件清单', '主题清单', '功能清单', '验证记录', '待办事项']) {
      await page.getByRole('tab', { name, exact: true }).click()
      await expect(page.getByRole('table', { name, exact: true })).toBeVisible()
    }
  } finally {
    await app.close()
    app = undefined
  }
})

test('大表在后台解析时仍可操作界面，并完成首尾行预览', async () => {
  const workspace = join(fixture, 'workspace'), profile = join(fixture, 'profile')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const workbook = new Workbook(), sheet = workbook.addWorksheet('大表')
  for (let row = 1; row <= 5_000; row++) {
    for (let column = 1; column <= 10; column++) sheet.getCell(row, column).value = `参数-${row}-${column}`
  }
  await workbook.xlsx.writeFile(join(workspace, 'large.xlsx'))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
  app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
  const page = await app.firstWindow()
  try {
    await openSpreadsheet('large.xlsx')
    const started = Date.now()
    await page.keyboard.press('Control+p')
    await expect(page.locator('.palette[aria-label="快速打开文件"]')).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    expect(Date.now() - started).toBeLessThan(5_000)
    await expect(page.getByRole('table', { name: '大表', exact: true })).toContainText('参数-1-1', { timeout: 35_000 })
    const input = page.locator('.document-preview__table-nav input')
    await input.fill('50')
    await input.press('Enter')
    await expect(page.getByRole('table', { name: '大表', exact: true })).toContainText('参数-5000-10')
    await expect(page.getByText('Aether 暂时无法解析此文档，原文件已保留。', { exact: true })).toHaveCount(0)
  } finally {
    await app.close()
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
  app = await electron.launch({ args: [process.env.AETHER_E2E_MAIN || '.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
  try {
    const page = await openSpreadsheet('prefixed.xlsx')
    await expect(page.getByRole('table', { name: '银河系参数', exact: true })).toContainText('棒旋星系')
    await expect(page.getByText('Aether 暂时无法解析此文档，原文件已保留。', { exact: true })).toHaveCount(0)
  } finally {
    await app.close()
    app = undefined
  }
})
