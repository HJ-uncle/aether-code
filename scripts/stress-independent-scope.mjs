// Pure scope/receipt checks plus explicit read-only SQLite auditing; importing starts no runtime.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const independentScenarioVersion = 'independent-six-tasks-v1-protected-brief-cron2'
export const collaborationEnabled = false
export const independentBoundary = '六个任务完全独立。只操作本任务工作区及本父任务明确选择的实现/审查子Agent；不得读取、调用或向其他lane的工作区、根会话、Agent或child交接。允许用subagent启动本任务所选子Agent，并按resumeBoundary在本父任务内续跑。'
export const independentLanes = ['code-a', 'code-b', 'work-a', 'work-b', 'cron-a', 'cron-b']
export const independentTools = ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_search', 'glob_search', 'execute_cmd', 'command_output', 'cancel_command', 'subagent', 'get_current_context', 'plan_update']
const hash = value => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const within = (parent, target) => { const relative = path.relative(canonical(parent), canonical(target)); return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

export function independentScenarioReasons(config) {
  const reasons = []
  if (config?.scenarioVersion !== independentScenarioVersion) reasons.push('Prepared scenario is not the fresh independent six-task version')
  if (config?.collaborationEnabled !== false) reasons.push('Independent workload must explicitly set collaborationEnabled=false')
  if (config?.independentBoundary !== independentBoundary) reasons.push('Independent workload boundary is missing or stale')
  if (config?.cooperationProtocol !== undefined) reasons.push('Independent preparation still contains a cooperation protocol')
  return reasons
}

function regularPath(base, target, directory) {
  if (!within(base, target)) throw new Error('Evidence path escapes its owned base')
  if (fs.lstatSync(base).isSymbolicLink()) throw new Error('Linked owned base')
  let cursor = base
  for (const segment of path.relative(base, target).split(path.sep)) {
    cursor = path.join(cursor, segment)
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Linked owned path')
  }
  const entry = fs.lstatSync(target)
  if (directory ? !entry.isDirectory() : !entry.isFile()) throw new Error('Evidence has the wrong filesystem type')
  const realBase = fs.realpathSync(base), realTarget = fs.realpathSync(target)
  if (!within(realBase, realTarget)) throw new Error('Owned path resolves outside its base')
}

export function independentScopeReasons(config, root, { checkDisk = true } = {}) {
  const reasons = [...independentScenarioReasons(config)]
  if (!nonempty(config?.dbFile) || canonical(config.dbFile) !== canonical(path.join(root, 'agent.db'))) reasons.push('Prepared database is not the exact owned agent.db')
  else if (checkDisk) { try { regularPath(path.resolve(root), path.resolve(config.dbFile), false) } catch (error) { reasons.push('Owned database failed canonical filesystem audit: ' + error.message) } }
  const sessions = Array.isArray(config?.sessions) ? config.sessions : []
  if (!Array.isArray(config?.tools) || JSON.stringify([...config.tools].sort()) !== JSON.stringify([...independentTools].sort())) reasons.push('Independent workload tool set is missing, duplicated or admits peer/native cooperation tools')
  if (sessions.length !== 6 || JSON.stringify(sessions.map(item => item.lane).sort()) !== JSON.stringify([...independentLanes].sort())) reasons.push('Exactly the six admitted independent lanes are required')
  if (new Set(sessions.map(item => item.sessionId)).size !== 6 || sessions.some(item => !nonempty(item.sessionId))) reasons.push('Lane session identities are missing or duplicated')
  const agentIds = sessions.flatMap(item => [item.agentId, item.actorId, item.reviewerId])
  if (agentIds.some(id => !nonempty(id)) || new Set(agentIds).size !== 18) reasons.push('Each independent lane must have its own distinct root, actor and reviewer Agent identities')
  const paths = []
  for (const lane of sessions) {
    if (!independentLanes.includes(lane.lane) || lane.kind !== lane.lane.split('-')[0]) reasons.push('Lane mode identity differs from its admitted lane')
    if (!nonempty(lane.workspacePath) || !path.isAbsolute(lane.workspacePath)) { reasons.push('Lane workspace is not absolute'); continue }
    const expected = lane.kind === 'cron' ? path.join(root, 'workspaces', 'default', lane.sessionId) : path.join(root, 'workspaces', 'projects', lane.lane)
    if (canonical(expected) !== canonical(lane.workspacePath)) reasons.push('Lane workspace differs from its own independent directory: ' + lane.lane)
    if (!within(path.join(root, 'workspaces'), lane.workspacePath)) reasons.push('Lane workspace escapes the owned workspace tree: ' + lane.lane)
    paths.push(canonical(lane.workspacePath))
    if (checkDisk) { try { regularPath(path.resolve(root), path.resolve(lane.workspacePath), true) } catch (error) { reasons.push('Lane workspace failed canonical filesystem audit: ' + lane.lane + ': ' + error.message) } }
  }
  if (new Set(paths).size !== 6 || paths.some((left, index) => paths.some((right, other) => index !== other && within(left, right)))) reasons.push('Independent workspaces duplicate, overlap or contain another lane')
  return reasons
}

export function rootIdentityMatches(lane, run) {
  const request = run?.request ?? run?.requestConfig
  if (run?.request && run.requestConfig && run.request.agentId !== run.requestConfig.agentId) return false
  return run?.status === 'succeeded' && nonempty(lane?.agentId) && run.sessionId === lane.sessionId
    && request?.agentId === lane.agentId && nonempty(run.runId) && nonempty(run.turnId)
}

export function auditIndependentNativeMessages(db, config) {
  const owned = new Set(config.sessions.map(item => item.sessionId))
  const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
  const receipt = { schemaVersion: 1, runId: config.runId, auditedAt: new Date().toISOString(), scope: 'owned campaign root_runs.sessionId to collaboration_messages.root_run_id', schemaPresent: false, ownedRootIds: [], count: null, zero: false }
  if (!exists('root_runs') || !exists('collaboration_messages')) return { ...receipt, error: 'Required owned-root/native-message table is missing; absence is not zero' }
  const roots = db.prepare("SELECT state FROM root_runs WHERE tenant_id='default'").all().map(row => JSON.parse(row.state)).filter(run => owned.has(run.sessionId))
  receipt.ownedRootIds = [...new Set(roots.map(run => run.runId))].sort()
  if (receipt.ownedRootIds.some(id => !nonempty(id))) throw new Error('Owned root has no canonical run identity')
  const ids = new Set(receipt.ownedRootIds)
  receipt.schemaPresent = true
  receipt.count = db.prepare("SELECT root_run_id FROM collaboration_messages WHERE tenant_id='default'").all().filter(row => ids.has(row.root_run_id)).length
  receipt.zero = receipt.count === 0
  return receipt
}

function immutable(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST' || fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(bytes)) throw error }
  return { file, sha256: hash(bytes) }
}

export function pinIndependentVerification(root, check) {
  if (check.passed !== true || !independentLanes.includes(check.lane) || !nonempty(check.generationRunId) || !/^[a-zA-Z0-9_.-]+$/.test(check.generationRunId) || !Number.isSafeInteger(check.round) || check.round < 1) throw new Error('Only an actual passed owned verification can be pinned')
  regularPath(path.resolve(root), path.resolve(check.sourceFile), false)
  regularPath(path.resolve(root), path.resolve(check.contractFile), false)
  const source = fs.readFileSync(check.sourceFile), contract = fs.readFileSync(check.contractFile)
  if (hash(source) !== check.sourceSha256 || hash(contract) !== check.contractSha256) throw new Error('Verification source or contract changed before receipt pinning')
  const base = path.join(root, 'independent-verifications', check.lane, `${check.round}-${check.generationRunId}`)
  let cursor = path.resolve(root)
  for (const segment of path.relative(cursor, base).split(path.sep)) {
    cursor = path.join(cursor, segment)
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor)
    if (fs.lstatSync(cursor).isSymbolicLink() || !fs.lstatSync(cursor).isDirectory()) throw new Error('Linked verification receipt parent')
  }
  regularPath(path.resolve(root), base, true)
  const artifacts = { source: immutable(path.join(base, 'source.mjs'), source), contract: immutable(path.join(base, 'contract.json'), contract) }
  regularPath(path.resolve(root), path.resolve(artifacts.source.file), false)
  regularPath(path.resolve(root), path.resolve(artifacts.contract.file), false)
  return artifacts
}

