/**
 * 模型列表共享状态
 *
 * 模型列表同时被「输入框旁的快捷选择器」和「模型管理页」使用。
 * 保存成功立即发布响应中的有效能力，再用新的列表请求同步服务端状态。
 */
import { useSyncExternalStore } from 'react'
import {
  createModel,
  deleteModel,
  listModels,
  updateModel,
  type CreateModelInput,
  type EngineModel,
  type UpdateModelInput
} from './models'
import { getEngineSource } from './source'

export interface ModelStoreState {
  models: EngineModel[]
  loading: boolean
  error: string | null
  /** 是否已成功拉取过至少一次 */
  loaded: boolean
}

let state: ModelStoreState = { models: [], loading: false, error: null, loaded: false }
const listeners = new Set<() => void>()

function setState(patch: Partial<ModelStoreState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function getModelState(): ModelStoreState {
  return state
}

export function onModelStateChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let inflight: Promise<void> | null = null
let inflightSource: number | null = null
// Reads expire after every successful write; mutations expire only on a reset
// or engine change, so concurrent successful writes can all be reconciled.
let generation = 0
let resetGeneration = 0
let mutationSequence = 0
const appliedMutations = new Map<string, number>()

function invalidateReads(): void {
  generation++
  inflight = null
  inflightSource = null
}

interface MutationScope {
  source: number
  reset: number
  sequence: number
}

function mutationScope(): MutationScope {
  return { source: getEngineSource(), reset: resetGeneration, sequence: ++mutationSequence }
}

function assertMutationScope(scope: MutationScope): void {
  if (scope.source !== getEngineSource() || scope.reset !== resetGeneration) {
    throw new Error('引擎连接已变化，请在当前会话重试')
  }
}

/** 拉取模型列表。同一来源的并发读取合并，但保存前的读取不能复用。 */
export function refreshModels(): Promise<void> {
  const source = getEngineSource()
  if (inflight && inflightSource === source) return inflight
  if (inflight) invalidateReads()

  const epoch = generation
  const reset = resetGeneration
  const current = (): boolean => epoch === generation && reset === resetGeneration && source === getEngineSource()
  setState({ loading: true, error: null })
  const request = listModels()
    .then((models) => { if (current()) setState({ models, loading: false, loaded: true, error: null }) })
    .catch((err: unknown) => {
      if (!current()) return
      setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      })
    })
    .finally(() => {
      if (inflight !== request) return
      inflight = null
      inflightSource = null
    })

  inflight = request
  inflightSource = source
  return request
}

/** 引擎重启或首次就绪后，之前的列表和未完成写操作的响应都已失效。 */
export function resetModelStore(): void {
  resetGeneration++
  invalidateReads()
  appliedMutations.clear()
  setState({ models: [], loading: false, error: null, loaded: false })
}

async function reconcileMutation(scope: MutationScope, id: string, model?: EngineModel): Promise<void> {
  assertMutationScope(scope)
  invalidateReads()
  // Responses from concurrent edits may arrive out of order. Never let an
  // older edit's optimistic echo undo a later edit; the fresh GET is authoritative.
  if (scope.sequence >= (appliedMutations.get(id) ?? 0)) {
    appliedMutations.set(id, scope.sequence)
    const models = model
      ? state.models.some(item => item.id === id)
        ? state.models.map(item => item.id === id ? model : item)
        : [...state.models, model]
      : state.models.filter(item => item.id !== id)
    setState({ models, error: null })
  }
  await refreshModels()
  assertMutationScope(scope)
}

export async function saveModel(id: string, patch: UpdateModelInput): Promise<EngineModel> {
  const scope = mutationScope()
  const updated = await updateModel(id, patch)
  await reconcileMutation(scope, id, updated)
  return updated
}

export async function addModel(input: CreateModelInput): Promise<EngineModel> {
  const scope = mutationScope()
  const created = await createModel(input)
  await reconcileMutation(scope, created.id, created)
  return created
}

export async function removeModel(id: string): Promise<void> {
  const scope = mutationScope()
  await deleteModel(id)
  await reconcileMutation(scope, id)
}

/** 订阅模型列表状态（store 内部整体替换 state，引用稳定可作快照） */
export function useModels(): ModelStoreState & { refresh: () => Promise<void> } {
  const snapshot = useSyncExternalStore(onModelStateChanged, getModelState)
  return { ...snapshot, refresh: refreshModels }
}
