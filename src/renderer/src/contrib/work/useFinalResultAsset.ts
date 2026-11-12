import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { FinalResult, FinalResultItem } from '@shared/final-result'
import { requestOrThrow } from '@renderer/core/engine/client'
import { assertEngineSource, getEngineSource, getExpectedEngine, subscribeEngineSource } from '@renderer/core/engine/source'
import { subscribeWorkPreview, workPreviewRevision } from '@renderer/core/workbench/preview-request'
import { decodeFinalResultAsset, MAX_FINAL_RESULT_ASSET_BYTES, type FinalResultAsset } from './final-result-asset'

interface CacheEntry { promise: Promise<FinalResultAsset>; size: number }
const cache = new Map<string, CacheEntry>()
const CACHE_BYTES = 64 * 1024 * 1024
let cacheSource = -1

function assetKey(result: FinalResult, item: FinalResultItem, source: number): string {
  return JSON.stringify([source, result.sessionId, result.turnId, result.runId, item.id, item.assetId, item.sha256, item.size, item.mimeType,
    workPreviewRevision(source, result.sessionId, item.path)])
}

export async function readFinalResultAsset(result: FinalResult, item: FinalResultItem, source = getEngineSource()): Promise<FinalResultAsset> {
  assertEngineSource(source)
  if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FINAL_RESULT_ASSET_BYTES) throw new Error('交付物大小无效或超过 32 MiB 读取上限')
  if (!result.items.some(candidate => candidate.id === item.id && candidate.assetId === item.assetId &&
    candidate.sha256 === item.sha256 && candidate.size === item.size && candidate.mimeType === item.mimeType)) throw new Error('交付物不属于本轮结果')
  if (cacheSource !== source) { cache.clear(); cacheSource = source }
  const key = assetKey(result, item, source)
  const assertFresh = (): void => {
    assertEngineSource(source)
    if (key !== assetKey(result, item, source)) throw new Error('成果状态已变化，请重新打开')
  }
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key); cache.set(key, cached)
    const asset = await cached.promise
    assertFresh()
    return asset
  }
  const expectedEngine = getExpectedEngine()
  const promise = (async () => {
    const response = await requestOrThrow<unknown>({ method: 'GET', path: '/conversation/result-asset',
      query: { sessionId: result.sessionId, runId: result.runId, assetId: item.assetId }, expectedEngine })
    assertEngineSource(source)
    const asset = await decodeFinalResultAsset(response, item)
    assertFresh()
    return asset
  })()
  // A decoded preview retains bytes, Base64 and possibly UTF-16 text. Reserve
  // their upper bound, rather than allowing a 64 MiB file budget to retain
  // several times that amount after source files become readable previews.
  const entry = { promise, size: item.size * 3 + Math.ceil(item.size / 3) * 8 }
  cache.set(key, entry)
  let retainedBytes = [...cache.values()].reduce((sum, value) => sum + value.size, 0)
  for (const [oldKey, oldEntry] of cache) {
    if (cache.size <= 16 && retainedBytes <= CACHE_BYTES) break
    cache.delete(oldKey); retainedBytes -= oldEntry.size
  }
  try { return await promise } catch (error) {
    if (cache.get(key) === entry) cache.delete(key)
    throw error
  }
}

export function useFinalResultAsset(result: FinalResult, item: FinalResultItem, enabled: boolean) {
  const source = useSyncExternalStore(subscribeEngineSource, getEngineSource)
  useSyncExternalStore(subscribeWorkPreview, () => workPreviewRevision(source, result.sessionId, item.path))
  const [ownerSource] = useState(getEngineSource)
  const key = assetKey(result, item, ownerSource)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; attempt: number; asset?: FinalResultAsset; error?: string }>()
  const current = ownerSource === source
  useEffect(() => {
    if (!enabled || !current) return
    let live = true
    void readFinalResultAsset(result, item, ownerSource).then(asset => {
      if (live) setLoaded({ key, attempt, asset })
    }, error => {
      if (live) setLoaded({ key, attempt, error: error instanceof Error ? error.message : '交付物暂时无法加载' })
    })
    return () => { live = false }
  }, [key, attempt, enabled, current, ownerSource])
  const value = current && loaded?.key === key && loaded.attempt === attempt ? loaded : undefined
  const retry = useCallback(() => {
    cache.delete(key)
    setAttempt(previous => previous + 1)
  }, [key])
  return { asset: value?.asset, error: !current ? '交付物所属连接已变化，请重新打开本轮结果' : value?.error,
    loading: enabled && current && !value, current, retry, source: ownerSource }
}

export function useFinalAssetUrl(asset: FinalResultAsset | undefined): string | undefined {
  const [value, setValue] = useState<{ asset: FinalResultAsset; url: string }>()
  useEffect(() => {
    if (!asset) return
    const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mimeType }))
    setValue({ asset, url })
    return () => URL.revokeObjectURL(url)
  }, [asset])
  return useMemo(() => value?.asset === asset ? value?.url : undefined, [asset, value])
}

export function downloadFinalResultAsset(item: FinalResultItem, asset: FinalResultAsset, source: number): void {
  assertEngineSource(source)
  const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = item.name.replace(/[/\\]/g, '_')
  anchor.click()
  // Chromium starts the download asynchronously after the click handler exits.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