export function independentWorkloadReasons(config, engine, root, { checkDisk = true, roots = null, children = null, nativeAudit = null, modelEvidence = null } = {}) {
  const reasons = independentScopeReasons(config, root, { checkDisk })
  const gate = (condition, text) => { if (!condition) reasons.push(text) }
  gate(config.minutes === 60, 'The admitted formal independent workload must last sixty minutes')
  gate(engine?.scenarioVersion === independentScenarioVersion && engine?.collaborationEnabled === false, 'Engine result has the wrong independent scenario or collaboration flag')
  gate(engine?.runId === config.runId, 'Engine independent result belongs to a foreign workload')
  gate(engine?.modelSwitchingCovered === true, 'Independent model switching is incomplete')
  gate(engine?.engineAcceptance === true && engine?.complete === true && engine?.durationSatisfied === true && engine?.measuredWallMinutes >= 60 && !engine?.failure, 'Independent workload did not complete its sixty-minute acceptance')
  gate(engine?.cleanup?.clean === true, 'Independent engine cleanup is not clean')
  gate(engine?.taskIsolation?.independent === true && Array.isArray(engine?.taskIsolation?.reasons) && !engine.taskIsolation.reasons.length
    && JSON.stringify(engine.taskIsolation.workspacePaths) === JSON.stringify(config.sessions.map(item => item.workspacePath)), 'Declared independent scope differs from its prepared workspaces')
  gate(Array.isArray(engine?.ownershipViolations) && engine.ownershipViolations.length === 0 && Array.isArray(engine?.fatalErrors) && engine.fatalErrors.length === 0, 'Independent workload contains ownership or fatal errors')
  const start = Date.parse(engine?.startedAt), end = Date.parse(engine?.deadline), cutoff = Date.parse(engine?.endedAt)
  gate(Number.isFinite(start) && Number.isFinite(end) && end - start === 60 * 60000, 'Independent formal window is missing or invalid')
  gate(Number.isFinite(cutoff) && cutoff >= end && engine.measuredWallMinutes === (cutoff - start) / 60000, 'Independent cutoff timing differs from its measured wall duration')
  const lanes = Array.isArray(engine?.sessions) ? engine.sessions : []
  gate(lanes.length === 6 && new Set(lanes.map(item => item.lane)).size === 6, 'Independent result lacks six unique lane receipts')
  for (const expected of config.sessions ?? []) {
    const lane = lanes.find(item => item.lane === expected.lane)
    if (!lane) { reasons.push('Missing independent lane: ' + expected.lane); continue }
    gate(lane.kind === expected.kind && lane.sessionId === expected.sessionId && canonical(lane.workspacePath ?? '') === canonical(expected.workspacePath), 'Result lane scope changed: ' + expected.lane)
    gate(lane.accepted >= 2 && lane.rejected === 0 && lane.subagentRuns >= 2 && lane.reusedChildRuns >= 1 && lane.supplySatisfied === true && lane.errorFree === true, 'Independent accepted rounds, child reuse or continuous progress incomplete: ' + expected.lane)
    gate(Array.isArray(lane.failures) && !lane.failures.length && Array.isArray(lane.failedExecutions) && !lane.failedExecutions.length, 'Independent lane contains failed executions: ' + expected.lane)
    gate([config.primary, config.qwen].every(model => lane.effectiveModels?.includes(model)), 'Lane did not actually use both admitted models: ' + expected.lane)
    gate(lane.activity?.longestIdleMs <= 120000 && lane.longestProgressGapMs <= 5 * 60000, 'Independent lane activity has an excessive gap: ' + expected.lane)
    if (modelEvidence) {
      const actualModels = [...new Set(modelEvidence.filter(item => item.lane === expected.lane && item.createdAt >= start && item.createdAt < end).map(item => item.modelId))].sort()
      gate([config.primary, config.qwen].every(model => actualModels.includes(model)) && JSON.stringify([...(lane.effectiveModels ?? [])].sort()) === JSON.stringify(actualModels), 'Read-only model-message recount differs from configured coverage or reported models: ' + expected.lane)
    }
    if (children) {
      const own = children.filter(item => item.parentSessionId === expected.sessionId)
      const reusable = own.filter(item => {
        const prior = own.find(run => run.runId === item.resumeFromRunId)
        return prior && ['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked', 'timed_out'].includes(prior.status)
          && item.rootSessionId === expected.sessionId && prior.rootSessionId === expected.sessionId && item.childSessionId === prior.childSessionId
          && item.agentId === prior.agentId && [expected.actorId, expected.reviewerId].includes(item.agentId)
          && item.status === 'succeeded' && item.finishedAt <= end && item.createdAt >= start && item.createdAt >= prior.finishedAt
          && item.toolCalls?.some(tool => !['plan_update', 'todo_list', 'todo_create', 'todo_update', 'todo_delete'].includes(tool.name) && tool.status === 'succeeded' && tool.finishedAt >= start && tool.finishedAt <= end)
      })
      gate(own.length >= 2 && reusable.length >= 1 && lane.subagentRuns === own.length && lane.reusedChildRuns === reusable.length
        && Array.isArray(lane.reuseEvidence) && lane.reuseEvidence.length === reusable.length && new Set(lane.reuseEvidence.map(item => item.runId)).size === reusable.length
        && lane.reuseEvidence.every(item => reusable.some(actual => actual.runId === item.runId && actual.resumeFromRunId === item.resumeFromRunId && actual.childSessionId === item.childSessionId && actual.agentId === item.agentId)), 'Read-only child archive recount lacks owned continuation evidence: ' + expected.lane)
    }
    if (roots && children) {
      const actualFailures = [...roots.filter(item => item.sessionId === expected.sessionId), ...children.filter(item => item.parentSessionId === expected.sessionId)]
        .filter(item => ['failed', 'blocked', 'interrupted'].includes(item.status) && (!Number.isFinite(item.finishedAt) || item.finishedAt <= cutoff))
      gate(actualFailures.length === 0, 'Read-only campaign archive retains warmup or formal execution failures: ' + expected.lane)
    }
    const receipts = Array.isArray(lane.verificationReceipts) ? lane.verificationReceipts : []
    const acceptedRounds = Array.isArray(lane.acceptedRounds) ? lane.acceptedRounds : []
    const completeRounds = new Set()
    const validReceipts = []
    for (const item of receipts.filter(item => item.passed && acceptedRounds.includes(item.round) && item.at >= start && item.at <= end)) {
      let valid = item.lane === expected.lane && nonempty(item.generationRunId) && Number.isSafeInteger(item.round) && item.round > 0 && item.cases === 80 && item.plannedCases === 80 && item.receiptVerified === true && item.code === 0 && item.timedOut === false && hashPattern.test(item.contractSha256) && hashPattern.test(item.sourceSha256)
        && item.receipt?.verifier === 'protected-contract-v1' && item.receipt?.passed === true && item.receipt?.round === item.round && item.receipt?.casesPlanned === 80 && item.receipt?.casesExecuted === 80
      if (roots) valid &&= rootIdentityMatches(expected, roots.find(run => run.runId === item.generationRunId))
      if (checkDisk && valid) {
        try {
          for (const [kind, expectedHash, leaf] of [['source', item.sourceSha256, 'source.mjs'], ['contract', item.contractSha256, 'contract.json']]) {
            const ref = item.artifacts?.[kind]
            const expectedPath = path.join(root, 'independent-verifications', expected.lane, `${item.round}-${item.generationRunId}`, leaf)
            if (!ref || canonical(ref.file) !== canonical(expectedPath) || ref.sha256 !== expectedHash) throw new Error('Pinned verification reference is foreign or incomplete')
            regularPath(path.resolve(root), path.resolve(ref.file), false)
            if (hash(fs.readFileSync(ref.file)) !== expectedHash) throw new Error('Pinned verification bytes changed')
            if (kind === 'contract') {
              const contract = JSON.parse(fs.readFileSync(ref.file, 'utf8'))
              if (contract.round !== item.round || contract.lane !== expected.lane || !Array.isArray(contract.cases) || contract.cases.length !== 80) throw new Error('Pinned 80-case contract has a foreign identity')
            }
          }
        } catch { valid = false }
      }
      if (valid) { completeRounds.add(item.round); validReceipts.push(item) }
    }
    gate(completeRounds.size >= 2, 'Lane lacks two independently linked formal 80-case accepted revisions: ' + expected.lane)
    const settlements = Array.isArray(lane.acceptedSettlements) ? lane.acceptedSettlements : []
    const validSettlements = settlements.filter(item => item?.passed === true && Number.isFinite(item.at) && item.at >= start && item.at < end
      && acceptedRounds.includes(item.round) && validReceipts.some(receipt => receipt.round === item.round && receipt.generationRunId === item.generationRunId && receipt.at <= item.at))
    gate(validSettlements.length === settlements.filter(item => item?.at >= start && item.at < end).length && new Set(validSettlements.map(item => item.round)).size >= 2
      && new Set(validSettlements.map(item => item.generationRunId)).size === validSettlements.length
      && new Set(validSettlements.map(item => item.round)).size === validSettlements.length, 'Formal accepted revisions repeat a generation root or lack linked receipts: ' + expected.lane)
    const expectedWindows = []
    if (Number.isFinite(start) && Number.isFinite(end) && end - start === 60 * 60000) {
      for (let begin = start; begin < end; begin += 30 * 60000) {
        const until = Math.min(begin + 30 * 60000, end)
        expectedWindows.push({ start: new Date(begin).toISOString(), end: new Date(until).toISOString(), fullWindow: true, accepted: validSettlements.filter(item => item.at >= begin && item.at < until).length })
      }
    }
    gate(expectedWindows.length === 2 && expectedWindows.every(item => item.accepted > 0)
      && Array.isArray(lane.acceptanceWindows) && lane.acceptanceWindows.length === expectedWindows.length
      && expectedWindows.every((item, index) => Object.entries(item).every(([key, value]) => lane.acceptanceWindows[index]?.[key] === value)), 'Formal thirty-minute windows differ from independently recounted accepted revisions: ' + expected.lane)
  }
  const native = engine?.nativeMessages
  gate(native?.schemaVersion === 1 && native?.runId === config.runId && native?.schemaPresent === true && native?.count === 0 && native?.zero === true && Array.isArray(native?.ownedRootIds) && native.ownedRootIds.length >= 6, 'Native messages are nonzero or lack complete scoped evidence')
  if (nativeAudit) gate(nativeAudit.runId === config.runId && nativeAudit.schemaPresent === true && nativeAudit.zero === true && nativeAudit.count === 0 && JSON.stringify(nativeAudit.ownedRootIds) === JSON.stringify(native?.ownedRootIds), 'Read-only final native-message recount differs from the engine receipt')
  return reasons
}
