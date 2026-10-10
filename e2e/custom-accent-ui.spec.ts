/** 自定义强调色事务：拖动防抖、HEX/RGB/取色临时预览、确认保存与取消还原、焦点、主题可读性、窄窗口及重启。 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AetherIdeApi } from '../src/preload'

declare global { interface Window { aether: AetherIdeApi } }

const root = resolve(__dirname, '..')
const fixture = join(root, '.e2e-tmp', 'custom-accent-userdata')
const settingsFile = join(fixture, 'settings.json')
let app: ElectronApplication
let page: Page
const errors: string[] = []

function saved(): { accent: string; customAccentColor: string } {
  const { accent, customAccentColor } = JSON.parse(readFileSync(settingsFile, 'utf8'))
  return { accent, customAccentColor }
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.', `--user-data-dir=${fixture}`], cwd: root })
  page = await app.firstWindow()
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGEERROR', error.message) })
  await expect(page.locator('.workbench')).toBeVisible()
}

async function openAppearance(): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('.app-settings')).toBeVisible()
  await page.getByRole('tab', { name: '外观', exact: true }).click()
  await expect(page.locator('.settings-view--appearance')).toBeVisible()
}

function picker() {
  return page.getByRole('dialog', { name: '自定义强调色', exact: true })
}

async function openPicker(): Promise<void> {
  if (await picker().isVisible()) return
  const edit = page.getByRole('button', { name: '编辑自定义强调色', exact: true })
  if (await edit.isVisible()) await edit.click()
  else await page.getByRole('radio', { name: '自定义颜色', exact: true }).click()
  await expect(picker()).toBeVisible()
}

async function closePicker(): Promise<void> {
  if (await picker().isVisible()) {
    const color = await picker().getByRole('textbox', { name: '自定义强调色色值' }).inputValue()
    await picker().getByRole('button', { name: '完成颜色选择', exact: true }).click()
    await expect.poll(() => saved()).toEqual({ accent: 'custom', customAccentColor: color })
  }
  await expect(picker()).toBeHidden()
}

async function cancelPicker(): Promise<void> {
  await picker().getByRole('slider', { name: '饱和度和亮度', exact: true }).press('Escape')
  await expect(picker()).toBeHidden()
}

async function setHex(hex: string): Promise<void> {
  await openPicker()
  const input = picker().getByRole('textbox', { name: '自定义强调色色值' })
  await input.fill(hex)
  await input.press('Enter')
  const value = hex.length === 4 ? `#${hex.slice(1).split('').map(channel => channel.repeat(2)).join('')}` : hex
  await expect(page.locator('html')).toHaveAttribute('data-custom-accent', value.toLowerCase())
}

async function confirmHex(hex: string): Promise<void> {
  await setHex(hex)
  await closePicker()
}

async function previewColors(): Promise<{ foreground: string; background: string; accent: string }> {
  return page.locator('.theme-preview .btn--primary').evaluate(button => {
    const style = getComputedStyle(button)
    return { foreground: style.color, background: style.backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }
  })
}

function rgb(hex: string): string {
  return `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`
}

function contrast(first: string, second: string): number {
  const luminance = (css: string): number => {
    const match = css.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    if (!match) throw new Error(`无法解析计算后的颜色 ${css}`)
    const channels = match.slice(1, 4).map(value => {
      const channel = Number(value) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test.describe.serial('外观设置的自定义颜色', () => {
  test.beforeAll(async () => {
    mkdirSync(fixture, { recursive: true })
    writeFileSync(settingsFile, JSON.stringify({ autoStartEngine: false, lastFolder: '', lastSessionId: '', appearance: 'dark', accent: 'purple', customAccentColor: '#4b95f1' }))
    await launch()
    await page.evaluate(() => localStorage.setItem('aether.ide.layout', JSON.stringify({ sidebarVisible: false, chatPanelVisible: false })))
    await page.reload()
    await openAppearance()
  })

  test.afterAll(async () => {
    await app?.close()
    rmSync(fixture, { recursive: true, force: true })
  })

  test('自定义入口与 HEX 只临时预览，完成才保存并关闭', async () => {
    const baseline = saved()
    const group = page.getByRole('radiogroup', { name: '强调色', exact: true })
    await expect(group.getByRole('radio')).toHaveCount(7)
    const custom = group.getByRole('radio', { name: '自定义颜色', exact: true })
    await custom.click()
    await expect(picker()).toBeVisible()
    await expect(picker().getByRole('slider', { name: '饱和度和亮度', exact: true })).toBeFocused()
    await expect(custom).toHaveAttribute('aria-checked', 'true')
    await expect(group.getByRole('radio', { name: '紫色', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    expect(saved()).toEqual(baseline)
    await setHex('#168A70')
    expect(saved()).toEqual(baseline)
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#168a70')
    await expect.poll(async () => (await previewColors()).background).toBe('rgb(22, 138, 112)')
    await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue('#168a70')
    await closePicker()
    expect(saved()).toEqual({ accent: 'custom', customAccentColor: '#168a70' })
    await expect(page.getByRole('button', { name: '编辑自定义强调色', exact: true })).toContainText(/#168a70/i)
  })

  test('非法 HEX 不污染主题与设置，短 HEX 可规范化', async () => {
    const baseline = saved()
    await openPicker()
    const input = page.getByRole('textbox', { name: '自定义强调色色值' })
    await input.fill('#GG0000')
    await input.press('Enter')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(picker().getByRole('button', { name: '完成颜色选择', exact: true })).toBeDisabled()
    expect(saved()).toEqual(baseline)
    expect((await previewColors()).background).toBe('rgb(22, 138, 112)')
    const rejected = await page.evaluate(async () => {
      try { await window.aether.settings.update({ customAccentColor: 'var(--accent)' }); return false }
      catch { return true }
    })
    expect(rejected).toBe(true)
    expect(saved()).toEqual(baseline)
    await input.press('Escape')
    await expect(picker()).toBeVisible()
    await expect(input).toHaveValue('#168a70')
    await expect(input).toHaveAttribute('aria-invalid', 'false')
    await closePicker()
    await openPicker()
    await expect(input).toHaveValue('#168a70')
    await setHex('#369')
    expect(saved()).toEqual(baseline)
    await expect(input).toHaveAttribute('aria-invalid', 'false')
    await closePicker()
  })

  test('取色器连续改变同一自定义主题时，控件与色值同步更新', async () => {
    const baseline = saved()
    for (const color of ['#7c3aed', '#b45309', '#147d92']) {
      await setHex(color)
      expect(saved()).toEqual(baseline)
      await expect(page.locator('html')).toHaveAttribute('data-custom-accent', color)
      expect((await previewColors()).accent).toMatch(/^#[\da-f]{6}$/i)
      await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue(color)
      for (const [index, channel] of ['红色通道', '绿色通道', '蓝色通道'].entries()) {
        await expect(picker().getByRole('spinbutton', { name: channel, exact: true }))
          .toHaveValue(String(parseInt(color.slice(1 + index * 2, 3 + index * 2), 16)))
      }
    }
    await closePicker()
  })

  test('RGB 编辑同步主题，非法通道不保存且 Escape 还原草稿', async () => {
    const baseline = saved()
    await setHex('#147d92')
    for (const [name, value] of [['红色通道', '48'], ['绿色通道', '140'], ['蓝色通道', '110']] as const) {
      const input = picker().getByRole('spinbutton', { name, exact: true })
      await input.fill(value)
      await input.press('Enter')
    }
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#308c6e')
    expect(saved()).toEqual(baseline)
    await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue('#308c6e')
    const red = picker().getByRole('spinbutton', { name: '红色通道', exact: true })
    await red.fill('999')
    await red.press('Enter')
    await expect(red).toHaveAttribute('aria-invalid', 'true')
    await expect(picker().getByRole('alert')).toContainText('0–255')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#308c6e')
    expect(saved()).toEqual(baseline)
    await red.press('Escape')
    await expect(picker()).toBeVisible()
    await expect(red).toHaveValue('48')
    await expect(red).toHaveAttribute('aria-invalid', 'false')
    await expect(picker().getByRole('alert')).toHaveCount(0)
    await setHex('#147d92')
    await closePicker()
  })

  test('常用色与还原同步主题，色谱键盘支持白色与黑色', async () => {
    const baseline = saved()
    await openPicker()
    const restore = picker().getByRole('button', { name: '还原', exact: true })
    await expect(restore).toBeDisabled()
    await picker().getByRole('button', { name: '选择薄荷绿', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#30b89a')
    expect(saved()).toEqual(baseline)
    await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue('#30b89a')
    await expect(picker().getByRole('spinbutton', { name: '绿色通道', exact: true })).toHaveValue('184')
    await expect(restore).toBeEnabled()
    await restore.click()
    await expect(picker()).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#147d92')
    expect(saved()).toEqual(baseline)
    await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue('#147d92')
    await expect(restore).toBeDisabled()
    await setHex('#ff0000')
    const spectrum = picker().getByRole('slider', { name: '饱和度和亮度', exact: true })
    await spectrum.focus()
    await spectrum.press('Home')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#ffffff')
    await spectrum.press('Shift+ArrowRight')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#ffe6e6')
    await spectrum.press('ArrowDown')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#fce3e3')
    await spectrum.press('End')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#000000')
    expect(saved()).toEqual(baseline)
    await setHex('#147d92')
    await closePicker()
  })

  test('屏幕取色成功更新主题，取消静默保留上次颜色', async () => {
    const baseline = saved()
    await page.evaluate(() => {
      const target = window as Window & { __accentEyeDropperDescriptor?: PropertyDescriptor; __accentSampleCalls?: number }
      target.__accentEyeDropperDescriptor = Object.getOwnPropertyDescriptor(window, 'EyeDropper')
      target.__accentSampleCalls = 0
      Object.defineProperty(window, 'EyeDropper', { configurable: true, writable: true, value: class {
        async open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> {
          if (!(options.signal instanceof AbortSignal)) throw new Error('屏幕取色缺少取消信号')
          target.__accentSampleCalls = (target.__accentSampleCalls ?? 0) + 1
          return { sRGBHex: '#C76E38' }
        }
      } })
    })
    try {
      await openPicker()
      await picker().getByRole('button', { name: '从屏幕取色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#c76e38')
      expect(saved()).toEqual(baseline)
      await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue('#c76e38')
      await expect(picker().getByRole('slider', { name: '饱和度和亮度', exact: true })).toBeFocused()
      await expect(picker().getByRole('alert')).toHaveCount(0)
      await closePicker()
      await page.evaluate(() => {
        const target = window as Window & { __accentSampleCalls?: number }
        Object.defineProperty(window, 'EyeDropper', { configurable: true, writable: true, value: class {
          async open(): Promise<{ sRGBHex: string }> {
            target.__accentSampleCalls = (target.__accentSampleCalls ?? 0) + 1
            throw new DOMException('用户取消取色', 'AbortError')
          }
        } })
      })
      await openPicker()
      const sample = picker().getByRole('button', { name: '从屏幕取色', exact: true })
      await sample.click()
      await expect(sample).toBeEnabled()
      await expect(picker().getByRole('slider', { name: '饱和度和亮度', exact: true })).toBeFocused()
      await expect(picker().getByRole('alert')).toHaveCount(0)
      await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#c76e38')
      expect(saved().customAccentColor).toBe('#c76e38')
      expect(await page.evaluate(() => (window as Window & { __accentSampleCalls?: number }).__accentSampleCalls)).toBe(2)
      await setHex('#147d92')
    } finally {
      await closePicker()
      await page.evaluate(() => {
        const target = window as Window & { __accentEyeDropperDescriptor?: PropertyDescriptor; __accentSampleCalls?: number }
        if (target.__accentEyeDropperDescriptor) Object.defineProperty(window, 'EyeDropper', target.__accentEyeDropperDescriptor)
        else Reflect.deleteProperty(window, 'EyeDropper')
        delete target.__accentEyeDropperDescriptor
        delete target.__accentSampleCalls
      })
    }
  })

  test('二维色谱支持真实拖拽，沿色相变化保留饱和度与亮度', async () => {
    const baseline = saved()
    await setHex('#ff0000')
    const spectrum = picker().getByRole('slider', { name: '饱和度和亮度', exact: true })
    const box = await spectrum.boundingBox()
    if (!box) throw new Error('二维色谱没有可交互的布局区域')
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3, { steps: 8 })
    await page.mouse.up()
    const color = await picker().getByRole('textbox', { name: '自定义强调色色值' }).inputValue()
    // 初始红色也满足下方的数值下界，须等全局确实应用本轮最终草稿后再校验。
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', color)
    const [red, green, blue] = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16))
    expect(red).toBeGreaterThanOrEqual(176)
    expect(red).toBeLessThanOrEqual(181)
    expect(green).toBeGreaterThanOrEqual(32)
    expect(green).toBeLessThanOrEqual(39)
    expect(blue).toBe(green)
    expect(saved()).toEqual(baseline)
    const hue = picker().getByRole('slider', { name: '色相', exact: true })
    await hue.focus()
    await hue.press('ArrowRight')
    await expect.poll(() => page.locator('html').getAttribute('data-custom-accent')).not.toBe(color)
    const next = await page.locator('html').getAttribute('data-custom-accent')
    if (!next) throw new Error('色相键盘编辑后没有应用主题')
    const channels = [1, 3, 5].map(offset => parseInt(next.slice(offset, offset + 2), 16))
    expect(Math.max(...channels)).toBe(red)
    expect(Math.min(...channels)).toBe(blue)
    expect(saved()).toEqual(baseline)
    await setHex('#147d92')
    await closePicker()
  })

  test('色谱与色相连续移动只改草稿，停顿 300ms 和释放只预览，取消清除待执行预览', async () => {
    const original = '#147d92'
    await confirmHex(original)
    const baseline = saved()
    await openPicker()
    const html = page.locator('html')
    const input = picker().getByRole('textbox', { name: '自定义强调色色值' })
    const expectUnapplied = async (color: string): Promise<void> => {
      expect(await html.getAttribute('data-custom-accent')).toBe(color)
      expect(saved()).toEqual(baseline)
    }
    // 冻结渲染端定时器，真实鼠标事件与 IPC 仍运行，避免断言耗时越过防抖边界。
    await page.clock.install({ time: new Date('2026-10-10T00:00:00Z') })
    await page.clock.pauseAt(new Date('2026-10-10T00:00:01Z'))
    try {
      for (const name of ['饱和度和亮度', '色相']) {
        await setHex(original)
        expect(saved()).toEqual(baseline)
        const control = picker().getByRole('slider', { name, exact: true })
        const box = await control.boundingBox()
        if (!box) throw new Error(`${name}没有可交互的布局区域`)
        const move = async (x: number, y: number): Promise<void> => {
          await page.mouse.move(box.x + box.width * x, box.y + box.height * (name === '色相' ? 0.5 : y))
        }
        await move(0.16, 0.78)
        await page.mouse.down()
        let draft = await input.inputValue()
        expect(draft, `${name}按下后应先更新本地 HEX`).not.toBe(original)
        await expectUnapplied(original)
        for (const [x, y] of [[0.25, 0.65], [0.4, 0.55], [0.55, 0.45], [0.7, 0.35]]) {
          await page.clock.runFor(100)
          await move(x, y)
          const next = await input.inputValue()
          expect(next, `${name}每帧应更新本地 HEX`).not.toBe(draft)
          draft = next
          await expectUnapplied(original)
        }
        // 总移动时间已达 400ms；每次移动都须重新开始 300ms 的等待。
        await page.clock.runFor(299)
        await expectUnapplied(original)
        await page.clock.runFor(1)
        await expect(html).toHaveAttribute('data-custom-accent', draft)
        expect(saved()).toEqual(baseline)
        await move(0.85, 0.2)
        const released = await input.inputValue()
        expect(released).not.toBe(draft)
        await expectUnapplied(draft)
        await page.mouse.up()
        // 时钟仍暂停，释放后的应用不能依赖剩余定时器。
        await expect(html).toHaveAttribute('data-custom-accent', released)
        expect(saved()).toEqual(baseline)
      }

      await setHex(original)
      expect(saved()).toEqual(baseline)
      const box = await picker().getByRole('slider', { name: '饱和度和亮度', exact: true }).boundingBox()
      if (!box) throw new Error('二维色谱没有可交互的布局区域')
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.25)
      await page.mouse.down()
      const closing = await input.inputValue()
      expect(closing).not.toBe(original)
      await expectUnapplied(original)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect(picker()).toBeHidden()
      await expect(html).toHaveAttribute('data-custom-accent', original)
      expect(saved()).toEqual(baseline)
      const preset = await page.getByRole('radio', { name: '紫色', exact: true }).boundingBox()
      if (!preset) throw new Error('紫色色板没有可交互的布局区域')
      await page.mouse.click(preset.x + preset.width / 2, preset.y + preset.height / 2)
      await expect(html).toHaveAttribute('data-accent', 'purple')
      await expect.poll(() => saved().accent).toBe('purple')
      await page.clock.runFor(300)
      await expect(html).toHaveAttribute('data-accent', 'purple')
      expect(saved()).toEqual({ ...baseline, accent: 'purple' })
    } finally {
      await page.mouse.up()
      await page.clock.resume()
      await confirmHex(original)
    }
  })

  test('再次点击入口、Escape 和外部点击取消草稿，恢复保存色并返回焦点', async () => {
    const baseline = saved()
    const edit = page.getByRole('button', { name: '编辑自定义强调色', exact: true })
    await edit.click()
    await expect(picker()).toBeVisible()
    await setHex('#e85a80')
    expect(saved()).toEqual(baseline)
    await edit.click()
    await expect(picker()).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', baseline.customAccentColor)
    expect(saved()).toEqual(baseline)
    await edit.click()
    await expect(picker()).toBeVisible()
    await setHex('#eab308')
    await picker().getByRole('textbox', { name: '自定义强调色色值' }).press('Escape')
    await expect(picker()).toBeHidden()
    await expect(edit).toBeFocused()
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', baseline.customAccentColor)
    expect(saved()).toEqual(baseline)
    await edit.press('Enter')
    await expect(picker()).toBeVisible()
    await closePicker()
    await expect(edit).toBeFocused()
    await openPicker()
    await setHex('#c76e38')
    await page.locator('.theme-preview .btn--primary').click()
    await expect(picker()).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', baseline.customAccentColor)
    expect(saved()).toEqual(baseline)
    await openPicker()
    await setHex('#007aff')
    await page.getByRole('radio', { name: '紫色', exact: true }).click()
    await expect(picker()).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'purple')
    await expect.poll(() => saved()).toEqual({ ...baseline, accent: 'purple' })
    await confirmHex(baseline.customAccentColor)
  })

  test('从预设打开后取消恢复原预设，还原只恢复打开时草稿并保持面板打开', async () => {
    await page.getByRole('radio', { name: '蓝色', exact: true }).click()
    await expect.poll(() => saved().accent).toBe('blue')
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue')
    const baseline = saved()
    await openPicker()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', baseline.customAccentColor)
    expect(saved()).toEqual(baseline)
    await setHex('#af52de')
    await picker().getByRole('button', { name: '还原', exact: true }).click()
    await expect(picker()).toBeVisible()
    await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue(baseline.customAccentColor)
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', baseline.customAccentColor)
    expect(saved()).toEqual(baseline)
    await setHex('#30b89a')
    await cancelPicker()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue')
    expect(await page.locator('html').getAttribute('data-custom-accent')).toBeNull()
    await expect.poll(async () => (await previewColors()).accent).toBe('#4b95f1')
    await expect(page.getByRole('radio', { name: '蓝色', exact: true })).toHaveAttribute('aria-checked', 'true')
    expect(saved()).toEqual(baseline)
    await confirmHex(baseline.customAccentColor)
  })

  test('切换设置分类卸载色板时取消全局预览', async () => {
    const baseline = saved()
    await setHex('#ff2d55')
    expect(saved()).toEqual(baseline)
    // 键盘切换不触发外部鼠标关闭，才能单独验证卸载时的预览清理。
    await page.getByRole('tab', { name: '文本编辑器', exact: true }).press('Enter')
    await expect(page.locator('.settings-view--appearance')).toBeHidden()
    await expect(picker()).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-accent', baseline.accent)
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', baseline.customAccentColor)
    expect(saved()).toEqual(baseline)
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await expect(page.locator('.settings-view--appearance')).toBeVisible()
    await openPicker()
    await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue(baseline.customAccentColor)
    await cancelPicker()
  })

  test('深浅主题和极亮极暗色保持按钮文字可读，用户原色仍保留', async () => {
    for (const appearance of ['light', 'dark'] as const) {
      await closePicker()
      await page.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      for (const color of ['#ffffff', '#000000', '#ffff00', '#147d92']) {
        const baseline = saved()
        await setHex(color)
        expect(saved()).toEqual(baseline)
        await expect(page.locator('html')).toHaveAttribute('data-custom-accent', color)
        await closePicker()
        await expect.poll(async () => {
          const colors = await previewColors()
          return colors.background === rgb(colors.accent)
        }).toBe(true)
        const colors = await previewColors()
        expect(contrast(colors.foreground, colors.background), `${appearance} ${color} 按钮文字`).toBeGreaterThanOrEqual(4.5)
        expect(colors.accent).toMatch(/^#[\da-f]{6}$/i)
        await page.locator('.theme-preview .btn--primary').hover()
        const hover = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-hover').trim())
        await expect.poll(async () => (await previewColors()).background).toBe(rgb(hover))
        const hovered = await previewColors()
        expect(contrast(hovered.foreground, hovered.background), `${appearance} ${color} 悬停文字`).toBeGreaterThanOrEqual(4.5)
        await page.mouse.move(0, 0)
      }
    }
  })

  test('切回预设恢复令牌，回选自定义保留上次色值', async () => {
    await page.getByRole('radio', { name: '蓝色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue')
    await expect.poll(() => saved().accent).toBe('blue')
    const baseline = saved()
    await expect.poll(async () => (await previewColors()).accent).toBe('#4b95f1')
    await expect(page.getByRole('textbox', { name: '自定义强调色色值' })).toHaveCount(0)
    expect(saved().customAccentColor).toBe('#147d92')
    await page.getByRole('radio', { name: '自定义颜色', exact: true }).click()
    await expect(picker()).toBeVisible()
    await expect.poll(async () => (await previewColors()).accent).toBe('#147d92')
    expect(saved()).toEqual(baseline)
    await closePicker()
  })

  test('窄窗口和深浅外观下色板不溢出，颜色浮层完整留在窗口内', async ({}, testInfo) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 740))
    await page.evaluate(() => localStorage.setItem('aether.ide.layout', JSON.stringify({ sidebarVisible: true, chatPanelVisible: true, sidebarWidth: 220, chatPanelWidth: 280 })))
    await page.reload()
    await openAppearance()
    const view = page.locator('.settings-view--appearance')
    for (const appearance of ['light', 'dark'] as const) {
      await closePicker()
      await page.getByRole('radio', { name: appearance === 'light' ? '浅色' : '深色', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-appearance', appearance)
      const geometry = await view.evaluate(element => {
        const box = element.getBoundingClientRect()
        return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          controls: [...element.querySelectorAll('.accent-swatch, [aria-label="编辑自定义强调色"]')].map(control => {
            const rect = control.getBoundingClientRect()
            return { left: rect.left - box.left, right: rect.right - box.left, width: rect.width }
          }) }
      })
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
      for (const control of geometry.controls) {
        expect(control.left).toBeGreaterThanOrEqual(0)
        expect(control.right).toBeLessThanOrEqual(geometry.clientWidth + 1)
        expect(control.width).toBeGreaterThan(16)
      }
      await openPicker()
      const floating = await picker().evaluate(element => {
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          controls: [...element.querySelectorAll('input, button, [role="slider"]')].map(control => {
            const box = control.getBoundingClientRect()
            return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
          }) }
      })
      expect(floating.top).toBeGreaterThanOrEqual(0)
      expect(floating.bottom).toBeLessThanOrEqual(floating.viewportHeight + 1)
      expect(floating.left).toBeGreaterThanOrEqual(0)
      expect(floating.right).toBeLessThanOrEqual(floating.viewportWidth + 1)
      expect(floating.scrollWidth).toBeLessThanOrEqual(floating.clientWidth + 1)
      expect(floating.controls.length).toBeGreaterThanOrEqual(7)
      for (const control of floating.controls) {
        expect(control.top).toBeGreaterThanOrEqual(floating.top - 1)
        expect(control.bottom).toBeLessThanOrEqual(floating.bottom + 1)
        expect(control.left).toBeGreaterThanOrEqual(floating.left - 1)
        expect(control.right).toBeLessThanOrEqual(floating.right + 1)
      }
      const screenshot = testInfo.outputPath(`custom-accent-compact-${appearance}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`${appearance} 窄窗口与颜色浮层`, { path: screenshot, contentType: 'image/png' })
      const panelScreenshot = testInfo.outputPath(`custom-accent-picker-${appearance}.png`)
      await picker().screenshot({ path: panelScreenshot })
      await testInfo.attach(`${appearance} 颜色面板`, { path: panelScreenshot, contentType: 'image/png' })
    }
  })

  test('实际重启只恢复已确认自定义色，未完成预览不写盘', async () => {
    await confirmHex('#147d92')
    const baseline = saved()
    await setHex('#b45309')
    expect(saved()).toEqual(baseline)
    await app.close()
    await launch()
    await openAppearance()
    await expect(page.getByRole('radio', { name: '自定义颜色', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-custom-accent', '#147d92')
    await openPicker()
    await expect(picker().getByRole('textbox', { name: '自定义强调色色值' })).toHaveValue('#147d92')
    await expect.poll(async () => (await previewColors()).accent).toBe('#147d92')
    expect(saved()).toEqual(baseline)
    await cancelPicker()
    expect(errors).toEqual([])
  })
})
