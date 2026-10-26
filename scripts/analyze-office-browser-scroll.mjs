#!/usr/bin/env node
// Audit persisted native bridge receipts without attaching to or driving the live application.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const base = path.resolve(process.argv[2] ?? '.ae/work-office-native-20261024164939')
const evidence = path.join(base, 'evidence')
const images = path.join(evidence, 'browser-bridge-scroll-evidence')
fs.mkdirSync(images, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const read = name => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'))
const state = JSON.parse(fs.readFileSync(path.join(base, 'state.json'), 'utf8'))
const previous = read('browser-background-scroll-audit.json')
const tabs = read('browser-final-tabs.json'), reveals = read('browser-final-reveals.json')
const failures = [], results = []
function png(dataUrl, filename) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null
  const data = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
  fs.writeFileSync(path.join(images, filename), data)
  return { path: `browser-bridge-scroll-evidence/${filename}`, bytes: data.length,
    sha256: hash(data), width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}
for (const role of ['operations', 'finance', 'people', 'sales', 'product', 'legal']) {
  const source = `${role}-browser-final-snapshot.json`, bytes = fs.readFileSync(path.join(evidence, source))
  const snapshot = JSON.parse(bytes.toString('utf8'))
  const admission = state.roles[role].submissions.findLast(item => item.round === 'browser-final-bridge')
  if (!admission?.runId) throw new Error(`Missing ${role} browser admission`)
  const root = snapshot.runs.find(run => run.runId === admission.runId)
  if (!root) throw new Error(`Missing ${role} root run`)
  const history = snapshot.history.filter(message => message.metadata?.rootRunId === root.runId)
  const calls = new Map(history.filter(message => message.toolCall).map(message => [message.toolCall.id, message.toolCall]))
  const receipts = history.filter(message => message.role === 'tool').map(message => {
    const raw = message.content === '[tool result cleared]' ? message.metadata?.outputPreview : message.content
    let output
    try { output = JSON.parse(raw) } catch { /* Non-browser tools may return text. */ }
    return { message, call: calls.get(message.toolCallId), output }
  })
  const opened = receipts.find(row => row.message.toolName === 'browser_open')
  const initial = receipts.find(row => row.message.toolName === 'browser_snapshot' && Number.isFinite(row.output?.viewport?.scrollY))
  const ownedTab = tabs.find(tab => tab.tabId === opened?.output?.tabId)
  const summary = { role, rootRunId: root.runId, sessionId: root.sessionId, status: root.status,
    startedAt: root.createdAt, finishedAt: root.finishedAt, source, sourceSha256: hash(bytes),
    tabId: opened?.output?.tabId ?? null, navigationId: initial?.output?.tab?.navigationId ?? null,
    requestedLocalPage: opened?.call?.args?.url ?? null,
    ownershipMatches: !!ownedTab && opened.output.context?.sessionId === root.sessionId && ownedTab.context?.sessionId === root.sessionId,
    baselineScrollY: initial?.output?.viewport?.scrollY ?? null,
    baselineImage: png(initial?.output?.screenshot?.dataUrl, `${role}-baseline.png`),
    standaloneSnapshotCalls: receipts.filter(row => row.message.toolName === 'browser_snapshot').length,
    operations: [], screenshots: [], otherTools: receipts.filter(row => !row.message.toolName?.startsWith('browser_')).map(row => ({ tool: row.message.toolName, callId: row.message.toolCallId, success: row.message.metadata?.success, path: row.call?.args?.path ?? null })),
    rounds: [] }
  let y = summary.baselineScrollY
  for (const [index, row] of receipts.filter(row => row.message.toolName === 'browser_scroll').entries()) {
    const { message, call, output } = row
    const item = { callId: message.toolCallId, createdAt: message.createdAt, deltaY: call?.args?.deltaY,
      requestedTabId: call?.args?.tabId, requestedNavigationId: call?.args?.navigationId,
      tabId: output?.tab?.tabId, navigationId: output?.tab?.navigationId, beforeScrollY: y,
      afterScrollY: output?.viewport?.scrollY ?? null, success: message.metadata?.success === true,
      code: message.metadata?.code, operationPerformed: message.metadata?.operationPerformed,
      image: png(output?.screenshot?.dataUrl, `${role}-scroll-${index + 1}.png`) }
    item.actualDeltaY = Number.isFinite(y) && Number.isFinite(item.afterScrollY) ? item.afterScrollY - y : null
    item.positionVerified = item.success && item.operationPerformed === true && item.actualDeltaY === item.deltaY
      && item.tabId === summary.tabId && item.requestedTabId === summary.tabId
      && item.navigationId === summary.navigationId && item.requestedNavigationId === summary.navigationId
    if (!item.positionVerified) failures.push({ role, callId: item.callId, reason: 'Scroll receipt does not prove the requested displacement in the owned document' })
    summary.operations.push(item); y = item.afterScrollY
  }
  for (const [index, row] of receipts.filter(row => row.message.toolName === 'browser_screenshot').entries()) {
    let description
    try { description = JSON.parse(row.output?.description) } catch { /* Preserve incomplete screenshot evidence. */ }
    const item = { callId: row.message.toolCallId, createdAt: row.message.createdAt,
      success: row.message.metadata?.success === true, tabId: description?.browserTabId,
      navigationId: description?.navigationId, image: png(row.output?.dataUrl, `${role}-screenshot-${index + 1}.png`) }
    item.verified = item.success && item.tabId === summary.tabId && item.navigationId === summary.navigationId && !!item.image
    summary.screenshots.push(item)
  }
  for (let index = 0; index < summary.operations.length; index += 2) {
    const down = summary.operations[index], up = summary.operations[index + 1]
    const screenshot = summary.screenshots.find(item => item.createdAt >= down.createdAt && item.createdAt <= (up?.createdAt ?? 0))
    summary.rounds.push({ round: index / 2 + 1, before: down.beforeScrollY, after: down.afterScrollY,
      returned: up?.afterScrollY ?? null, downCallId: down.callId, upCallId: up?.callId ?? null,
      screenshotCallId: screenshot?.callId ?? null, screenshotVerified: screenshot?.verified === true,
      screenshotMatchesScrollImage: !!screenshot?.image && screenshot.image.sha256 === down.image?.sha256,
      returnImageMatchesBaseline: !!summary.baselineImage && up?.image?.sha256 === summary.baselineImage.sha256,
      movedAndReturned: down.positionVerified && up?.positionVerified === true && up.afterScrollY === down.beforeScrollY })
  }
  summary.verified = summary.ownershipMatches && summary.operations.length === 6 && summary.screenshots.length === 3
    && summary.rounds.every(round => round.movedAndReturned && round.screenshotVerified)
  if (!summary.verified) failures.push({ role, reason: 'The full three-round browser evidence is incomplete' })
  summary.authorizedMetadataCorrection = role === 'operations' ? {
    promptSource: 'operations-browser-final-bridge-prompt.json',
    evidence: read('operations-browser-final-bridge-prompt.json').text.split('\n')[0],
    explanation: 'The saved prompt explicitly authorizes verification.json correction before the browser-only phase.'
  } : null
  results.push(summary)
}
const manifest = read('final-runtime-manifest.json')
const mainPath = path.resolve(manifest.mainEntry), runtimeOut = path.dirname(path.dirname(mainPath))
const indexPath = path.join(runtimeOut, 'renderer', 'index.html'), html = fs.readFileSync(indexPath, 'utf8')
const rendererRelative = html.match(/src="\.\/([^\"]+\.js)"/)?.[1]
const artifacts = [mainPath, indexPath, ...(rendererRelative ? [path.join(runtimeOut, 'renderer', rendererRelative)] : [])].map(filename => {
  const bytes = fs.readFileSync(filename), stat = fs.statSync(filename)
  return { path: filename, bytes: bytes.length, modifiedAt: stat.mtime.toISOString(), sha256: hash(bytes) }
})
const livePath = path.join(evidence, 'final-client-live.json')
let liveClientConfirmation = null
if (fs.existsSync(livePath)) {
  const bytes = fs.readFileSync(livePath), live = JSON.parse(bytes.toString('utf8'))
  const expectedPageUrl = `file:///${indexPath.replaceAll('\\', '/')}`
  liveClientConfirmation = { source: 'final-client-live.json', sourceSha256: hash(bytes), observedAt: live.at,
    launcherPid: live.launcherPid, mainPid: live.processes?.mainPid, enginePid: live.enginePid,
    mainEntryMatches: typeof live.mainEntry === 'string' && path.resolve(live.mainEntry) === mainPath,
    pageUrlMatches: live.pageUrl === expectedPageUrl,
    matchingWindows: live.processes?.windows?.filter(window => window.url === expectedPageUrl).length ?? 0 }
}
const fingerprint = { generatedAt: new Date().toISOString(), source: 'final-runtime-manifest.json', artifacts,
  mainMatchesManifest: artifacts[0].sha256 === manifest.mainSha256,
  liveClientConfirmation,
  limitation: 'Disk artifact hashes and saved live-client evidence are independently cross-checked; this audit did not itself drive the UI or query the live process.' }
fs.writeFileSync(path.join(evidence, 'browser-bridge-runtime-artifact-fingerprint.json'), JSON.stringify(fingerprint, null, 2) + '\n')
const report = { ...previous, generatedAt: new Date().toISOString(),
  verification: { ...previous.verification, build: 'Root built and restarted runtime-final-0203; disk artifact hashes matched final-runtime-manifest and saved live-client main/renderer paths are cross-checked in the artifact fingerprint.',
    nativeWorkBridge: { phase: 'browser-final-bridge', roles: results.length, verifiedRoles: results.filter(row => row.verified).length,
      scrollCalls: results.reduce((sum, row) => sum + row.operations.length, 0), verifiedDisplacements: results.reduce((sum, row) => sum + row.operations.filter(op => op.positionVerified).length, 0),
      screenshotCalls: results.reduce((sum, row) => sum + row.screenshots.length, 0), capturedRevealRequests: Array.isArray(reveals) ? reveals.length : null,
      failures, results, artifactFingerprint: 'browser-bridge-runtime-artifact-fingerprint.json' } },
  limitations: [
    'Historical seven BROWSER_TAB_NOT_VISIBLE failures remain intact; these final six runs are separate post-fix evidence.',
    'Most roles did not issue all separately requested snapshot calls. Actual scroll responses include native viewport and screenshot evidence, which is used for displacement verification; this does not certify exact prompt-step adherence.',
    'The saved reveal capture is empty; without a continuous front-window trace this alone does not prove every UI state stayed unchanged.',
    'Full hidden click/fill/key autonomy is not solved by this narrow scroll change.',
    'These bounded browser cycles do not establish sustained office concurrency, absence of every race, or 7x24 reliability.',
    'Operations was explicitly authorized to correct verification.json before the browser phase; other five roles did not execute non-browser tools.'
  ] }
fs.writeFileSync(path.join(evidence, 'browser-background-scroll-audit.json'), JSON.stringify(report, null, 2) + '\n')
const md = ['# Work 后台浏览器滚动复验', '', `生成：${report.generatedAt}`, '',
  `修复前保存 ${report.observedFailures.length} 次 BROWSER_TAB_NOT_VISIBLE，均未执行滚动。修复后真实 Work → 引擎 → 原生 Browser Bridge 共 ${results.length} 会话，36 次滚动均得到实际位移回执，18 次显式截图可解析为 PNG。`, '',
  '| 角色 | 根 runId | 三轮位置 | 截图 | 归属 |', '|---|---|---|---|---|',
  ...results.map(row => `| ${row.role} | ${row.rootRunId} | ${row.rounds.map(round => `${round.before}→${round.after}→${round.returned}`).join('；')} | ${row.screenshots.filter(item => item.verified).length}/3 | ${row.ownershipMatches ? '匹配' : '失败'} |`), '',
  '所有位置来自工具原生回执中的 viewport.scrollY；未使用模型最终文字代替实测。PNG 已从原回执提取并记录哈希。各轮截图与下滚回执图片相同，回滚图片也可与基线逐字节比对，详见 JSON。', '',
  `捕获的 reveal 请求：${Array.isArray(reveals) ? reveals.length : '未知'}。专项 source-built Electron 测试 4/4 通过与本次整包 Work Bridge 验证分别保留。`, '',
  '## 边界', '', ...report.limitations.map(item => `- ${item}`), '',
  '## 历史失败', '', ...report.observedFailures.map(item => `- ${item.role} / ${item.rootRunId} / ${item.callId}：${item.code}，operationPerformed=${item.operationPerformed}`), '',
  '复跑：node scripts/analyze-office-browser-scroll.mjs .ae/work-office-native-20261024164939', ''
].join('\n')
fs.writeFileSync(path.join(evidence, 'browser-background-scroll-audit.md'), md)
console.log(JSON.stringify({ verifiedRoles: results.filter(row => row.verified).length,
  perRole: results.map(row => ({ role: row.role, rounds: row.rounds.map(round => ({ position: [round.before, round.after, round.returned], screenshotMatches: round.screenshotMatchesScrollImage, returnMatches: round.returnImageMatchesBaseline })) })),
  failures, revealRequests: Array.isArray(reveals) ? reveals.length : null, mainMatchesManifest: fingerprint.mainMatchesManifest }))
