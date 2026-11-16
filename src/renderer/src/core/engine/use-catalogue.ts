import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CatalogueCache } from './catalogue-cache'

interface CatalogueResult<T> { scope: string; revision: number; value?: T; loading: boolean; error: string | null }

/** Reopened pickers render a warm catalogue before effects run. */
export function useCatalogue<T>(cache: CatalogueCache<T>, scope: string, enabled: boolean, fetchValue: () => Promise<T>) {
  const revision = useSyncExternalStore(cache.subscribe, cache.getRevision)
  const [result, setResult] = useState<CatalogueResult<T>>({ scope: '', revision: -1, loading: false, error: null })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let current = true
    const cached = cache.peek(scope)
    setResult({ scope, revision, value: cached, loading: cached === undefined, error: null })
    void cache.load(scope, fetchValue).then(value => {
      if (current && revision === cache.getRevision()) setResult({ scope, revision, value, loading: false, error: null })
    }).catch((cause: unknown) => {
      if (current && revision === cache.getRevision()) setResult({ scope, revision, loading: false,
        error: cause instanceof Error ? cause.message : '无法读取目录，请重试' })
    })
    return () => { current = false }
    // The caller encodes every request identity in scope; changing callback identity does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, scope, enabled, revision, retry])
  const cached = enabled ? cache.peek(scope) : undefined
  const visible = enabled && result.scope === scope && result.revision === revision ? result : undefined
  return { value: cached ?? visible?.value, loading: enabled && cached === undefined && (visible?.loading ?? true),
    error: enabled ? visible?.error ?? null : null, retry: () => setRetry(value => value + 1) }
}
