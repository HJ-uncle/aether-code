/** 图片预览真机闭环：打开图片后滚轮缩放、按钮缩放、拖拽平移、双击复位。 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { deflateSync } from 'node:zlib'

const APP_ROOT = resolve(__dirname, '..')
const FIXTURE_ROOT = join(APP_ROOT, '.e2e-tmp')

const IMAGE_W = 480
const IMAGE_H = 360

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const tag = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])))
  return Buffer.concat([len, tag, data, crc])
}

/** 最小 PNG 编码器：生成一张带渐变色的真彩图，供自然尺寸 / 缩放断言使用。 */
function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3
      raw[p] = Math.round((x * 255) / width)
      raw[p + 1] = Math.round((y * 255) / height)
      raw[p + 2] = 128
    }
  }
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

let fixture = '', profile = ''
let app: ElectronApplication | undefined
let page: Page
const errors: string[] = []

/**
 * 托管本会话的客户端会在终端里注入 ELECTRON_RENDERER_URL / ELECTRON_EXEC_PATH 等
 * 变量，直接 `...process.env` 继承会让被测实例去加载别的项目的 dev server。
 * 清掉这些，确保加载本仓库构建产物（out/renderer/index.html）。
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_RENDERER_URL' || key === 'ELECTRON_EXEC_PATH' ||
        key === 'ELECTRON_CLI_ARGS' || key === 'NODE_ENV_ELECTRON_VITE') {
      delete env[key]
    }
  }
  return env
}

interface ViewState {
  scale: number
  x: number
  y: number
  label: string
}

/** 从 img 的 computed transform 读出真实 scale / 位移，避开过渡动画的中间值。 */
async function readView(): Promise<ViewState> {
  return page.locator('.preview__image').evaluate((el) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    return {
      scale: matrix.a,
      x: matrix.e,
      y: matrix.f,
      label: document.querySelector('.preview__zoom-value')?.textContent ?? ''
    }
  })
}

/** transform 过渡是 100ms，等它走完再读，否则读到中间帧。 */
async function settle(): Promise<void> {
  await page.waitForTimeout(250)
}

async function openImage(name: string): Promise<void> {
  await page.keyboard.press('Control+p')
  const picker = page.locator('.palette[aria-label="快速打开文件"]')
  await expect(picker).toBeVisible()
  await picker.locator('.palette__input').fill(name)
  await expect(picker.locator('.palette__item').first()).toContainText(name, { timeout: 30_000 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.editor-tab.is-active').first()).toContainText(name)
  await expect(page.locator('.preview__image')).toBeVisible()
  await expect
    .poll(() => page.locator('.preview__image').evaluate((el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth))
    .toBe(IMAGE_W)
}

test.describe.serial('图片预览交互', () => {
  test.beforeAll(async () => {
    mkdirSync(FIXTURE_ROOT, { recursive: true })
    fixture = mkdtempSync(join(FIXTURE_ROOT, 'image-preview-'))
    const workspace = join(fixture, 'workspace')
    profile = join(fixture, 'profile')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(workspace, 'photo.png'), makePng(IMAGE_W, IMAGE_H))
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ autoStartEngine: false, lastFolder: workspace }))
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: APP_ROOT, env: cleanEnv() })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(String(error)))
    await expect(page.locator('.workbench')).toBeVisible()
    await openImage('photo.png')
  })
  test.afterEach(() => expect(errors).toEqual([]))
  test.afterAll(async () => {
    await app?.close()
    const child = relative(FIXTURE_ROOT, fixture)
    if (fixture && child.startsWith('image-preview-') && !child.includes(sep)) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  test('打开图片后按适应窗口展示，缩放值为当前比例', async () => {
    const initial = await readView()
    expect(initial.x).toBe(0)
    expect(initial.y).toBe(0)
    expect(initial.scale).toBeGreaterThan(0)

    // 适应窗口：要么按容器宽高缩到放得下，要么保持 1:1（图片更小）
    const fit = await page.locator('.preview__body').evaluate((el, dims) => {
      return Math.min(el.clientWidth / dims.w, el.clientHeight / dims.h, 1)
    }, { w: IMAGE_W, h: IMAGE_H })
    expect(initial.scale).toBeCloseTo(fit, 2)
    expect(initial.label).toBe(`${Math.round(initial.scale * 100)}%`)
  })

  test('滚轮可放大与缩小，缩放幅度为固定步进', async () => {
    await page.locator('.preview__body').hover()
    const before = await readView()

    await page.mouse.wheel(0, -120)
    await settle()
    const zoomedIn = await readView()
    expect(zoomedIn.scale).toBeCloseTo(before.scale + 0.2, 2)

    await page.mouse.wheel(0, 120)
    await settle()
    const back = await readView()
    expect(back.scale).toBeCloseTo(before.scale, 2)

    // 缩到下限后按钮禁用，不会继续掉
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 120)
    await settle()
    expect((await readView()).scale).toBeCloseTo(0.1, 2)
    await expect(page.getByRole('button', { name: '缩小' })).toBeDisabled()
    await page.getByRole('button', { name: '适应窗口' }).click()
    await settle()
  })

  test('放大 / 缩小按钮与滚轮共用同一套步进', async () => {
    await page.getByRole('button', { name: '适应窗口' }).click()
    await settle()
    const base = await readView()

    await page.getByRole('button', { name: '放大' }).click()
    await settle()
    expect((await readView()).scale).toBeCloseTo(base.scale + 0.2, 2)

    await page.getByRole('button', { name: '缩小' }).click()
    await settle()
    expect((await readView()).scale).toBeCloseTo(base.scale, 2)

    // 上限 10 倍后按钮禁用
    const zoomIn = page.getByRole('button', { name: '放大' })
    for (let i = 0; i < 80 && !(await zoomIn.isDisabled()); i++) await zoomIn.click()
    await settle()
    expect((await readView()).scale).toBeCloseTo(10, 2)
    await expect(zoomIn).toBeDisabled()
  })

  test('左键拖拽平移，位移进入 transform 可不越界拖回', async () => {
    await page.getByRole('button', { name: '适应窗口' }).click()
    await settle()
    const box = await page.locator('.preview__image').boundingBox()
    expect(box).not.toBeNull()

    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 60, cy + 40, { steps: 8 })
    await page.mouse.up()
    const moved = await readView()
    expect(moved.x).toBeCloseTo(60, 0)
    expect(moved.y).toBeCloseTo(40, 0)

    // 拖出容器边界仍能拖回，因为位移是 transform 不占布局
    await page.mouse.move(cx + 60, cy + 40)
    await page.mouse.down()
    await page.mouse.move(cx + 60 - 500, cy + 40 - 500, { steps: 8 })
    await page.mouse.up()
    const far = await readView()
    expect(far.x).toBeCloseTo(-440, 0)
    expect(far.y).toBeCloseTo(-460, 0)
  })

  test('双击复位：回到 1:1 且位移清零', async () => {
    await page.locator('.preview__body').dblclick({ position: { x: 20, y: 20 } })
    await settle()
    const reset = await readView()
    expect(reset.scale).toBeCloseTo(1, 2)
    expect(reset.x).toBeCloseTo(0, 0)
    expect(reset.y).toBeCloseTo(0, 0)
    expect(reset.label).toBe('100%')
  })
})
