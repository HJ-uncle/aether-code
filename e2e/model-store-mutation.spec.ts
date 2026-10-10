/** Pure controlled IPC contracts: model saves invalidate stale reads and retain engine-source ownership. No Electron. */
import { expect, test } from '@playwright/test'
import type { EngineRequestInput, EngineRequestResult } from '../src/shared/ipc'
import type { EngineModel } from '../src/renderer/src/core/engine/models'
import {
  addModel,
  getModelState,
  refreshModels,
  removeModel,
  resetModelStore,
  saveModel
} from '../src/renderer/src/core/engine/model-store'
import { publishEngineSource } from '../src/renderer/src/core/engine/source'

interface PendingRequest {
  input: EngineRequestInput
  resolve: (value: EngineRequestResult<unknown>) => void
}
let pending: PendingRequest[] = []
let fixtureSequence = 0
const ready = (name: string) => ({ mode: 'remote' as const, baseUrl: 'http://' + name + ':12323', instanceId: name, phase: 'ready' as const })
const ok = (data: unknown): EngineRequestResult<unknown> => ({ ok: true, code: 200, message: '', data })
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function model(id = 'same-model', contextWindow = 1_000_000): EngineModel {
  return {
    id, tenantId: 'default', modelId: id, provider: 'openai', apiKey: '...test',
    baseUrl: 'https://example.com/v1', isEnabled: true, createdAt: 1, updatedAt: 1,
    capabilityOverrides: { contextWindow }, capabilities: { contextWindow }, resolvedCapabilities: { contextWindow }
  }
}
function reply(index: number, data: unknown): void {
  const request = pending[index]
  if (!request) throw new Error('Missing controlled request ' + index)
  request.resolve(ok(data))
}
async function seed(models = [model()]): Promise<void> {
  const loading = refreshModels()
  reply(0, models)
  await loading
  pending = []
}

