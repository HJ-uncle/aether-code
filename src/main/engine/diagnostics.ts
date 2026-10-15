/** On-demand OS measurements. No timer, database query or renderer process sampling. */
import { execFile } from 'node:child_process'
import { lstat, opendir, statfs } from 'node:fs/promises'
import { freemem, homedir, totalmem } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { EngineSnapshot } from '../../shared/ipc'
import type {
  EngineProcessDetail,
  EngineProcessTreeSnapshot,
  EngineResourceSnapshot,
  EngineStorageSnapshot
} from '../../shared/engine-diagnostics'

const RESOURCE_COOLDOWN_MS = 5_000
// The root process sample is cheap and drives the live card. Enumerating the
// Windows process table is materially more expensive, so keep the Codex-style
// detail view on a slower cadence while reusing its last bounded snapshot.
const PROCESS_TREE_COOLDOWN_MS = 15_000
const STORAGE_COOLDOWN_MS = 60_000
const PROCESS_QUERY_TIMEOUT_MS = 3_000
const MAX_CACHE_KEYS = 4
const DEFAULT_STORAGE_LIMITS = { entries: 20_000, durationMs: 1_500, depth: 24 }
/** Keep process inspection bounded even on machines with a large process list. */
const MAX_PROCESS_TREE_ENTRIES = 256

export interface EngineProcessSample {
  pid: number
  /** OS creation time prevents PID reuse from producing a false CPU/IO delta. */
  identity: string
  cpuTimeMs: number
  rssBytes: number
  privateBytes: number | null
  readBytes: number | null
  writeBytes: number | null
}

export interface EngineProcessTreeEntry extends EngineProcessSample {
  parentPid: number | null
  name: string
  command: string
}

export interface EngineProcessTreeSample {
  rootPid: number
  processes: EngineProcessTreeEntry[]
  partial: boolean
}

interface ProcessBaseline {
  sample: EngineProcessSample
  observedAt: number
}
interface StorageLimits {
  entries: number
  durationMs: number
  depth: number
}
export interface EngineDiagnosticsDependencies {
  now?: () => number
  monotonic?: () => number
  readProcess?: (pid: number) => Promise<EngineProcessSample>
  readProcessTree?: (pid: number) => Promise<EngineProcessTreeSample>
  storageLimits?: Partial<StorageLimits>
}

