/** Pure coverage: strict browser snapshot decoding, nested/live/history result parity and Chinese AX role labels. */
import { expect, test } from '@playwright/test'
import { browserElementRoleLabel, parseBrowserSnapshot } from '../src/renderer/src/contrib/chat/browser-snapshot'
import { parseToolResult } from '../src/renderer/src/contrib/chat/tool-result'

function snapshot() {
  return {
    tab: {
      tabId: 'tab-1', title: '登录平台', url: 'https://example.test/login', loading: false,
      navigationId: 3, canGoBack: false, canGoForward: false, zoomFactor: 1, viewport: null
    },
    text: '欢迎回来\n用户名\n登录',
    elements: [
      { role: 'RootWebArea', name: '登录平台', ref: '3:1' },
      { role: 'textbox', name: '用户名', value: 'test-user', ref: '3:2' },
      { role: 'button', name: '登录', ref: '3:3' }
    ],
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1.5, scrollX: 0, scrollY: 0 },
    truncated: false
  }
}

function clickInteraction() {
  return {
    type: 'click', x: 320.5, y: 180.25, navigationId: 3, pageUrl: 'https://example.test/login',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 2, scrollX: 0, scrollY: 150 },
    target: { role: 'button', name: '登录', ref: '3:3', selector: '#login', bounds: { x: 300, y: 170, width: 80, height: 32 } }
  }
}

const snapshotPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDdwAAAAASUVORK5CYII='
const screenshot = { dataUrl: snapshotPng, width: 1, height: 1 }

test('viewport screenshots stay with page and pre-click geometry through nested history', () => {
  const input = { ...snapshot(), screenshot, interaction: { ...clickInteraction(), screenshot } }
  const output = parseToolResult({ content: [{ type: 'text', text: JSON.stringify(JSON.stringify(input)) }] })
  expect(output.browserSnapshots?.[0].screenshot).toEqual(screenshot)
  expect(output.browserSnapshots?.[0].interaction?.screenshot).toEqual(screenshot)
  expect(output.images).toEqual([])
  expect(output.text).toContain('[页面截图，见位置示意图]')
  expect(output.text).not.toContain(snapshotPng)
})

test('completed click retains its evidence when the resulting page snapshot is unavailable', () => {
  const input = { tab: snapshot().tab, text: '', elements: [], truncated: false,
    snapshotUnavailable: '页面仍在导航，请读取新快照，不要重复已完成的操作。',
    interaction: { ...clickInteraction(), screenshot } }
  const parsed = parseToolResult(JSON.stringify(input)).browserSnapshots?.[0]
  expect(parsed?.snapshotUnavailable).toBe(input.snapshotUnavailable)
  expect(parsed?.viewport).toBeUndefined()
  expect(parsed?.interaction?.screenshot).toEqual(screenshot)
  expect(parsed?.elements).toEqual([])
})

for (const [name, invalid] of [
  ['remote URL', { ...screenshot, dataUrl: 'https://outside.test/image.png' }],
  ['SVG', { ...screenshot, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }],
  ['missing dimensions', { dataUrl: snapshotPng }],
  ['wrong pixel dimensions', { ...screenshot, width: 2 }],
  ['zero dimensions', { ...screenshot, width: 0 }],
  ['fractional dimensions', { ...screenshot, height: 1.5 }],
  ['excessive dimensions', { ...screenshot, width: 1601 }],
  ['excessive encoded size', { ...screenshot, dataUrl: snapshotPng + 'A'.repeat(1_398_126) }],
  ['invalid PNG', { ...screenshot, dataUrl: 'data:image/png;base64,AAAA' }],
  ['array', [screenshot]],
  ['primitive image', snapshotPng],
  ['null', null]
] as const) {
  test(`invalid embedded screenshot ${name} leaves page and click geometry usable`, () => {
    const input = { ...snapshot(), screenshot: invalid, interaction: { ...clickInteraction(), screenshot: invalid } }
    const parsed = parseBrowserSnapshot(input)
    expect(parsed?.screenshot).toBeUndefined()
    expect(parsed?.interaction).toEqual(clickInteraction())
    expect(parsed?.elements).toEqual(snapshot().elements)
    expect(parseToolResult(input).images).toEqual([])
  })
}