test.describe.serial('模型共享store写操作同步', () => {
  test.beforeEach(() => {
    pending = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      aether: { engine: { request: (input: EngineRequestInput) => new Promise<EngineRequestResult<unknown>>(resolve => pending.push({ input, resolve })) } }
    } })
    publishEngineSource(ready('model-mutation-' + ++fixtureSequence))
    resetModelStore()
  })
  test.afterEach(() => resetModelStore())

  test('保存128K立即发布PUT结果，旧GET不能覆盖，随后必须发起新GET', async () => {
    await seed()
    const oldRead = refreshModels()
    const saving = saveModel('same-model', { capabilityOverrides: { contextWindow: 128_000 } })
    expect(pending[1].input).toMatchObject({ method: 'PUT', path: '/models/same-model', body: { capabilityOverrides: { contextWindow: 128_000 } } })
    const saved = model('same-model', 128_000)
    reply(1, saved)
    await settle()
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(128_000)
    expect(pending.map(item => item.input.method)).toEqual(['GET', 'PUT', 'GET'])
    const freshRead = refreshModels()
    expect(pending).toHaveLength(3)
    reply(0, [model()])
    await oldRead
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(128_000)
    reply(2, [saved])
    expect(await saving).toEqual(saved)
    await freshRead
    expect(getModelState()).toMatchObject({ loaded: true, loading: false, error: null, models: [saved] })
  })

  test('清空人工窗口立即使用保存结果的推断能力，刷新失败保留已成功保存值并报告错误', async () => {
    await seed([model('same-model', 128_000)])
    const saving = saveModel('same-model', { capabilityOverrides: { contextWindow: null } })
    const saved = { ...model(), capabilityOverrides: null }
    reply(0, saved)
    await settle()
    expect(getModelState().models[0]).toEqual(saved)
    pending[1].resolve({ ok: false, code: 503, message: 'controlled refresh failure' })
    expect(await saving).toEqual(saved)
    expect(getModelState()).toMatchObject({ models: [saved], loading: false, error: 'controlled refresh failure' })
  })

  test('并发同模型旧PUT晚回不能回退新值，旧GET也不能覆盖最后权威GET', async () => {
    await seed()
    const first = saveModel('same-model', { capabilityOverrides: { contextWindow: 128_000 } })
    const second = saveModel('same-model', { capabilityOverrides: { contextWindow: 256_000 } })
    reply(1, model('same-model', 256_000))
    await settle()
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(256_000)
    reply(0, model('same-model', 128_000))
    await settle()
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(256_000)
    expect(pending.map(item => item.input.method)).toEqual(['PUT', 'PUT', 'GET', 'GET'])
    reply(2, [model('same-model', 128_000)])
    await settle()
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(256_000)
    // The final authoritative backend state may differ from optimistic echoes.
    reply(3, [model('same-model', 192_000)])
    await Promise.all([first, second])
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(192_000)
  })

  test('并发不同模型写入保留两份立即更新，较早列表请求失效', async () => {
    await seed([model('a'), model('b')])
    const first = saveModel('a', { capabilityOverrides: { contextWindow: 128_000 } })
    const second = saveModel('b', { capabilityOverrides: { contextWindow: 256_000 } })
    reply(0, model('a', 128_000))
    await settle()
    reply(1, model('b', 256_000))
    await settle()
    expect(getModelState().models.map(item => item.capabilities?.contextWindow)).toEqual([128_000, 256_000])
    reply(2, [model('a', 128_000), model('b')])
    await settle()
    expect(getModelState().models.map(item => item.capabilities?.contextWindow)).toEqual([128_000, 256_000])
    reply(3, [model('a', 128_000), model('b', 256_000)])
    await Promise.all([first, second])
  })

  test('新增模型立即加入列表且旧GET不能抹掉新增项', async () => {
    await seed([])
    const oldRead = refreshModels()
    const adding = addModel({ provider: 'openai', modelId: 'new-model', baseUrl: 'https://example.com/v1', apiKey: 'synthetic-no-provider-key' })
    const created = model('new-model', 128_000)
    reply(1, created)
    await settle()
    expect(getModelState().models).toEqual([created])
    reply(0, [])
    await oldRead
    expect(getModelState().models).toEqual([created])
    reply(2, [created])
    expect(await adding).toEqual(created)
  })

  test('删除立即移除模型且保存前旧GET不能恢复已删除项', async () => {
    await seed()
    const oldRead = refreshModels()
    const removing = removeModel('same-model')
    reply(1, null)
    await settle()
    expect(getModelState().models).toEqual([])
    reply(0, [model()])
    await oldRead
    expect(getModelState().models).toEqual([])
    reply(2, [])
    await removing
  })

  test('重置同一来源后迟到PUT不能串入重新加载的模型列表', async () => {
    await seed()
    const saving = saveModel('same-model', { capabilityOverrides: { contextWindow: 128_000 } })
    const rejected = expect(saving).rejects.toThrow('引擎连接已变化')
    resetModelStore()
    const freshRead = refreshModels()
    reply(1, [model('fresh-model', 256_000)])
    await freshRead
    reply(0, model('same-model', 128_000))
    await rejected
    expect(pending).toHaveLength(2)
    expect(getModelState().models.map(item => item.id)).toEqual(['fresh-model'])
  })

  test('切换引擎后迟到PUT及DELETE响应都不能改变新来源', async () => {
    await seed()
    const saving = saveModel('same-model', { capabilityOverrides: { contextWindow: 128_000 } })
    const removing = removeModel('same-model')
    const rejectedSave = expect(saving).rejects.toThrow('引擎连接已变化')
    const rejectedDelete = expect(removing).rejects.toThrow('引擎连接已变化')
    publishEngineSource(ready('new-engine'))
    resetModelStore()
    const freshRead = refreshModels()
    expect(pending[2].input.expectedEngine?.baseUrl).toBe('http://new-engine:12323')
    reply(2, [model('new-source', 256_000)])
    await freshRead
    reply(0, model('same-model', 128_000))
    reply(1, null)
    await Promise.all([rejectedSave, rejectedDelete])
    expect(pending).toHaveLength(3)
    expect(getModelState().models.map(item => item.id)).toEqual(['new-source'])
  })

  test('切换来源后迟到POST不会把自动启用PUT发到新引擎', async () => {
    const adding = addModel({ provider: 'openai', modelId: 'new-model', baseUrl: 'https://example.com/v1', apiKey: 'synthetic-no-provider-key' })
    const rejected = expect(adding).rejects.toThrow('引擎连接已变化')
    publishEngineSource(ready('new-after-create'))
    resetModelStore()
    const loading = refreshModels()
    reply(1, [model('new-source')])
    await loading
    reply(0, { ...model('late-created'), isEnabled: false })
    await rejected
    expect(pending.map(item => item.input.method)).toEqual(['POST', 'GET'])
    expect(getModelState().models.map(item => item.id)).toEqual(['new-source'])
  })

  test('自动启用使用与POST相同的expectedEngine，完成后新增共享列表', async () => {
    const adding = addModel({ provider: 'openai', modelId: 'new-model', baseUrl: 'https://example.com/v1', apiKey: 'synthetic-no-provider-key' })
    const created = model('new-model', 128_000)
    reply(0, { ...created, isEnabled: false })
    await settle()
    expect(pending[1].input).toMatchObject({ method: 'PUT', path: '/models/new-model', body: { isEnabled: true }, expectedEngine: pending[0].input.expectedEngine })
    reply(1, created)
    await settle()
    expect(getModelState().models).toEqual([created])
    reply(2, [created])
    expect(await adding).toEqual(created)
  })

  test('保存成功但权威刷新未完成时重置，旧结果不能覆盖新列表或回调成功', async () => {
    await seed()
    const saving = saveModel('same-model', { capabilityOverrides: { contextWindow: 128_000 } })
    const rejected = expect(saving).rejects.toThrow('引擎连接已变化')
    reply(0, model('same-model', 128_000))
    await settle()
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(128_000)
    resetModelStore()
    const reloaded = refreshModels()
    reply(2, [model('after-reset', 256_000)])
    await reloaded
    reply(1, [model('same-model', 128_000)])
    await rejected
    expect(getModelState().models.map(item => item.id)).toEqual(['after-reset'])
  })

  test('来源变化即使重置尚未执行也拒绝迟到mutation，不能发跨源刷新', async () => {
    await seed()
    const saving = saveModel('same-model', { capabilityOverrides: { contextWindow: 128_000 } })
    const rejected = expect(saving).rejects.toThrow('引擎连接已变化')
    publishEngineSource(ready('changed-before-reset'))
    reply(0, model('same-model', 128_000))
    await rejected
    expect(pending).toHaveLength(1)
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(1_000_000)
  })

  test('来源变化即使重置尚未执行，新读取不复用旧GET且旧GET不能覆盖', async () => {
    const oldRead = refreshModels()
    publishEngineSource(ready('new-read-source'))
    const newRead = refreshModels()
    expect(newRead).not.toBe(oldRead)
    expect(pending).toHaveLength(2)
    reply(0, [model('old-source')])
    await oldRead
    expect(getModelState().models).toEqual([])
    expect(refreshModels()).toBe(newRead)
    reply(1, [model('new-source')])
    await newRead
    expect(getModelState().models.map(item => item.id)).toEqual(['new-source'])
  })
  test('失败PUT保留原模型及在途读取，不虚构成功修改', async () => {
    await seed()
    const read = refreshModels()
    const saving = saveModel('same-model', { capabilityOverrides: { contextWindow: 128_000 } })
    const rejected = expect(saving).rejects.toThrow('controlled write failure')
    pending[1].resolve({ ok: false, code: 400, message: 'controlled write failure' })
    await rejected
    expect(refreshModels()).toBe(read)
    expect(getModelState().models[0].capabilities?.contextWindow).toBe(1_000_000)
    reply(0, [model()])
    await read
    expect(pending).toHaveLength(2)
  })
})
