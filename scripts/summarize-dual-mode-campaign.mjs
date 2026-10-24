/** Read-only campaign report. Sampling describes this run, not a hardware benchmark. */
import { readFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function jsonLines(file) {
  try {
    if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('Evidence exceeds report read budget: ' + file)
    const text = await readFile(file, 'utf8')
    // A live writer may not have completed the last record yet.
    const lines = text.split('\n'); if (lines.at(-1)?.trim()) lines.pop()
    return lines.filter(line => line.trim()).map(line => JSON.parse(line))
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
const number = value => typeof value === 'number' && Number.isFinite(value)
const round = value => Math.round(value * 100) / 100
const mib = value => number(value) ? value / 1024 ** 2 : null
function distribution(values) {
  const valid = values.filter(number)
  if (!valid.length) return { samples: 0 }
  const sorted = [...valid].sort((a, b) => a - b)
  return { samples: valid.length, first: round(valid[0]), last: round(valid.at(-1)), min: round(sorted[0]),
    p50: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95: round(sorted[Math.ceil(sorted.length * .95) - 1]), max: round(sorted.at(-1)) }
}

export async function summarizeCampaign(root) {
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  const [metrics, runtime] = await Promise.all(['metrics', 'runtime'].map(name => jsonLines(join(state.evidenceRoot || join(root, 'evidence'), name + '.jsonl'))))
  const os = metrics.map(row => row.diagnostics?.resources).filter(row => row?.state === 'available')
  const rt = runtime.map(row => row.runtime).filter(Boolean)
  const modes = Object.fromEntries(['code', 'work'].map(mode => {
    const owner = state.modes[mode]
    const tools = new Map()
    for (const entry of owner.submissions) for (const tool of entry.browserEvidence || []) tools.set(tool.rootRunId + ':' + tool.id, tool)
    const receipts = [...tools.values()]
    return [mode, { sessionId: owner.sessionId, workspace: state.workspaces[mode], origin: state.origins[mode],
      currentRun: owner.lastStatus?.run?.runId, durableStatus: owner.lastStatus?.run?.status, blocked: owner.blocked,
      requirementsSucceeded: owner.submissions.filter(item => item.kind === 'requirement' && (item.terminalOutcome === 'succeeded' || item.resolution?.verified)).length,
      requirementsSubmitted: owner.submissions.filter(item => item.kind === 'requirement').length,
      browser: { receipts: receipts.length, succeeded: receipts.filter(item => item.success === true && item.status === 'succeeded').length,
        failed: receipts.filter(item => item.success === false).map(item => ({ runId: item.rootRunId, id: item.id, name: item.name, code: item.errorCode })) },
      submissions: owner.submissions.map(item => ({ id: item.id, kind: item.kind, runId: item.admittedRunId,
        outcome: item.terminalOutcome, submittedAt: item.submittedAt, resolution: item.resolution })) }]
  }))
  return { schemaVersion: 1, runRoot: resolve(root), phase: state.phase, startedAt: state.startedAt, finishedAt: state.finishedAt,
    segmentId: state.segmentId, activeMinutes: round(state.sampledActiveMs / 60000), concurrentMinutes: round(state.sampledConcurrentMs / 60000),
    continuousActiveMinutes: round((state.continuousActiveMs || 0) / 60000),
    longestContinuousActiveMinutes: round((state.longestContinuousActiveMs || 0) / 60000),
    observationGapCount: state.observationGapCount || 0, previousSegments: state.previousSegments || [], modeSwitches: state.modeSwitches,
    modelId: state.modelId, engine: { instanceId: state.engine?.instanceId, buildId: state.engine?.buildId }, modes,
    metrics: { availableOSSamples: os.length, runtimeSamples: rt.length,
      cpuPercentOneLogicalCore: distribution(os.map(row => row.cpu?.percent)), rssMiB: distribution(os.map(row => mib(row.memory?.rssBytes))),
      privateMiB: distribution(os.map(row => mib(row.memory?.privateBytes))), heapMiB: distribution(rt.map(row => mib(row.memory?.heapUsedBytes))),
      processReadMiBPerSec: distribution(os.map(row => mib(row.io?.readBytesPerSecond))), processWriteMiBPerSec: distribution(os.map(row => mib(row.io?.writeBytesPerSecond))),
      storageMiB: distribution(metrics.map(row => mib(row.diagnostics?.storage?.totalBytes))),
      eventLoopP95Ms: distribution(rt.filter(row => row.eventLoop?.state === 'available').map(row => row.eventLoop.delay?.p95Ms)),
      eventLoopMaxMs: distribution(rt.filter(row => row.eventLoop?.state === 'available').map(row => row.eventLoop.delay?.maxMs)),
      eventLoopUnavailableSamples: rt.filter(row => row.eventLoop?.state !== 'available').length,
      partialProcessTreeSamples: os.filter(row => row.processTree?.partial).length,
      collectionMs: distribution(os.map(row => row.collection?.durationMs)) },
    issues: state.issues, rendererErrors: state.rendererErrors, processErrors: state.processErrors,
    productAcceptance: state.productAcceptance, executionPassed: state.executionPassed,
    limitations: ['OS metrics cover the engine process; partial process-tree samples are not complete application totals.',
      'Process I/O includes operating-system accounted I/O and is not a physical-disk throughput measurement.',
      'Sampled active time requires the same durable run to be running at both interval endpoints; idle time is excluded.',
      'Prior failed segments are reported separately and never count toward this segment active-load target; observation gaps are excluded.',
      'Successful run status alone does not establish every product acceptance criterion.', state.fileWriteIsolation].filter(Boolean) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/summarize-dual-mode-campaign.mjs <runRoot>')
  console.log(JSON.stringify(await summarizeCampaign(resolve(process.argv[2])), null, 2))
}
