/** VS Code 风格设置注册表：作用域筛选与搜索语法必须保持可组合。 */
import { test, expect } from '@playwright/test'
import { registerSettings, searchSettings } from '../src/renderer/src/contrib/settings/settings-registry'

test('设置 ID 搜索只返回对应注册项', () => {
  expect(searchSettings('@id:editor.fontSize')).toEqual([
    expect.objectContaining({ key: 'editor.fontSize' })
  ])
})

test('设置标签搜索支持终端相关项', () => {
  const keys = searchSettings('@tag:terminal').map((setting) => setting.key)
  expect(keys).toEqual(expect.arrayContaining([
    'terminal.integrated.fontFamily',
    'terminal.integrated.fontSize',
    'terminal.integrated.lineHeight',
    'terminal.integrated.cursorBlinking',
    'terminal.integrated.scrollback'
  ]))
})

test('已修改筛选可以和普通文本组合', () => {
  const modified = new Set(['editor.fontSize'])
  expect(searchSettings('字体 @modified', 'user', modified).map((setting) => setting.key)).toEqual(['editor.fontSize'])
})

test('工作区作用域只暴露真正支持工作区存储的排除规则', () => {
  expect(searchSettings('', 'workspace')).toEqual([])
  const files = searchSettings('排除', 'workspace').map((setting) => setting.key)
  expect(files).toEqual(['files.exclude', 'search.exclude'])
})

test('扩展可以动态注册并移除设置元数据', () => {
  const dispose = registerSettings({
    key: 'demo.preview.enabled',
    label: '预览功能',
    description: '测试扩展设置',
    section: 'workbench',
    category: '扩展 / Demo',
    scope: 'user',
    keywords: ['demo', '预览']
  })
  expect(searchSettings('demo')).toEqual([
    expect.objectContaining({ key: 'demo.preview.enabled' })
  ])
  dispose()
  expect(searchSettings('demo')).toEqual([])
})