test('embedded screenshots and standalone tool images do not suppress one another', () => {
  const result = parseToolResult([{ ...snapshot(), screenshot }, { dataUrl: snapshotPng, filename: 'separate.png' }])
  expect(result.images).toEqual([{ src: snapshotPng, alt: 'separate.png' }])
  expect(result.browserSnapshots?.[0].screenshot).toEqual(screenshot)
})

test('click coordinates remain CSS pixels regardless of DPR and scroll position', () => {
  const interaction = clickInteraction()
  expect(parseBrowserSnapshot({ ...snapshot(), interaction })?.interaction).toEqual(interaction)
})

test('click context survives navigation instead of being rewritten to the resulting page', () => {
  const interaction = clickInteraction()
  const input = { ...snapshot(), tab: { ...snapshot().tab, navigationId: 4, url: 'https://example.test/home' }, viewport: { width: 800, height: 600 }, interaction }
  const result = parseBrowserSnapshot(input)
  expect(result?.url).toBe('https://example.test/home')
  expect(result?.interaction).toEqual(interaction)
})

test('top-left and fractional bottom-right clicks are valid within the CSS viewport', () => {
  for (const point of [{ x: 0, y: 0 }, { x: 1279.75, y: 719.5 }]) {
    const interaction = { ...clickInteraction(), ...point }
    expect(parseBrowserSnapshot({ ...snapshot(), interaction })?.interaction).toEqual(interaction)
  }
})

test('partially clipped targets and negative RTL scroll offsets remain valid', () => {
  const interaction = {
    ...clickInteraction(), viewport: { ...clickInteraction().viewport, scrollX: -100, scrollY: -1.5 },
    target: { name: '部分可见按钮', bounds: { x: -20, y: -10, width: 1300, height: 750 } }
  }
  expect(parseBrowserSnapshot({ ...snapshot(), interaction })?.interaction).toEqual(interaction)
})

for (const [name, invalid] of [
  ['outside right edge', { ...clickInteraction(), x: 1280 }],
  ['outside bottom edge', { ...clickInteraction(), y: 720 }],
  ['negative x', { ...clickInteraction(), x: -0.1 }],
  ['negative y', { ...clickInteraction(), y: -1 }],
  ['NaN coordinate', { ...clickInteraction(), x: NaN }],
  ['infinite coordinate', { ...clickInteraction(), y: Infinity }],
  ['string coordinate', { ...clickInteraction(), x: '100' }],
  ['non-click type', { ...clickInteraction(), type: 'fill' }],
  ['empty viewport', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, width: 0 } }],
  ['negative viewport', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, height: -1 } }],
  ['non-finite viewport', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, width: Infinity } }],
  ['overflowing finite geometry', { ...clickInteraction(), x: 1e308, viewport: { ...clickInteraction().viewport, width: 1.5e308 } }],
  ['viewport above drawable range', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, width: 2 ** 31 } }],
  ['fractional viewport width', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, width: 1280.5 } }],
  ['subpixel viewport height', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, height: 0.5 } }],
  ['zero DPR', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, deviceScaleFactor: 0 } }],
  ['missing scroll', { ...clickInteraction(), viewport: { width: 1280, height: 720, deviceScaleFactor: 2 } }],
  ['non-finite scroll', { ...clickInteraction(), viewport: { ...clickInteraction().viewport, scrollX: NaN } }],
  ['negative navigation', { ...clickInteraction(), navigationId: -1 }],
  ['fractional navigation', { ...clickInteraction(), navigationId: 3.5 }],
  ['unsafe navigation integer', { ...clickInteraction(), navigationId: Number.MAX_SAFE_INTEGER + 1 }],
  ['non-string URL', { ...clickInteraction(), pageUrl: { href: 'https://example.test' } }],
  ['empty URL', { ...clickInteraction(), pageUrl: ' ' }],
  ['invalid target name', { ...clickInteraction(), target: { name: { html: 'login' } } }],
  ['array target', { ...clickInteraction(), target: [] }],
  ['negative target width', { ...clickInteraction(), target: { bounds: { x: -1, y: -1, width: -2, height: 10 } } }],
  ['non-finite target bounds', { ...clickInteraction(), target: { bounds: { x: Infinity, y: 1, width: 2, height: 10 } } }],
  ['oversized positive target x', { ...clickInteraction(), target: { bounds: { x: 2 ** 31, y: 1, width: 2, height: 10 } } }],
  ['oversized negative target y', { ...clickInteraction(), target: { bounds: { x: 1, y: -(2 ** 31), width: 2, height: 10 } } }],
  ['oversized target width', { ...clickInteraction(), target: { bounds: { x: 1, y: 1, width: 2 ** 31, height: 10 } } }],
  ['oversized target height', { ...clickInteraction(), target: { bounds: { x: 1, y: 1, width: 2, height: 2 ** 31 } } }]
] as const) {
  test(`invalid interaction ${name} is omitted without losing the browser snapshot`, () => {
    const result = parseBrowserSnapshot({ ...snapshot(), interaction: invalid })
    expect(result).toEqual(parseBrowserSnapshot(snapshot()))
    expect(result).not.toHaveProperty('interaction')
  })
}