function nonnegative(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

/** Strictly parse only the requested process, never a process-list result. */
export function parseWindowsProcessSample(
  value: unknown,
  expectedPid: number
): EngineProcessSample {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PROCESS_QUERY_INVALID')
  const record = value as Record<string, unknown>
  const cpuTicks = nonnegative(record.cpuTicks)
  const rssBytes = nonnegative(record.rssBytes)
  if (
    record.pid !== expectedPid ||
    typeof record.identity !== 'string' ||
    !record.identity ||
    cpuTicks === null ||
    rssBytes === null
  ) {
    throw new Error('PROCESS_QUERY_INVALID')
  }
  return {
    pid: expectedPid,
    identity: record.identity,
    cpuTimeMs: cpuTicks / 10_000,
    rssBytes,
    privateBytes: nonnegative(record.privateBytes),
    readBytes: nonnegative(record.readBytes),
    writeBytes: nonnegative(record.writeBytes)
  }
}

/**
 * Parse the one-shot process list used for the Codex-style process panel.
 * Invalid descendants are skipped and reported as partial; the requested root
 * must remain valid so a PID reuse or malformed response can never be shown as
 * a healthy tree.
 */
export function parseWindowsProcessTree(
  value: unknown,
  expectedPid: number
): EngineProcessTreeSample {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0)
    throw new Error('PROCESS_QUERY_INVALID')
  const records = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
  let partial = records.length > MAX_PROCESS_TREE_ENTRIES
  // CIM does not promise enumeration order. Keep the requested root even when
  // the bounded prefix is full, otherwise a healthy engine can look absent.
  const rootIndex = records.findIndex(
    (item) =>
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).pid === expectedPid
  )
  const boundedRecords =
    rootIndex >= MAX_PROCESS_TREE_ENTRIES
      ? [...records.slice(0, MAX_PROCESS_TREE_ENTRIES - 1), records[rootIndex]]
      : records.slice(0, MAX_PROCESS_TREE_ENTRIES)
  const entries: EngineProcessTreeEntry[] = []
  for (const item of boundedRecords) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      partial = true
      continue
    }
    const record = item as Record<string, unknown>
    const pid = nonnegative(record.pid)
    const parentPidValue = nonnegative(record.parentPid)
    const cpuTicks = nonnegative(record.cpuTicks)
    const rssBytes = nonnegative(record.rssBytes)
    const identity = typeof record.identity === 'string' ? record.identity : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const command = typeof record.command === 'string' ? record.command.trim() : name
    if (
      pid === null ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      (parentPidValue !== null && (!Number.isSafeInteger(parentPidValue) || parentPidValue < 0)) ||
      cpuTicks === null ||
      rssBytes === null ||
      !identity ||
      !name ||
      !command
    ) {
      partial = true
      continue
    }
    entries.push({
      pid,
      parentPid: parentPidValue,
      identity,
      cpuTimeMs: cpuTicks / 10_000,
      rssBytes,
      privateBytes: nonnegative(record.privateBytes),
      readBytes: nonnegative(record.readBytes),
      writeBytes: nonnegative(record.writeBytes),
      name,
      command
    })
  }
  const root = entries.find((entry) => entry.pid === expectedPid)
  if (!root) throw new Error('PROCESS_QUERY_INVALID')

  // Follow parent links from the requested process. A malformed cycle or a
  // process whose parent disappeared is ignored rather than leaking unrelated
  // system processes into the engine view.
  const byParent = new Map<number, EngineProcessTreeEntry[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid ?? -1) ?? []
    children.push(entry)
    byParent.set(entry.parentPid ?? -1, children)
  }
  const seen = new Set<number>([expectedPid])
  const processes: EngineProcessTreeEntry[] = [root]
  const pending = [expectedPid]
  while (pending.length) {
    const parent = pending.shift()!
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) {
        partial = true
        continue
      }
      seen.add(child.pid)
      processes.push(child)
      pending.push(child.pid)
    }
  }
  return { rootPid: expectedPid, processes, partial }
}

async function runWindowsPowerShell(script: string, maxBuffer = 16 * 1024): Promise<string> {
  const executable = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const output = await new Promise<string>((accept, reject) => {
    execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer,
        encoding: 'utf8'
      },
      (error, stdout) => {
        // Child-process errors contain stdout/stderr. Keep them out of the IPC result.
        if (error)
          reject(new Error(error.killed ? 'PROCESS_QUERY_TIMEOUT' : 'PROCESS_QUERY_FAILED'))
        else accept(stdout)
      }
    )
  })
  return output.replace(/^\uFEFF/, '').trim()
}

async function readWindowsProcess(pid: number): Promise<EngineProcessSample> {
  // The sole interpolation is an already-validated integer. -Filter is applied by
  // CIM, avoiding Get-Process/Get-CimInstance enumeration of every process.
  const script =
    `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);` +
    `$p=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -Property ProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount,ReadTransferCount,WriteTransferCount;` +
    `if($null -eq $p){exit 3};[ordered]@{pid=[int]$p.ProcessId;identity=$p.CreationDate.ToUniversalTime().ToString('O');cpuTicks=([decimal]$p.KernelModeTime+[decimal]$p.UserModeTime).ToString();rssBytes=[string]$p.WorkingSetSize;privateBytes=[string]$p.PrivatePageCount;readBytes=[string]$p.ReadTransferCount;writeBytes=[string]$p.WriteTransferCount}|ConvertTo-Json -Compress`
  try {
    return parseWindowsProcessSample(JSON.parse(await runWindowsPowerShell(script)), pid)
  } catch {
    // Some hardened Windows policies deny Win32_Process while allowing a
    // single Get-Process lookup. Preserve CPU/RSS/private in that case and
    // leave transfer counters null instead of pretending they are zero.
    const fallback =
      `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);` +
      `$p=Get-Process -Id ${pid};[ordered]@{pid=[int]$p.Id;identity=$p.StartTime.ToUniversalTime().ToString('O');cpuMs=[string]$p.TotalProcessorTime.TotalMilliseconds;rssBytes=[string]$p.WorkingSet64;privateBytes=[string]$p.PrivateMemorySize64}|ConvertTo-Json -Compress`
    const value = JSON.parse(await runWindowsPowerShell(fallback)) as Record<string, unknown>
    const cpuMs = Number(value.cpuMs)
    if (!Number.isFinite(cpuMs) || cpuMs < 0) throw new Error('PROCESS_QUERY_FAILED')
    return parseWindowsProcessSample(
      { ...value, cpuTicks: String(cpuMs * 10_000), readBytes: null, writeBytes: null },
      pid
    )
  }
}

