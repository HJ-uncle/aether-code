/** Mirrors the authenticated engine /performance/runtime v1 contract. Values
 * describe that Node process; Chromium's heap is a separate measurement. */
export interface EngineRuntimeDiagnostics {
  schemaVersion: 1
  instanceId: string
  pid: number
  sampledAt: number
  uptimeMs: number
  collection: { minIntervalMs: number; idleTimeoutMs: number; delayResolutionMs: number }
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; heapLimitBytes: number; externalBytes: number; arrayBuffersBytes: number }
  eventLoop: { state: 'warming' | 'available'; intervalMs: number | null; utilization: number | null; delay: { meanMs: number; p95Ms: number; maxMs: number } | null }
}
export interface EngineRuntimeTarget { instanceId: string | null | undefined; pid: number | null }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const bytes = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value)
const positive = (value: unknown): value is number => finite(value) && value > 0
function fail(): never { throw new Error('引擎未提供可验证的运行时指标。') }

/** Rebuild a finite DTO rather than trusting JSON assertions or replacing
 * unknown measurements with zero. The first remote PID is pinned by its reader. */
export function parseEngineRuntimeDiagnostics(value: unknown, target: EngineRuntimeTarget): EngineRuntimeDiagnostics {
  const data = record(value), memory = record(data?.memory), loop = record(data?.eventLoop), collection = record(data?.collection)
  if (!data || data.schemaVersion !== 1 || typeof data.instanceId !== 'string' || !data.instanceId || data.instanceId !== target.instanceId ||
    !bytes(data.pid) || data.pid === 0 || target.pid !== null && target.pid !== data.pid ||
    !positive(data.sampledAt) || !finite(data.uptimeMs) || !memory || !loop || !collection) fail()
  if (!positive(collection.minIntervalMs) || !positive(collection.idleTimeoutMs) || collection.idleTimeoutMs < collection.minIntervalMs * 2 ||
    !positive(collection.delayResolutionMs) || !['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'heapLimitBytes', 'externalBytes', 'arrayBuffersBytes'].every(key => bytes(memory[key])) ||
    Number(memory.heapUsedBytes) > Number(memory.heapTotalBytes) || Number(memory.heapTotalBytes) > Number(memory.heapLimitBytes) || memory.heapLimitBytes === 0) fail()
  if (loop.state !== 'warming' && loop.state !== 'available' || loop.intervalMs !== null && !positive(loop.intervalMs) ||
    loop.utilization !== null && (!finite(loop.utilization) || loop.utilization > 1)) fail()
  const delay = loop.delay === null ? null : record(loop.delay)
  if (loop.delay !== null && (!delay || !finite(delay.meanMs) || !finite(delay.p95Ms) || !finite(delay.maxMs) || delay.meanMs > delay.maxMs || delay.p95Ms > delay.maxMs)) fail()
  if (loop.state === 'available' && (loop.intervalMs === null || loop.utilization === null || delay === null)) fail()
  return {
    schemaVersion: 1, instanceId: data.instanceId, pid: data.pid, sampledAt: data.sampledAt, uptimeMs: data.uptimeMs,
    collection: { minIntervalMs: collection.minIntervalMs, idleTimeoutMs: collection.idleTimeoutMs, delayResolutionMs: collection.delayResolutionMs },
    memory: { rssBytes: Number(memory.rssBytes), heapUsedBytes: Number(memory.heapUsedBytes), heapTotalBytes: Number(memory.heapTotalBytes), heapLimitBytes: Number(memory.heapLimitBytes), externalBytes: Number(memory.externalBytes), arrayBuffersBytes: Number(memory.arrayBuffersBytes) },
    eventLoop: { state: loop.state, intervalMs: loop.intervalMs as number | null, utilization: loop.utilization as number | null,
      delay: delay ? { meanMs: Number(delay.meanMs), p95Ms: Number(delay.p95Ms), maxMs: Number(delay.maxMs) } : null }
  }
}

export interface EngineRuntimeState {
  phase: 'idle' | 'loading' | 'sample' | 'unsupported' | 'error'
  sample: EngineRuntimeDiagnostics | null
  message?: string
}

/** One in-flight read and one retained sample; toggling visibility invalidates
 * late completions without starting a competing request. A 404 is capability
 * absence, so only an explicit retry can probe that engine again. */
export function createEngineRuntimeSampler(options: {
  target: EngineRuntimeTarget
  read: () => Promise<{ ok: boolean; code: number; message: string; data: unknown }>
  current: () => boolean
  publish: (state: EngineRuntimeState) => void
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (timer: unknown) => void
}) {
  let active = false, disposed = false, pending = false, terminal = false, generation = 0
  let timer: unknown, sample: EngineRuntimeDiagnostics | null = null, pinnedPid = options.target.pid
  const clear = () => { if (timer !== undefined) options.cancel(timer); timer = undefined }
  const live = () => !disposed && active && options.current()
  const publish = (state: EngineRuntimeState) => { if (live()) options.publish(state) }
  const schedule = (delayMs = 5000) => { clear(); if (live() && !terminal) timer = options.schedule(() => { timer = undefined; void read() }, delayMs) }
  const read = async (): Promise<void> => {
    if (!live() || pending || terminal) return
    pending = true
    const epoch = generation
    publish({ phase: 'loading', sample })
    try {
      const result = await options.read()
      if (!live() || epoch !== generation) return
      if (!result.ok) {
        terminal = [404, 40400, 501, 50100, 401, 40100, 403, 40300].includes(result.code)
        publish({ phase: [404, 40400, 501, 50100].includes(result.code) ? 'unsupported' : 'error', sample: null,
          message: [404, 40400, 501, 50100].includes(result.code) ? '此引擎未提供运行时指标接口。' : result.message || '无法读取引擎运行时指标。' })
        sample = null
        return
      }
      const parsed = parseEngineRuntimeDiagnostics(result.data, { ...options.target, pid: pinnedPid })
      if (sample && parsed.sampledAt < sample.sampledAt) fail()
      pinnedPid = parsed.pid; sample = parsed
      publish({ phase: 'sample', sample })
    } catch (cause) {
      if (live() && epoch === generation) { sample = null; publish({ phase: 'error', sample: null, message: cause instanceof Error ? cause.message : '无法读取引擎运行时指标。' }) }
    } finally {
      pending = false
      if (live()) schedule(epoch === generation ? 5000 : 0)
    }
  }
  return {
    setActive(value: boolean) { if (active === value || disposed) return; active = value; generation++; clear(); if (active) void read() },
    retry() { if (!live()) return; terminal = false; clear(); void read() },
    dispose() { disposed = true; active = false; generation++; clear() }
  }
}