test('drawable geometry includes safe bounds and fractional element rectangles', () => {
  const limit = 2 ** 31 - 1
  const interaction = {
    ...clickInteraction(), x: limit - 0.5, y: 0.25,
    viewport: { ...clickInteraction().viewport, width: limit, height: 1 },
    target: { bounds: { x: -limit, y: 0.25, width: limit, height: 0.5 } }
  }
  expect(parseBrowserSnapshot({ ...snapshot(), interaction })?.interaction).toEqual(interaction)
})

test('history without click metadata never invents a location from tool arguments or element refs', () => {
  expect(parseBrowserSnapshot(snapshot())).not.toHaveProperty('interaction')
  expect(parseToolResult({ args: { x: 300, y: 150 }, output: snapshot() }).browserSnapshots?.[0]).not.toHaveProperty('interaction')
})

test('nested and double-encoded history preserves recorded interactions', () => {
  const input = { ...snapshot(), interaction: clickInteraction() }
  const value = { content: [{ type: 'text', text: JSON.stringify(JSON.stringify(input)) }] }
  expect(parseToolResult(value).browserSnapshots?.[0].interaction).toEqual(input.interaction)
})

test('identical page states with different clicks remain distinguishable', () => {
  const first = { ...snapshot(), interaction: clickInteraction() }
  const second = { ...snapshot(), interaction: { ...clickInteraction(), x: 400 } }
  expect(parseToolResult([first, second]).browserSnapshots?.map(item => item.interaction?.x)).toEqual([320.5, 400])
})

test('interaction labels, selector and source URL remain opaque strings', () => {
  const interaction = {
    ...clickInteraction(), pageUrl: 'javascript:alert(1)',
    target: { name: '<img onerror="alert(1)">', role: '<button>', ref: '<script>', selector: 'body;alert(1)' }
  }
  expect(parseBrowserSnapshot({ ...snapshot(), interaction })?.interaction).toEqual(interaction)
})

test('native browser snapshots expose only display fields and preserve refs and form values', () => {
  expect(parseBrowserSnapshot(snapshot())).toEqual({
    title: '登录平台', url: 'https://example.test/login', text: '欢迎回来\n用户名\n登录',
    elements: snapshot().elements, loading: false, viewport: { width: 1280, height: 720 }, truncated: false
  })
})

test('live object, JSON and double-encoded history yield the same browser view', () => {
  const value = snapshot()
  const expected = parseBrowserSnapshot(value)
  for (const input of [value, JSON.stringify(value), JSON.stringify(JSON.stringify(value))]) {
    expect(parseToolResult(input).browserSnapshots).toEqual([expected])
  }
})

test('snapshot extraction retains the original JSON including its formatting', () => {
  const value = `  ${JSON.stringify(snapshot(), null, 4)}\n`
  const parsed = parseToolResult(value)
  expect(parsed.text).toBe(value)
  expect(parsed.images).toEqual([])
  expect(parsed.browserSnapshots).toHaveLength(1)
})

test('nested MCP text and structuredContent copies are deduplicated', () => {
  const value = snapshot()
  const result = parseToolResult({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { output: value } })
  expect(result.browserSnapshots).toEqual([parseBrowserSnapshot(value)])
  expect(result.text).toContain('structuredContent')
  expect(result.text).toContain('登录平台')
})

test('distinct page states remain in original order', () => {
  const before = snapshot()
  const after = { ...snapshot(), text: '登录成功', elements: [{ role: 'heading', name: '个人中心' }] }
  const result = parseToolResult({ before, after })
  expect(result.browserSnapshots?.map(value => value.text)).toEqual([before.text, '登录成功'])
})

test('blank pages and omitted optional metadata remain valid', () => {
  expect(parseBrowserSnapshot({ tab: { title: '', url: 'about:blank' }, text: '', elements: [] })).toEqual({
    title: '', url: 'about:blank', text: '', elements: [], truncated: false
  })
})