async function readWindowsProcessTree(pid: number): Promise<EngineProcessTreeSample> {
  // CommandLine is deliberately excluded: the process list is sent over IPC
  // and arguments can contain API keys or workspace secrets. A single CIM
  // request keeps the panel inexpensive while still finding all descendants.
  const script =
    `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);` +
    `$items=Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount,ReadTransferCount,WriteTransferCount,Name,ExecutablePath;` +
    `$items|ForEach-Object {[ordered]@{pid=[int]$_.ProcessId;parentPid=([int]$_.ParentProcessId);identity=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('O')}else{''};cpuTicks=([decimal]$_.KernelModeTime+[decimal]$_.UserModeTime).ToString();rssBytes=[string]$_.WorkingSetSize;privateBytes=[string]$_.PrivatePageCount;readBytes=[string]$_.ReadTransferCount;writeBytes=[string]$_.WriteTransferCount;name=[string]$_.Name;command=if([string]::IsNullOrWhiteSpace($_.ExecutablePath)){[string]$_.Name}else{[string]$_.ExecutablePath}}}|ConvertTo-Json -Compress -Depth 3`
  // A normal Windows workstation can have more than a hundred processes. The
  // response is still bounded by the parser, but the IPC command needs enough
  // room to carry the candidate list before descendants are selected.
  const parsed = JSON.parse(await runWindowsPowerShell(script, 512 * 1024))
  return parseWindowsProcessTree(parsed, pid)
}

async function readProcess(pid: number): Promise<EngineProcessSample> {
  if (process.platform === 'win32') return readWindowsProcess(pid)
  throw new Error('PROCESS_PLATFORM_UNSUPPORTED')
}

async function readProcessTree(pid: number): Promise<EngineProcessTreeSample> {
  if (process.platform === 'win32') return readWindowsProcessTree(pid)
  throw new Error('PROCESS_PLATFORM_UNSUPPORTED')
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHE_KEYS) cache.delete(cache.keys().next().value!)
}

function engineKey(snapshot: EngineSnapshot): string {
  return JSON.stringify([
    snapshot.mode,
    snapshot.instanceId ?? null,
    snapshot.pid,
    snapshot.dataDir
  ])
}

function unavailableResources(
  snapshot: EngineSnapshot,
  now: number,
  reason: string
): EngineResourceSnapshot {
  return {
    sampledAt: now,
    scope: 'engine-process',
    state: 'unavailable',
    reason,
    pid: snapshot.mode === 'embedded' ? snapshot.pid : null,
    cpu: { percent: null, intervalMs: null, normalization: 'one-logical-core' },
    memory: { rssBytes: null, privateBytes: null },
    io: { readBytes: null, writeBytes: null, readBytesPerSecond: null, writeBytesPerSecond: null },
    hostMemory: { totalBytes: null, availableBytes: null },
    disk: { totalBytes: null, availableBytes: null, path: null },
    processTree: unavailableProcessTree(snapshot.mode === 'embedded' ? snapshot.pid : null, reason),
    collection: { durationMs: 0, cached: false }
  }
}

function unavailableProcessTree(
  rootPid: number | null,
  reason: string,
  durationMs = 0
): EngineProcessTreeSnapshot {
  return {
    state: 'unavailable',
    reason,
    rootPid,
    rootIdentity: null,
    partial: false,
    processes: [],
    totals: {
      count: 0,
      cpu: { percent: null, intervalMs: null },
      memory: { rssBytes: null, privateBytes: null },
      io: {
        readBytes: null,
        writeBytes: null,
        readBytesPerSecond: null,
        writeBytesPerSecond: null
      }
    },
    sampledAt: null,
    collection: { durationMs, cached: false }
  }
}

