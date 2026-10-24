/** New duplicate-save contract: provider-scoped identity, typed API conflicts,
 * legacy SQLite redaction and no automatic credential overwrite. No Electron. */
import { expect, test } from '@playwright/test'
import { findModelConflict, initialModelForm, buildModelUpdate } from '../src/renderer/src/core/engine/model-form'
import { MODEL_CONFLICT_MESSAGE, ModelAlreadyExistsError, modelSaveError } from '../src/renderer/src/core/engine/model-save-error'
import { createModel, type EngineModel } from '../src/renderer/src/core/engine/models'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'

const existing: EngineModel = {
  id: 'saved-id', tenantId: 'fixture', provider: 'deepseek', modelId: 'same-model',
  displayName: 'Saved display name', apiKey: '...inal', baseUrl: 'https://example.com/original',
  isEnabled: true, createdAt: 1, updatedAt: 1
}

test('相同服务商和模型 ID 构成冲突，地址或显示名不能绕过；不同服务商与大小写不误拦', () => {
  expect(findModelConflict([existing], { provider: 'deepseek', modelId: ' same-model ' })).toBe(existing)
  expect(findModelConflict([existing], { provider: 'openai', modelId: 'same-model' })).toBeUndefined()
  expect(findModelConflict([existing], { provider: 'deepseek', modelId: 'Same-Model' })).toBeUndefined()
  expect(findModelConflict([existing], { provider: 'deepseek', modelId: ' ' })).toBeUndefined()
})

test('编辑已有记录排除自身；打开已有配置不会携带失败草稿密钥', () => {
  expect(findModelConflict([existing], existing, existing.id)).toBeUndefined()
  const edit = initialModelForm(existing)
  expect(edit).toMatchObject({ modelId: 'same-model', apiKey: '', baseUrl: existing.baseUrl })
  expect(buildModelUpdate(existing, { ...edit, displayName: 'Explicit edit' })).toEqual({ displayName: 'Explicit edit' })
})

test('HTTP 409 和业务码 40901 均保留模型冲突恢复身份', () => {
  for (const code of [409, 40901]) {
    const error = modelSaveError({ code, message: 'server text', data: { reason: 'MODEL_ALREADY_EXISTS', existingModelId: existing.id } }, 'fallback')
    expect(error).toBeInstanceOf(ModelAlreadyExistsError)
    expect(error).toMatchObject({ existingModelId: existing.id, message: MODEL_CONFLICT_MESSAGE })
  }
  expect(modelSaveError({ code: 40901, message: '', data: null }, 'fallback')).toBeInstanceOf(ModelAlreadyExistsError)
})

test('旧引擎同一唯一约束转为可行动提示，其他 SQLite 错误安全显示', () => {
  const conflict = modelSaveError({ code: 500, message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: models.tenant_id, models.provider, models.model_id', data: null }, '保存失败')
  expect(conflict).toBeInstanceOf(ModelAlreadyExistsError)
  expect(conflict.message).not.toMatch(/SQLITE|models\./)
  const other = modelSaveError({ code: 500, message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: models.id', data: null }, '保存失败')
  expect(other).not.toBeInstanceOf(ModelAlreadyExistsError)
  expect(other.message).toBe('保存失败')
})

test('其他 409 不冒充重复模型；恢复 ID 的非字符串值不会用于导航', () => {
  const other = modelSaveError({ code: 409, message: '配置版本已更新，请刷新', data: { reason: 'REVISION_CONFLICT' } }, 'fallback')
  expect(other).not.toBeInstanceOf(ModelAlreadyExistsError)
  expect(other.message).toBe('配置版本已更新，请刷新')
  expect(modelSaveError({ code: 409, message: '', data: { reason: 'MODEL_ALREADY_EXISTS', existingModelId: 123 } }, 'fallback'))
    .toMatchObject({ existingModelId: undefined })
})

test('真实 create 客户端遇到冲突只发一次 POST，不自动 PUT 或覆盖旧密钥', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const requests: EngineRequestInput[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    aether: { engine: { request: async (input: EngineRequestInput): Promise<EngineRequestResult<unknown>> => {
      requests.push(input)
      return { ok: false, code: 409, message: 'duplicate', data: { reason: 'MODEL_ALREADY_EXISTS', existingModelId: existing.id } }
    } } }
  } })
  try {
    await expect(createModel({ provider: existing.provider, modelId: existing.modelId,
      baseUrl: 'https://example.com/attempt', apiKey: 'synthetic-attempted-new-key' })).rejects.toBeInstanceOf(ModelAlreadyExistsError)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/models' })
    expect(existing.apiKey).toBe('...inal')
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