test('loading and truncation flags retain their actual values', () => {
  const input = snapshot()
  input.tab.loading = true
  input.truncated = true
  expect(parseBrowserSnapshot(input)).toMatchObject({ loading: true, truncated: true })
})

test('empty element names and values are preserved rather than dropped', () => {
  const input = { ...snapshot(), elements: [{ role: 'textbox', name: '', value: '', ref: '' }] }
  expect(parseBrowserSnapshot(input)?.elements).toEqual(input.elements)
})

test('element coordinates and fractional sizes retain their real CSS geometry', () => {
  const elements = [
    { role: 'textbox', name: '用户名', value: 'test-user', ref: '3:2', bounds: { x: 24.5, y: 50.25, width: 320.75, height: 36.5 } },
    { role: 'button', name: '登录', ref: '3:3', bounds: { x: -15.5, y: -3.25, width: 90.5, height: 32.75 } },
    { role: 'heading', name: '页面下方', bounds: { x: 50, y: 5000, width: 300, height: 40 } }
  ]
  const input = { ...snapshot(), elements }
  const before = JSON.stringify(input)
  expect(parseBrowserSnapshot(input)?.elements).toEqual(elements)
  expect(JSON.stringify(input)).toBe(before)
})

test('zero-area boxes, explicitly missing layout and historical omissions stay distinct', () => {
  const elements = [
    { role: 'generic', name: '无宽度', bounds: { x: 20, y: 20, width: 0, height: 10 } },
    { role: 'generic', name: '无高度', bounds: { x: 10, y: 10, width: 10, height: 0 } },
    { role: 'generic', name: '零尺寸', bounds: { x: 0, y: 0, width: 0, height: 0 } },
    { role: 'StaticText', name: '无布局框', bounds: null },
    { role: 'button', name: '旧历史未记录' }
  ]
  const result = parseBrowserSnapshot({ ...snapshot(), elements })
  expect(result?.elements).toEqual(elements)
  expect(result?.elements[3].bounds).toBeNull()
  expect(result?.elements[4]).not.toHaveProperty('bounds')
})

for (const [name, bounds] of [
  ['missing dimension', { x: 1, y: 2, width: 3 }],
  ['string coordinate', { x: '1', y: 2, width: 3, height: 4 }],
  ['negative width', { x: 1, y: 2, width: -1, height: 4 }],
  ['negative height', { x: 1, y: 2, width: 3, height: -1 }],
  ['NaN coordinate', { x: NaN, y: 2, width: 3, height: 4 }],
  ['infinite dimension', { x: 1, y: 2, width: 3, height: Infinity }],
  ['huge positive coordinate', { x: 2 ** 31, y: 2, width: 3, height: 4 }],
  ['huge negative coordinate', { x: 1, y: -(2 ** 31), width: 3, height: 4 }],
  ['huge dimension', { x: 1, y: 2, width: 1e308, height: 4 }],
  ['array geometry', [1, 2, 3, 4]],
  ['non-object geometry', '1,2,3,4']
] as const) {
  test(`invalid element ${name} drops only geometry, preserving all page elements`, () => {
    const original = snapshot()
    const input = { ...original, elements: original.elements.map(element => ({ ...element, bounds })) }
    expect(parseBrowserSnapshot(input)).toEqual(parseBrowserSnapshot(original))
  })
}

test('element boxes at drawable boundaries are accepted without clipping source coordinates', () => {
  const limit = 2 ** 31 - 1
  const elements = [{ role: 'generic', name: '边界', bounds: { x: -limit, y: limit, width: limit, height: 0 } }]
  expect(parseBrowserSnapshot({ ...snapshot(), elements })?.elements).toEqual(elements)
})

test('nested and double-encoded historical snapshots retain element geometry and absent layout', () => {
  const input = { ...snapshot(), elements: [
    { role: 'button', name: '登录', bounds: { x: 24, y: 50, width: 100, height: 32 } },
    { role: 'StaticText', name: '标签文字', bounds: null }
  ] }
  const result = parseToolResult({ content: [{ type: 'text', text: JSON.stringify(JSON.stringify(input)) }] })
  expect(result.browserSnapshots?.[0].elements).toEqual(input.elements)
  expect(result.browserSnapshots?.[0].text).toBe(input.text)
})