function unavailableStorage(reason: string, durationMs = 0): EngineStorageSnapshot {
  return {
    state: 'unavailable',
    reason,
    path: null,
    totalBytes: null,
    files: 0,
    categories: [],
    partial: false,
    scannedAt: null,
    durationMs,
    cached: false
  }
}

/** DATA_DIR is a SQLite *file*. Never infer its parent from a missing path. */
async function checkedDataRoot(snapshot: EngineSnapshot): Promise<string> {
  if (!snapshot.dataDir || !isAbsolute(snapshot.dataDir))
    throw new Error('STORAGE_PATH_UNAVAILABLE')
  const databasePath = resolve(snapshot.dataDir)
  const database = await lstat(databasePath)
  if (!database.isFile() || database.isSymbolicLink()) throw new Error('STORAGE_PATH_UNAVAILABLE')
  const root = dirname(databasePath)
  if (root === parse(root).root || root === resolve(homedir()))
    throw new Error('STORAGE_PATH_UNSAFE')
  // Reject redirection at every ancestor, including a configured junction above
  // the data directory, rather than only checking directory entries below it.
  for (let current = root; ; current = dirname(current)) {
    const directory = await lstat(current)
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('STORAGE_PATH_REDIRECTED')
    if (dirname(current) === current) break
  }
  return root
}

async function diskCapacity(snapshot: EngineSnapshot): Promise<EngineResourceSnapshot['disk']> {
  try {
    const root = await checkedDataRoot(snapshot)
    const disk = await statfs(root, { bigint: true })
    const bytes = (blocks: bigint): number | null => {
      const value = Number(blocks * disk.bsize)
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    }
    return { totalBytes: bytes(disk.blocks), availableBytes: bytes(disk.bavail), path: root }
  } catch {
    return { totalBytes: null, availableBytes: null, path: null }
  }
}

export function calculateProcessRates(
  sample: EngineProcessSample,
  previous: ProcessBaseline | undefined,
  observedAt: number
): {
  cpu: EngineResourceSnapshot['cpu']
  readBytesPerSecond: number | null
  writeBytesPerSecond: number | null
} {
  const sameProcess =
    previous && previous.sample.pid === sample.pid && previous.sample.identity === sample.identity
  const elapsed = sameProcess ? observedAt - previous.observedAt : 0
  const validInterval = elapsed > 0 && sample.cpuTimeMs >= (previous?.sample.cpuTimeMs ?? 0)
  const rate = (value: number | null, prior: number | null | undefined): number | null =>
    validInterval && value !== null && prior != null && value >= prior
      ? ((value - prior) * 1_000) / elapsed
      : null
  return {
    cpu: {
      percent: validInterval
        ? ((sample.cpuTimeMs - previous!.sample.cpuTimeMs) * 100) / elapsed
        : null,
      intervalMs: validInterval ? elapsed : null,
      normalization: 'one-logical-core'
    },
    readBytesPerSecond: rate(sample.readBytes, previous?.sample.readBytes),
    writeBytesPerSecond: rate(sample.writeBytes, previous?.sample.writeBytes)
  }
}

interface ProcessTreeBaseline {
  samples: Map<number, EngineProcessTreeEntry>
  observedAt: number
}

/**
 * Turn a raw process tree into stable, renderer-safe rows and aggregate
 * counters. Sorting follows parent depth/name/PID, so repeated CIM responses do
 * not reshuffle the panel when Windows returns processes in a different order.
 */
