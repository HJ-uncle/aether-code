/** D1 pure form patch semantics; no Electron or provider requests. */
import { expect, test } from '@playwright/test'
import {
  buildModelUpdate,
  initialModelForm,
  newModelOverrides
} from '../src/renderer/src/core/engine/model-form'
import type { EngineModel } from '../src/renderer/src/core/engine/models'

function model(
  overrides: EngineModel['capabilityOverrides'] = {
    vision: false,
    thinking: true,
    contextWindow: 123456,
    parallelTools: false
  }
): EngineModel {
  return {
    id: 'fixture',
    tenantId: 'default',
    provider: 'openai',
    modelId: 'gpt-4o',
    apiKey: '...1234',
    baseUrl: 'https://example.com/v1',
    displayName: 'Before',
    isEnabled: true,
    createdAt: 1,
    updatedAt: 1,
    capabilityOverrides: overrides,
    resolvedCapabilities: {
      vision: true,
      thinking: true,
      toolCalling: true,
      contextWindow: 128000
    },
    capabilities: { vision: true, thinking: true, toolCalling: true, contextWindow: 128000 }
  }
}

test('改名只发送名称，不发送resolved能力或未改动的连接配置', () => {
  const item = model()
  const form = { ...initialModelForm(item), displayName: 'After' }
  expect(buildModelUpdate(item, form)).toEqual({ displayName: 'After' })
})
test('初始开关反映人工覆盖，不把自动能力当成人工设置', () => {
  expect(initialModelForm(model(null))).toMatchObject({ vision: null, thinking: null })
  expect(initialModelForm(model())).toMatchObject({ vision: false, thinking: true, apiKey: '' })
})
test('只改单项时保留其他覆盖；显式false不变成null或省略', () => {
  const item = model()
  expect(buildModelUpdate(item, { ...initialModelForm(item), thinking: false })).toEqual({
    capabilityOverrides: { thinking: false }
  })
  expect(buildModelUpdate(item, { ...initialModelForm(item), vision: true })).toEqual({
    capabilityOverrides: { vision: true }
  })
})
test('恢复默认发送单项null；没有变动时完全不写capabilityOverrides', () => {
  const item = model()
  expect(buildModelUpdate(item, { ...initialModelForm(item), vision: null })).toEqual({
    capabilityOverrides: { vision: null }
  })
  expect(buildModelUpdate(item, initialModelForm(item))).toEqual({})
})
test('清空显示名称仍发送空串；空密钥和脱敏串不从模型拷回', () => {
  const item = model()
  expect(buildModelUpdate(item, { ...initialModelForm(item), displayName: '' })).toEqual({
    displayName: ''
  })
  expect(
    buildModelUpdate(item, { ...initialModelForm(item), apiKey: 'synthetic-replacement-key' })
  ).toEqual({ apiKey: 'synthetic-replacement-key' })
})
test('新增模型默认 256 K，清空后仍可交给引擎推断', () => {
  const form = initialModelForm()
  expect(form.contextWindow).toBe('256')
  expect(newModelOverrides(form)).toEqual({ contextWindow: 256000 })
  expect(newModelOverrides({ ...form, vision: false })).toEqual({ vision: false, contextWindow: 256000 })
  expect(newModelOverrides({ ...form, contextWindow: '' })).toBeUndefined()
})

test('新建默认值不覆盖已有模型的自动识别或自定义窗口', () => {
  const automatic = model(null)
  expect(initialModelForm(automatic).contextWindow).toBe('')
  expect(buildModelUpdate(automatic, initialModelForm(automatic))).toEqual({})
  const custom = model({ contextWindow: 123456 })
  expect(initialModelForm(custom).contextWindow).toBe('123.456')
  expect(buildModelUpdate(custom, initialModelForm(custom))).toEqual({})
})

test('API 格式新建和旧记录缺省自动识别，明确格式编辑保持原值', () => {
  expect(initialModelForm().apiFormat).toBe('auto')
  const legacy = model()
  expect(initialModelForm(legacy).apiFormat).toBe('auto')
  expect(buildModelUpdate(legacy, initialModelForm(legacy))).toEqual({})
  for (const apiFormat of ['openai', 'anthropic'] as const) {
    const explicit: EngineModel = { ...legacy, apiFormat }
    expect(initialModelForm(explicit).apiFormat).toBe(apiFormat)
    expect(buildModelUpdate(explicit, initialModelForm(explicit))).toEqual({})
    expect(buildModelUpdate(explicit, { ...initialModelForm(explicit), apiFormat: 'auto' })).toEqual({ apiFormat: 'auto' })
  }
})

test('API 格式只在修改时提交，手选 OpenAI 不被服务商或地址后缀覆盖', () => {
  const item: EngineModel = { ...model(), provider: 'anthropic', baseUrl: 'https://example.com/anthropic', apiFormat: 'anthropic' }
  expect(buildModelUpdate(item, { ...initialModelForm(item), apiFormat: 'openai' })).toEqual({ apiFormat: 'openai' })
  expect(buildModelUpdate(model(), { ...initialModelForm(model()), apiFormat: 'anthropic' })).toEqual({ apiFormat: 'anthropic' })
})

test('小数 K 无损换算为整数 token，并保留最大安全整数配置', () => {
  const form = initialModelForm()
  expect(newModelOverrides({ ...form, contextWindow: '123.456' })).toEqual({ contextWindow: 123456 })
  expect(newModelOverrides({ ...form, contextWindow: '0.001' })).toEqual({ contextWindow: 1 })
  expect(newModelOverrides({ ...form, contextWindow: '128.000' })).toEqual({ contextWindow: 128000 })
  const largest = model({ contextWindow: Number.MAX_SAFE_INTEGER })
  expect(buildModelUpdate(largest, initialModelForm(largest))).toEqual({})
})

test('无效 K 不可发出 fractional、零或不安全 token，留空仍恢复默认', () => {
  const form = initialModelForm()
  for (const contextWindow of ['0', '-1', '0.0001', '128.1234', 'Infinity', '1e3', '9007199254741']) {
    expect(() => newModelOverrides({ ...form, contextWindow })).toThrow('上下文窗口')
  }
  expect(buildModelUpdate(model(), { ...initialModelForm(model()), contextWindow: '' })).toEqual({ capabilityOverrides: { contextWindow: null } })
})
