/**
 * 模型列表共享状态
 *
 * 模型列表同时被「输入框旁的快捷选择器」和「模型管理页」使用，
 * 放在模块级 store 里可以避免两处各自请求、以及增删后的状态不同步。
 *
 * 变更操作（增/删/改）成功后自动重新拉取，保证两个入口看到同一份数据。
 */
import { useSyncExternalStore } from 'react'
import {
  createModel,
  deleteModel,
  listModels,
  type CreateModelInput,
  type EngineModel
} from './models'

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

/** 拉取模型列表。并发调用会被合并，避免重复请求。 */
let inflight: Promise<void> | null = null

export function refreshModels(): Promise<void> {
  if (inflight) return inflight

  setState({ loading: true, error: null })
  inflight = listModels()
    .then((models) => setState({ models, loading: false, loaded: true, error: null }))
    .catch((err: unknown) => {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      })
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** 引擎重启或首次就绪后，之前的列表可能已失效 */
export function resetModelStore(): void {
  setState({ models: [], loading: false, error: null, loaded: false })
}

export async function addModel(input: CreateModelInput): Promise<EngineModel> {
  const created = await createModel(input)
  await refreshModels()
  return created
}

export async function removeModel(id: string): Promise<void> {
  await deleteModel(id)
  await refreshModels()
}

/** 订阅模型列表状态（store 内部整体替换 state，引用稳定可作快照） */
export function useModels(): ModelStoreState & { refresh: () => Promise<void> } {
  const snapshot = useSyncExternalStore(onModelStateChanged, getModelState)
  return { ...snapshot, refresh: refreshModels }
}
