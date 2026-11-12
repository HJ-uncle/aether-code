import { expect, test } from '@playwright/test'
import type { PluginTool } from '../src/renderer/src/core/engine/plugins'
import { parsePluginForm, pluginFormDefaults, pluginFormFields, pluginResultHeadlineKey, pluginResultTable, pluginToolTitle, pluginValueText } from '../src/renderer/src/features/plugins/plugin-form'
import { remoteRequestError } from '../src/main/engine/protocol'

const tool: PluginTool = { name: 'convert', description: '示例工具', entry: 'main.mjs', inputSchema: { type: 'object', properties: {
  optional: { type: 'boolean' }, amount: { type: 'number', title: '金额', minimum: 0 }, from: { type: 'string', enum: ['USD', 'CNY'] },
  count: { type: 'integer', maximum: 9 }, rate: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 }, text: { type: 'string', minLength: 2 }, rates: { type: 'object' }, targets: { type: 'array' },
}, required: ['amount', 'from'] } }

test('native fields preserve schema labels, enum types, required ordering and examples', () => {
  const fields = pluginFormFields(tool), values = pluginFormDefaults(fields, { amount: 100, from: 'CNY', rates: { USD: 1 } })
  expect(fields.slice(0, 2).map(field => field.key)).toEqual(['amount', 'from'])
  expect(fields[0].label).toBe('金额')
  expect(fields.find(field => field.key === 'rates')?.kind).toBe('json')
  expect(parsePluginForm(fields, values)).toEqual({ args: { amount: 100, from: 'CNY', rates: { USD: 1 } }, errors: {} })
  expect(values.optional).toBe('')
  expect(pluginToolTitle({ ...tool, inputSchema: { ...tool.inputSchema, title: '单笔换算' } })).toBe('单笔换算')
  expect(pluginToolTitle({ ...tool, inputSchema: { ...tool.inputSchema, title: '   ' } })).toBe('convert')
  expect(pluginToolTitle(tool)).toBe('convert')
})

test('zero, negative bounds, integer, invalid enum and JSON errors remain beside the offending field', () => {
  const fields = pluginFormFields(tool), values = pluginFormDefaults(fields)
  expect(parsePluginForm(fields, { ...values, amount: '0' }).args.amount).toBe(0)
  expect(parsePluginForm(fields, { ...values, amount: '-1' }).errors.amount).toContain('不能小于')
  expect(parsePluginForm(fields, { ...values, amount: ' ' }).errors.amount).toContain('有效数字')
  expect(parsePluginForm(fields, { ...values, amount: 'Infinity' }).errors.amount).toContain('有效数字')
  expect(parsePluginForm(fields, { ...values, count: '1.5' }).errors.count).toContain('整数')
  expect(parsePluginForm(fields, { ...values, count: '10' }).errors.count).toContain('不能大于')
  expect(parsePluginForm(fields, { ...values, rate: '0' }).errors.rate).toContain('必须大于')
  expect(parsePluginForm(fields, { ...values, rate: '10' }).errors.rate).toContain('必须小于')
  expect(parsePluginForm(fields, { ...values, from: '"XXX"' }).errors.from).toContain('可用选项')
  expect(parsePluginForm(fields, { ...values, rates: '{broken' }).errors.rates).toContain('JSON')
  expect(parsePluginForm(fields, { ...values, targets: '{}' }).errors.targets).toContain('数组')
})

test('booleans, numeric enums, empty required strings and Unicode lengths preserve business types', () => {
  const fields = pluginFormFields({ ...tool, inputSchema: { type: 'object', properties: { boolean: { type: 'boolean' }, level: { type: 'integer', enum: [0, 1] }, text: { type: 'string' }, emoji: { type: 'string', minLength: 2 } }, required: ['text'] } })
  const result = parsePluginForm(fields, { text: '', boolean: 'false', level: '0', emoji: '🌟🌟' })
  expect(result).toEqual({ args: { text: '', boolean: false, level: 0, emoji: '🌟🌟' }, errors: {} })
  expect(parsePluginForm(fields, { emoji: '🌟' }).errors.emoji).toContain('至少')
})

test('result tables retain exact values without interpreting result error fields as platform failures', () => {
  const table = pluginResultTable([{ to: 'CNY', result: 467.11 }, { to: 'USD', result: 65.79 }])
  expect(table).toEqual({ columns: ['to', 'result'], rows: [{ to: 'CNY', result: 467.11 }, { to: 'USD', result: 65.79 }], total: 2 })
  expect(pluginResultTable([1, 2])).toBeNull()
  expect(pluginValueText(0)).toBe('0')
  expect(pluginValueText(false)).toBe('否')
  expect(pluginValueText({ error: 'business value' })).toContain('business value')
  const rows = [{ rate: 0.04671053, rateText: '0.046711', result: 467.11, resultText: '467.11 CNY' }]
  expect(pluginResultTable(rows)?.columns).toEqual(['rateText', 'resultText'])
  expect(pluginResultTable([...rows, { rate: 1, result: 2 }])?.columns).toEqual(['rate', 'rateText', 'result', 'resultText'])
  expect(pluginResultHeadlineKey({ unit: '10,000 JPY 兑换', rows })).toBe('unit')
  expect(pluginResultHeadlineKey({ unit: 'kg', amount: 2 })).toBeUndefined()
  expect(pluginResultHeadlineKey({ formatted: 'preferred', unit: 'fallback', rows })).toBe('formatted')
})

test('remote runtime transport accepts only the view and exact invoke endpoint', () => {
  for (const [method, path] of [['GET', '/plugins/runtime/apps/currency-converter?revision=1'], ['POST', '/plugins/runtime/apps/currency-converter/invoke']]) expect(remoteRequestError('remote', method, path)).toBeNull()
  for (const [method, path] of [['POST', '/plugins/runtime/apps/currency-converter'], ['GET', '/plugins/runtime/apps/currency-converter/invoke'], ['PUT', '/plugins/runtime/apps/currency-converter'], ['POST', '/plugins/runtime/apps/currency-converter/private'], ['GET', '/plugins/runtime/apps']]) expect(remoteRequestError('remote', method, path)).not.toBeNull()
})