export function calculateProcessTreeMetrics(
  sample: EngineProcessTreeSample,
  previous: ProcessTreeBaseline | undefined,
  observedAt: number,
  sampledAt: number,
  collectionDurationMs: number
): EngineProcessTreeSnapshot {
  const byPid = new Map(sample.processes.map((entry) => [entry.pid, entry]))
  const depth = new Map<number, number>([[sample.rootPid, 0]])
  const resolveDepth = (entry: EngineProcessTreeEntry): number => {
    const known = depth.get(entry.pid)
    if (known !== undefined) return known
    const chain = new Set<number>()
    let current: EngineProcessTreeEntry | undefined = entry
    let level = 0
    while (current && !depth.has(current.pid) && current.parentPid !== null) {
      if (chain.has(current.pid)) return 0
      chain.add(current.pid)
      current = byPid.get(current.parentPid)
      level += 1
    }
    const base = current ? (depth.get(current.pid) ?? 0) : 0
    const result = base + level
    depth.set(entry.pid, result)
    return result
  }
  const rows = sample.processes
    .map((entry) => {
      const prior = previous?.samples.get(entry.pid)
      const rates = calculateProcessRates(
        entry,
        prior && previous ? { sample: prior, observedAt: previous.observedAt } : undefined,
        observedAt
      )
      const created = Date.parse(entry.identity)
      const ageMs = Number.isFinite(created) ? Math.max(0, sampledAt - created) : null
      return {
        entry,
        depth: resolveDepth(entry),
        rates,
        detail: {
          pid: entry.pid,
          parentPid: entry.parentPid,
          kind: entry.pid === sample.rootPid ? 'engine' : 'child',
          name: entry.name,
          command: entry.command,
          depth: resolveDepth(entry),
          ageMs,
          cpu: rates.cpu,
          memory: { rssBytes: entry.rssBytes, privateBytes: entry.privateBytes },
          io: {
            readBytes: entry.readBytes,
            writeBytes: entry.writeBytes,
            readBytesPerSecond: rates.readBytesPerSecond,
            writeBytesPerSecond: rates.writeBytesPerSecond
          }
        } satisfies EngineProcessDetail
      }
    })
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        Number(b.detail.kind === 'engine') - Number(a.detail.kind === 'engine') ||
        a.detail.name.localeCompare(b.detail.name) ||
        a.detail.pid - b.detail.pid
    )
  const sum = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null)
    return present.length ? present.reduce((total, value) => total + value, 0) : null
  }
  const allPresent = (values: Array<number | null>): number | null =>
    values.length > 0 && values.every((value): value is number => value !== null)
      ? values.reduce((total, value) => total + value, 0)
      : null
  const cpuRows = rows.filter((row) => row.rates.cpu.percent !== null)
  const intervalMs = cpuRows.length ? cpuRows[0].rates.cpu.intervalMs : null
  return {
    state: 'available',
    rootPid: sample.rootPid,
    rootIdentity: sample.processes.find((entry) => entry.pid === sample.rootPid)?.identity ?? null,
    partial: sample.partial,
    processes: rows.map((row) => row.detail),
    totals: {
      count: rows.length,
      cpu: {
        percent: sum(rows.map((row) => row.rates.cpu.percent)),
        intervalMs
      },
      memory: {
        rssBytes: sum(rows.map((row) => row.entry.rssBytes)),
        privateBytes: sum(rows.map((row) => row.entry.privateBytes))
      },
      io: {
        readBytes: allPresent(rows.map((row) => row.entry.readBytes)),
        writeBytes: allPresent(rows.map((row) => row.entry.writeBytes)),
        readBytesPerSecond: allPresent(rows.map((row) => row.rates.readBytesPerSecond)),
        writeBytesPerSecond: allPresent(rows.map((row) => row.rates.writeBytesPerSecond))
      }
    },
    sampledAt,
    collection: { durationMs: Math.max(0, collectionDurationMs), cached: false }
  }
}

function categoryFor(relative: string[], databaseName: string): string {
  const first = relative[0].toLowerCase()
  if (
    relative.length === 1 &&
    (first === databaseName || first === `${databaseName}-wal` || first === `${databaseName}-shm`)
  )
    return 'database'
  if (first === 'sessions') return 'conversations'
  if (first === 'memory') return 'memory'
  if (first === 'change-snapshots') return 'snapshots'
  if (first === 'backups' || first === 'backup') return 'backups'
  if (first === 'logs' || first.endsWith('.log')) return 'logs'
  if (first === 'cache' || first === '.cache' || first === 'tmp' || first === 'temp') return 'cache'
  return 'other'
}