test('layout changes remain distinct snapshots even when names and page text match', () => {
  const before = { ...snapshot(), elements: [{ role: 'button', name: '登录', bounds: { x: 10, y: 20, width: 100, height: 32 } }] }
  const after = { ...before, elements: [{ ...before.elements[0], bounds: { x: 10, y: 50, width: 100, height: 32 } }] }
  expect(parseToolResult([before, after]).browserSnapshots?.map(item => item.elements[0].bounds?.y)).toEqual([20, 50])
})

for (const [name, invalid] of [
  ['missing tab', { text: 'page', elements: [] }],
  ['missing title', { tab: { url: 'https://example.test' }, text: 'page', elements: [] }],
  ['missing text', { tab: { title: 'page', url: 'https://example.test' }, elements: [] }],
  ['non-array elements', { ...snapshot(), elements: {} }],
  ['missing role', { ...snapshot(), elements: [{ name: 'login' }] }],
  ['empty role', { ...snapshot(), elements: [{ role: ' ', name: '' }] }],
  ['numeric name', { ...snapshot(), elements: [{ role: 'button', name: 123 }] }],
  ['object value', { ...snapshot(), elements: [{ role: 'textbox', name: '', value: { html: '<script>' } }] }],
  ['numeric ref', { ...snapshot(), elements: [{ role: 'button', name: '', ref: 1 }] }],
  ['invalid loading flag', { ...snapshot(), tab: { ...snapshot().tab, loading: 'false' } }],
  ['invalid truncated flag', { ...snapshot(), truncated: 'false' }],
  ['non-positive viewport', { ...snapshot(), viewport: { width: 0, height: 720 } }]
] as const) {
  test(`malformed ${name} remains plain text with no browser view`, () => {
    expect(parseBrowserSnapshot(invalid)).toBeNull()
    const text = JSON.stringify(invalid)
    expect(parseToolResult(text)).toEqual({ images: [], text })
  })
}

test('one malformed element prevents a misleading partial snapshot', () => {
  expect(parseBrowserSnapshot({ ...snapshot(), elements: [...snapshot().elements, null] })).toBeNull()
  expect(parseBrowserSnapshot({ ...snapshot(), viewport: { width: Infinity, height: 720 } })).toBeNull()
})

test('HTML, URLs and unknown element roles stay literal data', () => {
  const input = {
    ...snapshot(), tab: { title: '<script>alert(1)</script>', url: 'javascript:alert(1)' },
    text: '<img src="https://outside.test/track" onerror="alert(1)">',
    elements: [{ role: 'custom-widget', name: '<button onclick="alert(1)">', value: 'https://outside.test' }]
  }
  expect(parseBrowserSnapshot(input)).toMatchObject({ title: input.tab.title, url: input.tab.url, text: input.text, elements: input.elements })
  expect(browserElementRoleLabel('custom-widget')).toBe('custom-widget')
})

test('ordinary text, tab lists and screenshot metadata do not gain optional snapshot fields', () => {
  for (const value of ['plain output', JSON.stringify({ tabs: [snapshot().tab] }), JSON.stringify({ tab: snapshot().tab, width: 10, height: 10 })]) {
    expect(parseToolResult(value)).toEqual({ images: [], text: value })
  }
})

test('cycle and nesting guards continue to protect browser extraction', () => {
  const cyclic: Record<string, unknown> = { output: snapshot() }
  cyclic.self = cyclic
  const result = parseToolResult(cyclic)
  expect(result.browserSnapshots).toHaveLength(1)
  expect(result.text).toContain('[循环引用]')
  let deep: unknown = snapshot()
  for (let i = 0; i < 40; i++) deep = { output: deep }
  expect(parseToolResult(deep).browserSnapshots).toBeUndefined()
})

test('common Chromium AX roles map to Chinese without prototype-name collisions', () => {
  for (const [role, label] of [
    ['RootWebArea', '页面'], ['StaticText', '文本'], ['InlineTextBox', '行内文本'], ['LabelText', '标签'],
    ['textbox', '输入框'], ['textField', '输入框'], ['button', '按钮'], ['link', '链接'],
    ['checkbox', '复选框'], ['combobox', '组合框'], ['gridcell', '网格单元格'], ['progressbar', '进度条']
  ]) expect(browserElementRoleLabel(role)).toBe(label)
  expect(browserElementRoleLabel('__proto__')).toBe('__proto__')
  expect(browserElementRoleLabel('constructor')).toBe('constructor')
})
