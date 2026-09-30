/** 编辑设置的存储兼容、坏值恢复与 Monaco 适配；纯函数，不启动 Electron。 */
import { expect, test } from '@playwright/test'
import {
  DEFAULT_EDITOR_DISPLAY_OPTIONS,
  normalizeEditorDisplayOptions,
  parseEditorDisplayOptions,
  toMonacoEditorOptions
} from '../src/renderer/src/core/editor/editor-display-options'

test('损坏的设置存储不影响默认编辑器启动', () => {
  for (const serialized of [null, '', '{bad json', 'null', '[]', '42']) {
    expect(parseEditorDisplayOptions(serialized)).toEqual(DEFAULT_EDITOR_DISPLAY_OPTIONS)
  }
})

test('恢复旧版仅换行和小地图的偏好时补齐新增字段', () => {
  expect(parseEditorDisplayOptions('{"wordWrap":"on","minimapEnabled":false}')).toEqual({
    ...DEFAULT_EDITOR_DISPLAY_OPTIONS,
    wordWrap: 'on',
    minimapEnabled: false
  })
})

test('外部无效值不能生成重叠行高或不可用的 Monaco 参数', () => {
  expect(normalizeEditorDisplayOptions({
    fontFamily: '   ', fontSize: 500, lineHeight: -10, fontLigatures: 'false',
    tabSize: 0, wordWrap: 'invalid', minimapEnabled: 'false'
  })).toEqual({
    ...DEFAULT_EDITOR_DISPLAY_OPTIONS,
    fontSize: 32,
    lineHeight: 32,
    tabSize: 1
  })
  expect(normalizeEditorDisplayOptions({ fontSize: Number.NaN, tabSize: Number.POSITIVE_INFINITY }))
    .toEqual(DEFAULT_EDITOR_DISPLAY_OPTIONS)
})

test('用户偏好经过 JSON 落盘恢复后所有字段都映射到 Monaco', () => {
  const input = {
    fontFamily: 'Fira Code, monospace', fontSize: 17, lineHeight: 26,
    fontLigatures: true, tabSize: 4, wordWrap: 'on', minimapEnabled: false
  }
  const restored = parseEditorDisplayOptions(JSON.stringify(input))
  expect(restored).toEqual(input)
  expect(toMonacoEditorOptions(restored)).toEqual({
    fontFamily: input.fontFamily,
    fontSize: 17,
    lineHeight: 26,
    fontLigatures: true,
    tabSize: 4,
    wordWrap: 'on',
    minimap: { enabled: false, maxColumn: 80 }
  })
})