/** Exported collector allows deterministic tests of deltas, cooldown and budgets. */
export class EngineDiagnosticsCollector {
  private readonly now: () => number
  private readonly monotonic: () => number
  private readonly processReader: (pid: number) => Promise<EngineProcessSample>
  private readonly processTreeReader: (pid: number) => Promise<EngineProcessTreeSample>
  private readonly limits: StorageLimits
  private readonly resources = new Map<string, EngineResourceSnapshot>()
  private readonly baselines = new Map<string, ProcessBaseline>()
  private readonly processTreeBaselines = new Map<string, ProcessTreeBaseline>()
  private readonly processTrees = new Map<string, EngineProcessTreeSnapshot>()
  private readonly resourcePending = new Map<string, Promise<EngineResourceSnapshot>>()
  private readonly storage = new Map<string, { at: number; value: EngineStorageSnapshot }>()
  private readonly storagePending = new Map<string, Promise<EngineStorageSnapshot>>()

  constructor(dependencies: EngineDiagnosticsDependencies = {}) {
    this.now = dependencies.now ?? Date.now
    this.monotonic = dependencies.monotonic ?? (() => performance.now())
    this.processReader = dependencies.readProcess ?? readProcess
    this.processTreeReader = dependencies.readProcessTree ?? readProcessTree
    this.limits = { ...DEFAULT_STORAGE_LIMITS, ...dependencies.storageLimits }
  }

  getResources(snapshot: EngineSnapshot): Promise<EngineResourceSnapshot> {
    if (snapshot.mode !== 'embedded')
      return Promise.resolve(unavailableResources(snapshot, this.now(), '远端引擎尚未提供资源遥测'))
    if (
      snapshot.phase !== 'ready' ||
      !Number.isSafeInteger(snapshot.pid) ||
      !snapshot.pid ||
      snapshot.pid <= 0
    ) {
      return Promise.resolve(unavailableResources(snapshot, this.now(), '本地引擎进程未就绪'))
    }
    const key = engineKey(snapshot)
    const prior = this.resources.get(key)
    const age = prior ? this.now() - prior.sampledAt : Infinity
    if (prior && age >= 0 && age < RESOURCE_COOLDOWN_MS)
      return Promise.resolve({
        ...prior,
        processTree: {
          ...prior.processTree,
          collection: { ...prior.processTree.collection, cached: true }
        },
        collection: { ...prior.collection, cached: true }
      })
    const pending = this.resourcePending.get(key)
    if (pending) return pending
    const request = this.collectResources(snapshot, key)
      .then((value) => {
        remember(this.resources, key, value)
        return value
      })
      .finally(() => {
        this.resourcePending.delete(key)
      })
    this.resourcePending.set(key, request)
    return request
  }

  private async collectResources(
    snapshot: EngineSnapshot,
    key: string
  ): Promise<EngineResourceSnapshot> {
    const started = this.monotonic()
    const previousTree = this.processTrees.get(key)
    const treeAge = previousTree?.sampledAt == null ? Infinity : this.now() - previousTree.sampledAt
    const cachedTree =
      previousTree && treeAge >= 0 && treeAge < PROCESS_TREE_COOLDOWN_MS
        ? {
            ...previousTree,
            collection: { ...previousTree.collection, cached: true }
          }
        : null
    // A cached snapshot is kept separate from the raw process sample. Feeding
    // renderer rows back into the delta calculator would lose creation times
    // and CPU counters, and can turn a PID reuse into a false rate.
    const processTreeRequest: Promise<EngineProcessTreeSample | null> = cachedTree
      ? Promise.resolve(null)
      : this.processTreeReader(snapshot.pid!)
    const [processResult, initialProcessTreeResult, disk] = await Promise.allSettled([
      this.processReader(snapshot.pid!),
      processTreeRequest,
      diskCapacity(snapshot)
    ])
    let processTreeResult: PromiseSettledResult<EngineProcessTreeSample | null> =
      initialProcessTreeResult
    if (processResult.status === 'rejected') {
      const reason =
        processResult.reason instanceof Error &&
        processResult.reason.message === 'PROCESS_PLATFORM_UNSUPPORTED'
          ? '当前系统尚不支持引擎进程资源采样'
          : '无法读取引擎进程资源，请确认进程仍在运行且具备读取权限'
      const unavailable = unavailableResources(snapshot, this.now(), reason)
      // Process ACLs can fail while the data directory and host counters remain
      // readable. Keep those independent measurements visible instead of
      // collapsing the entire diagnostics card to an empty response.
      unavailable.hostMemory = { totalBytes: totalmem(), availableBytes: freemem() }
      unavailable.disk = disk.status === 'fulfilled' ? disk.value : unavailable.disk
      unavailable.processTree =
        processTreeResult.status === 'fulfilled'
          ? processTreeResult.value === null && cachedTree
            ? cachedTree
            : processTreeResult.value === null
              ? unavailableProcessTree(
                  snapshot.pid,
                  '无法读取引擎子进程资源',
                  this.monotonic() - started
                )
              : calculateProcessTreeMetrics(
                  processTreeResult.value,
                  this.processTreeBaselines.get(key),
                  this.monotonic(),
                  unavailable.sampledAt,
                  this.monotonic() - started
                )
          : unavailableProcessTree(
              snapshot.pid,
              processTreeResult.reason instanceof Error &&
                processTreeResult.reason.message === 'PROCESS_PLATFORM_UNSUPPORTED'
                ? '当前系统尚不支持引擎进程树采样'
                : '无法读取引擎子进程资源，请确认进程仍在运行且具备读取权限',
              this.monotonic() - started
            )
      if (processTreeResult.status === 'fulfilled' && processTreeResult.value !== null) {
        const tree = unavailable.processTree
        this.processTrees.set(key, tree)
        this.processTreeBaselines.set(key, {
          samples: new Map(processTreeResult.value.processes.map((entry) => [entry.pid, entry])),
          observedAt: this.monotonic()
        })
      }
      unavailable.collection.durationMs = Math.max(0, this.monotonic() - started)
      return unavailable
    }
    const sample = processResult.value
    // The root PID can be reused between the cheap single-PID query and the
    // process-list query. Refuse the cached rows (and retry once) when their
    // creation identity differs; never attach a prior engine's children to a
    // new process with the same number.
    if (cachedTree && cachedTree.rootIdentity !== sample.identity) {
      processTreeResult = await Promise.allSettled([this.processTreeReader(snapshot.pid!)]).then(
        ([result]) => result
      )
    }
    if (processTreeResult.status === 'fulfilled' && processTreeResult.value !== null) {
      const treeRoot = processTreeResult.value.processes.find((entry) => entry.pid === snapshot.pid)
      if (treeRoot && treeRoot.identity !== sample.identity) {
        processTreeResult = {
          status: 'rejected',
          reason: new Error('PROCESS_PID_REUSED')
        }
      }
    }
    const observedAt = this.monotonic()
    const rates = calculateProcessRates(sample, this.baselines.get(key), observedAt)
    remember(this.baselines, key, { sample, observedAt })
    const sampledAt = this.now()
    const processTree =
      processTreeResult.status === 'fulfilled'
        ? processTreeResult.value === null && cachedTree
          ? cachedTree
          : processTreeResult.value === null
            ? unavailableProcessTree(
                snapshot.pid!,
                '无法读取引擎子进程资源',
                this.monotonic() - started
              )
            : calculateProcessTreeMetrics(
                processTreeResult.value,
                this.processTreeBaselines.get(key),
                observedAt,
                sampledAt,
                this.monotonic() - started
              )
        : unavailableProcessTree(
            snapshot.pid!,
            processTreeResult.reason instanceof Error &&
              processTreeResult.reason.message === 'PROCESS_PLATFORM_UNSUPPORTED'
              ? '当前系统尚不支持引擎进程树采样'
              : '无法读取引擎子进程资源，请确认进程仍在运行且具备读取权限',
            this.monotonic() - started
          )
    if (processTreeResult.status === 'fulfilled' && processTreeResult.value !== null) {
      this.processTrees.set(key, processTree as EngineProcessTreeSnapshot)
      this.processTreeBaselines.set(key, {
        samples: new Map(processTreeResult.value.processes.map((entry) => [entry.pid, entry])),
        observedAt
      })
    }
    return {
      sampledAt,
      scope: 'engine-process',
      state: 'available',
      pid: snapshot.pid,
      cpu: rates.cpu,
      memory: { rssBytes: sample.rssBytes, privateBytes: sample.privateBytes },
      io: {
        readBytes: sample.readBytes,
        writeBytes: sample.writeBytes,
        readBytesPerSecond: rates.readBytesPerSecond,
        writeBytesPerSecond: rates.writeBytesPerSecond
      },
      hostMemory: { totalBytes: totalmem(), availableBytes: freemem() },
      disk:
        disk.status === 'fulfilled'
          ? disk.value
          : { totalBytes: null, availableBytes: null, path: null },
      processTree,
      collection: { durationMs: Math.max(0, observedAt - started), cached: false }
    }
  }

  /** refresh is an intent marker; the same 60s cooldown protects repeated IPC clicks. */
  getStorage(snapshot: EngineSnapshot, refreshRequested = false): Promise<EngineStorageSnapshot> {
    // The request flag is intentionally advisory: the 60s cooldown remains a
    // hard lower bound even when a user presses Refresh repeatedly.
    void refreshRequested
    if (snapshot.mode !== 'embedded')
      return Promise.resolve(unavailableStorage('远端引擎尚未提供存储遥测'))
    const key = snapshot.dataDir ?? ''
    const previous = this.storage.get(key)
    const age = previous ? this.now() - previous.at : Infinity
    // Explicit refresh is also subject to the cooldown; repeated clicks must not
    // turn an on-demand directory scan into continuous filesystem activity.
    if (previous && age >= 0 && age < STORAGE_COOLDOWN_MS)
      return Promise.resolve({ ...previous.value, cached: true })
    const pending = this.storagePending.get(key)
    if (pending) return pending
    const request = this.scanStorage(snapshot)
      .then((value) => {
        remember(this.storage, key, { at: this.now(), value })
        return value
      })
      .finally(() => {
        this.storagePending.delete(key)
      })
    this.storagePending.set(key, request)
    return request
  }

  private async scanStorage(snapshot: EngineSnapshot): Promise<EngineStorageSnapshot> {
    const started = this.monotonic()
    let root: string
    try {
      root = await checkedDataRoot(snapshot)
    } catch {
      return unavailableStorage(
        '无法读取已确认的引擎数据目录',
        Math.max(0, this.monotonic() - started)
      )
    }
    let entries = 0,
      files = 0,
      totalBytes = 0,
      partial = false
    const categories = new Map<string, { category: string; bytes: number; files: number }>()
    const overBudget = (): boolean =>
      entries >= this.limits.entries || this.monotonic() - started >= this.limits.durationMs
    const walk = async (relative: string[]): Promise<void> => {
      if (overBudget() || relative.length > this.limits.depth) {
        partial = true
        return
      }
      try {
        const directory = await opendir(join(root, ...relative))
        for await (const entry of directory) {
          if (overBudget()) {
            partial = true
            break
          }
          entries += 1
          const parts = [...relative, entry.name]
          // Dirent avoids stat work for links; lstat below also rejects a link
          // that replaced a regular entry before its metadata was read.
          if (entry.isSymbolicLink()) continue
          let info
          try {
            info = await lstat(join(root, ...parts))
          } catch {
            partial = true
            continue
          }
          if (info.isSymbolicLink()) continue
          if (info.isDirectory()) await walk(parts)
          else if (info.isFile()) {
            const category = categoryFor(parts, basename(snapshot.dataDir!).toLowerCase())
            const group = categories.get(category) ?? { category, bytes: 0, files: 0 }
            group.bytes += info.size
            group.files += 1
            categories.set(category, group)
            totalBytes += info.size
            files += 1
          }
        }
      } catch {
        partial = true
      }
    }
    await walk([])
    return {
      state: 'available',
      path: root,
      totalBytes,
      files,
      categories: [...categories.values()].sort(
        (a, b) => b.bytes - a.bytes || a.category.localeCompare(b.category)
      ),
      partial,
      scannedAt: this.now(),
      durationMs: Math.max(0, this.monotonic() - started),
      cached: false
    }
  }
}

const collector = new EngineDiagnosticsCollector()
export function getEngineResourceSnapshot(
  snapshot: EngineSnapshot
): Promise<EngineResourceSnapshot> {
  return collector.getResources(snapshot)
}
export function getEngineStorageSnapshot(
  snapshot: EngineSnapshot,
  refresh = false
): Promise<EngineStorageSnapshot> {
  return collector.getStorage(snapshot, refresh)
}
