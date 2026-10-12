import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const stageNames = ['normalize', 'select', 'price', 'summarize', 'rank']
const sha = text => crypto.createHash('sha256').update(text).digest('hex')
const read = file => {
  if (fs.statSync(file).size > 1024 * 1024) throw new Error(`Evidence file too large: ${file}`)
  return fs.readFileSync(file, 'utf8')
}

export function policyFor(round) {
  return { minQty: 1 + round % 3, excludedCategory: round % 2 ? 'blocked' : 'obsolete',
    discountBps: 100 + (round * 137) % 900, taxBps: 500 + (round * 71) % 700, offset: round % 2, limit: 2 + round % 3 }
}

export function reference(stage, rows, policy) {
  if (stage === 0) return rows.map(row => ({ id: String(row.id ?? '').trim(), category: String(row.category ?? '').trim().toLowerCase(), qty: Math.floor(Number(row.qty)), unitCents: Math.round(Number(row.unitCents)) }))
    .filter(row => row.id && Number.isFinite(row.qty) && row.qty > 0 && Number.isFinite(row.unitCents) && row.unitCents >= 0)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (stage === 1) return rows.filter(row => row.qty >= policy.minQty && row.category !== policy.excludedCategory).map(row => ({ ...row }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (stage === 2) return rows.map(row => {
    const subtotalCents = row.qty * row.unitCents
    const discountCents = Math.floor(subtotalCents * policy.discountBps / 10000)
    const taxCents = Math.round((subtotalCents - discountCents) * policy.taxBps / 10000)
    return { ...row, subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents }
  })
  if (stage === 3) {
    const groups = new Map()
    for (const row of rows) {
      const group = groups.get(row.category) || { category: row.category, orders: 0, qty: 0, totalCents: 0 }
      group.orders += 1; group.qty += row.qty; group.totalCents += row.totalCents
      groups.set(row.category, group)
    }
    return [...groups.values()].sort((a, b) => a.category < b.category ? -1 : a.category > b.category ? 1 : 0)
  }
  return rows.map(row => ({ ...row })).sort((a, b) => b.totalCents - a.totalCents || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
    .map((row, index) => ({ ...row, rank: index + 1 })).slice(policy.offset, policy.offset + policy.limit)
}

function casesFor(stage, round, count = 8) {
  const policy = policyFor(round)
  const cases = [[]]
  for (let index = 0; index < count; index += 1) {
    let rows = Array.from({ length: 9 }, (_, n) => ({ id: ` id-${(n * 7 + index) % 11} `,
      category: [' Hardware ', 'SOFTWARE', 'blocked', 'obsolete', '__proto__'][n % 5],
      qty: String((n + round + index) % 5), unitCents: String((index * 31 + n * 73 + round) % 400) }))
    rows.push({ id: '', category: 'bad', qty: 1, unitCents: 5 }, { id: 'invalid', category: 'bad', qty: 'NaN', unitCents: 4 }, { id: 'negative', category: 'bad', qty: 3, unitCents: -2 })
    if (stage > 0) rows = reference(0, rows, policy)
    if (stage >= 3) rows = reference(2, rows, policy)
    if (stage === 4) rows = reference(3, rows, policy)
    cases.push(rows)
  }
  return cases.map(input => ({ input, expected: reference(stage, input, policy) }))
}

const contracts = [
  'Convert each row to exactly {id:String(id??"").trim(),category:String(category??"").trim().toLowerCase(),qty:Math.floor(Number(qty)),unitCents:Math.round(Number(unitCents))}. Drop empty ids, non-finite qty/unitCents, qty<=0, unitCents<0. Sort by id using JS code-point comparison, ascending; retain duplicates.',
  'Input is normalized. Keep qty>=policy.minQty and category!==policy.excludedCategory. Preserve every field; sort by id using JS code-point comparison ascending.',
  'Input is normalized. Preserve fields and add subtotalCents=qty*unitCents, discountCents=floor(subtotalCents*policy.discountBps/10000), taxCents=round((subtotalCents-discountCents)*policy.taxBps/10000), totalCents=subtotalCents-discountCents+taxCents.',
  'Input contains priced rows. Group by exact category (including special keys such as __proto__). Output exactly {category,orders,qty,totalCents}; sum qty/totalCents, count orders; sort category using JS code-point comparison ascending.',
  'Input contains summaries. Sort totalCents descending, breaking ties by category ascending using JS code-point comparison. Add 1-based rank BEFORE pagination, then slice(policy.offset,policy.offset+policy.limit). Preserve other fields.'
]

export function prepareWorkload(item, round, runId) {
  const task = `task-${item.index + 1}`
  const moduleName = `${task}-${stageNames[item.index]}.mjs`
  const serviceName = `${task}-service.mjs`
  const specName = `${task}-spec.json`
  const verifierName = `verify-${task}.mjs`
  const receiptName = `evidence/${task}-round-${round}.json`
  const nonce = crypto.randomUUID()
  const spec = { runId, round, nonce, stage: stageNames[item.index], policy: policyFor(round), moduleName, serviceName, receiptName,
    contract: contracts[item.index],
    moduleContract: 'Export revision=current round, policy exactly as specified, and transform(rows). Never mutate input. Module must implement the current policy without reading the spec file at runtime.',
    serviceContract: `Import transform and revision from ./${moduleName}. Export run(rows) returning exactly {round:revision,count:result.length,rows:result} where result=transform(rows).`,
    testContract: `Create ${task}-regression.test.mjs using node:test and strict assertions for edge cases, immutability and service integration. Run this test AND node ${verifierName}. Do not modify any spec or verify file.` }
  fs.mkdirSync(path.join(item.workspace, 'evidence'), { recursive: true })
  const verifier = verifierSource(moduleName, serviceName, spec, casesFor(item.index, round, 3), receiptName)
  fs.writeFileSync(path.join(item.workspace, specName), `${JSON.stringify(spec, null, 2)}\n`)
  fs.writeFileSync(path.join(item.workspace, verifierName), verifier)
  const sourcePaths = [moduleName, serviceName, `${task}-regression.test.mjs`]
  return { task, runId, round, nonce, moduleName, serviceName, specName, verifierName, receiptName, sourcePaths,
    pins: { [specName]: sha(read(path.join(item.workspace, specName))), [verifierName]: sha(verifier) },
    previousModuleHash: fs.existsSync(path.join(item.workspace, moduleName)) ? sha(read(path.join(item.workspace, moduleName))) : null,
    privateVerifier: verifierSource(moduleName, serviceName, spec, casesFor(item.index, round + 131, 11).map(test => ({ input: test.input, expected: reference(item.index, test.input, spec.policy) })), null) }
}

function verifierSource(moduleName, serviceName, spec, cases, receiptName) {
  return `import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const mod = await import(pathToFileURL(path.join(root, ${JSON.stringify(moduleName)})));
const service = await import(pathToFileURL(path.join(root, ${JSON.stringify(serviceName)})));
assert.equal(mod.revision, ${spec.round});
assert.deepEqual(mod.policy, ${JSON.stringify(spec.policy)});
const serviceSource = fs.readFileSync(path.join(root, ${JSON.stringify(serviceName)}), 'utf8');
assert.ok(serviceSource.includes(${JSON.stringify(`./${moduleName}`)}), 'service must import the business module');
const cases = ${JSON.stringify(cases)};
for (const test of cases) {
 const input = structuredClone(test.input); const before = structuredClone(input);
 assert.deepEqual(mod.transform(input), test.expected); assert.deepEqual(input, before, 'input mutated');
 assert.deepEqual(service.run(input), {round:${spec.round},count:test.expected.length,rows:test.expected});
 assert.deepEqual(input, before, 'service mutated input');
}
const evidence = {runId:${JSON.stringify(spec.runId)},round:${spec.round},nonce:${JSON.stringify(spec.nonce)},cases:cases.length,passed:true};
${receiptName ? `if (!process.argv.includes('--no-write')) fs.writeFileSync(path.join(root, ${JSON.stringify(receiptName)}), JSON.stringify(evidence)+'\\n');` : ''}
console.log(JSON.stringify(evidence));
`
}

export function workloadPrompt(item, workload, peer) {
  const continuation = workload.priorChild
    ? `必须继续上一轮同一子代理，subagent 参数 resumeRunId='${workload.priorChild.runId}'、model='${workload.requestedModel}',maxSteps=8，不得新建替代；不要改变原 role/access。要求子代理在结果中同时回忆原样给出上一轮nonce和本轮nonce。`
    : `使用 subagent 的 role='spec-reviewer',access='read-only',model='${workload.requestedModel}',maxSteps=8 创建只读子代理。`
  return `在工作区 ${item.workspace} 完成订单数据处理工程第 ${workload.round} 轮。你的职责是 ${stageNames[item.index]} 模块和对应服务。\n`
    + (workload.previousFailure ? `上一轮未通过的真实反馈：${workload.previousFailure}。保留同一会话上下文，在本轮新规格下修复这个具体问题；继续完成下列全部要求，不要只写解释。\n` : '')
    + `1. 本轮第一个工具调用必须是 list_files，path='${item.workspace}'；每一轮都须实际成功列出目录，即使已记住文件名也不能省略。然后 read_file 读取本轮 ${workload.specName} 和现有代码；实现规格中的模块、服务及 node:test 回归测试。只修改自己的 task-${item.index + 1}-* 源码和 evidence 文件。\n`
    + `2. ${continuation}委派只读规格/代码检查，task 写明绝对工作区和文件。子代理只读 ${workload.specName}、业务模块和服务各一次，立即给出结论，不要重复搜索、执行命令、写文件或继续委派；最终结果原样写出本轮 nonce ${workload.nonce} 和具体审查结论。根据结果修正问题。\n`
    + (peer ? `3. read_file 读取共享项目的 ${peer} 并确认相邻阶段的契约兼容性，不修改其他任务。\n` : `3. read_file 重新读取你的模块与服务，检查跨文件 import 和接口。\n`)
    + `4. execute_cmd 只能执行以下两个精确调用（不要添加、替换或组合任何参数）：command='node',args=['${workload.verifierName}']; 以及 command='node',args=['--test','${workload.task}-regression.test.mjs']，cwd=工作区，均须前台完成。禁止 node -e/-p、shell/cmd/powershell、管道、重定向、&&、分号、脚本内联、npm/npx、安装依赖或任何第三个命令。禁止伪造 evidence。\n`
    + `算术校验与调试也只能写入自己的 ${workload.task}-regression.test.mjs，用上述 node --test 调用检查；失败后修正源码/测试并重跑同一个许可命令。不要用 node -e 做计算器。每次 execute_cmd 前逐项核对 command 和 args 与上面两个调用完全一致。\n`
    + `若命令被安全策略拦截并收到“用户拒绝此操作，未执行”，保持当前任务继续：不要重试被拒的命令，不要申请放宽权限；把所需计算或调试写入自己的回归测试文件，仅执行上述两个许可调用，完成原规格、子审查和证据。\n`
    + `结束前核对本轮工具记录：list_files、read_file、write_file或edit_file、subagent、execute_cmd 都必须真实成功，上一轮记录不能代替本轮；缺少时立即补上。任务规格完整，可直接执行；不要调用未提供的 ask_user 或 todo 工具，也不要发出占位工具调用。若权限或能力不足如实失败。不得修改 spec/verify 文件，不得访问其他工作区、网络或安装依赖。最终给出模块、测试和子任务结果。`
}

export function runNode(cwd, args, { source, signal, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    // Generated code needs a Node runtime, not the runner's engine credentials.
    const env = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal })
    let output = ''; let failure = null
    const timer = setTimeout(() => { failure = new Error('Independent verifier timed out'); child.kill() }, timeoutMs)
    const capture = chunk => {
      if (output.length + chunk.length > 64 * 1024) { failure = new Error('Verifier output exceeded 64 KiB'); child.kill(); return }
      output += chunk.toString()
    }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    child.on('error', error => { failure = error })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure || new Error(`Independent verifier exited ${code}: ${output.slice(-2000)}`))
      else resolve({ exitCode: code, outputHash: sha(output), outputBytes: Buffer.byteLength(output), testCount: Number(output.match(/^# tests (\d+)$/m)?.[1] || 0) })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(source)
  })
}

export async function verifyWorkload(item, workload, stream, requestedModel, { signal, peer } = {}) {
  if (stream.actualModel !== requestedModel) throw new Error(`Actual model mismatch: requested ${requestedModel}, observed ${stream.actualModel || 'missing'}`)
  if (stream.terminal !== 'succeeded' || !stream.runId || !stream.turnId) throw new Error('Missing successful root-run identity')
  const successful = stream.tools.filter(tool => tool.success === true)
  for (const name of ['list_files', 'read_file', 'subagent']) {
    if (!successful.some(tool => tool.name === name)) throw new Error(`Missing successful ${name} tool evidence`)
  }
  if (!successful.some(tool => ['write_file', 'edit_file'].includes(tool.name))) throw new Error('Missing successful source-write tool evidence')
  const pathMatches = (observed, file) => typeof observed === 'string' && path.resolve(item.workspace, observed) === path.join(item.workspace, file)
  if (!successful.some(tool => ['write_file', 'edit_file'].includes(tool.name) && pathMatches(tool.path, workload.moduleName))) throw new Error('Missing business-module write tool evidence')
  const child = stream.children.find(child => child.status === 'succeeded' && child.childSessionId
    && child.resultNonces?.includes(workload.nonce) && child.readPaths?.some(file => pathMatches(file, workload.specName))
    && (!workload.requestedModel || child.modelId === workload.requestedModel)
    && (!workload.priorChild || child.resumeFromRunId === workload.priorChild.runId && child.childSessionId === workload.priorChild.childSessionId
      && child.resultNonces?.includes(workload.priorChild.nonce)))
  if (!child) throw new Error('Missing successful child Agent evidence for current nonce/spec and required continuation')
  if (!successful.some(tool => tool.name === 'read_file' && pathMatches(tool.path, workload.specName))) throw new Error('Current spec was not read')
  if (peer && !successful.some(tool => tool.name === 'read_file' && pathMatches(tool.path, peer))) throw new Error('Shared peer contract was not read')
  const ran = args => successful.some(tool => tool.name === 'execute_cmd' && !tool.background && /(?:^|[\\/])node(?:\.exe)?$/i.test(tool.command || '') && JSON.stringify(tool.args) === JSON.stringify(args))
  if (!ran([workload.verifierName]) || !ran(['--test', `${workload.task}-regression.test.mjs`])) throw new Error('Missing successful foreground verifier/regression command evidence')
  const hashes = {}
  for (const [file, hash] of Object.entries(workload.pins)) {
    if (sha(read(path.join(item.workspace, file))) !== hash) throw new Error(`Harness fixture modified: ${file}`)
  }
  for (const file of workload.sourcePaths) hashes[file] = sha(read(path.join(item.workspace, file)))
  if (hashes[workload.moduleName] === workload.previousModuleHash) throw new Error('Business module did not change this round')
  const receipt = JSON.parse(read(path.join(item.workspace, workload.receiptName)))
  if (receipt.runId !== workload.runId || receipt.nonce !== workload.nonce || receipt.round !== workload.round || receipt.passed !== true) throw new Error('Missing fresh verifier receipt')
  // Public tests demonstrate a real tool execution; independently generated
  // cases and an out-of-workspace verifier prevent a replaced test becoming green.
  const verifier = await runNode(item.workspace, ['--input-type=module'], { source: workload.privateVerifier, signal })
  const expectedOutput = JSON.stringify({ runId: workload.runId, round: workload.round, nonce: workload.nonce, cases: 12, passed: true }) + '\n'
  if (verifier.outputHash !== sha(expectedOutput)) throw new Error('Independent verifier did not reach its success assertion')
  const regression = await runNode(item.workspace, ['--test', '--test-reporter=tap', `${workload.task}-regression.test.mjs`], { signal })
  if (regression.testCount < 1) throw new Error('Regression file did not execute any Node tests')
  for (const [file, hash] of Object.entries(hashes)) if (sha(read(path.join(item.workspace, file))) !== hash) throw new Error(`Source changed during validation: ${file}`)
  for (const [file, hash] of Object.entries(workload.pins)) if (sha(read(path.join(item.workspace, file))) !== hash) throw new Error(`Harness fixture modified during validation: ${file}`)
  return { round: workload.round, nonce: workload.nonce, hashes, receiptHash: sha(JSON.stringify(receipt)), verifier, regression, child: { ...child, nonce: workload.nonce } }
}

export async function verifySharedPipeline(items, workloads, { signal } = {}) {
  const input = casesFor(0, workloads[0].round, 2)[1].input
  let expected = input
  for (let stage = 0; stage < 5; stage += 1) expected = reference(stage, expected, policyFor(workloads[stage].round))
  const source = `import assert from 'node:assert/strict'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
let rows=${JSON.stringify(input)};
for (const file of ${JSON.stringify(workloads.map(item => item.moduleName))}) { const mod=await import(pathToFileURL(path.join(process.cwd(),file))); rows=mod.transform(rows); }
assert.deepEqual(rows,${JSON.stringify(expected)}); console.log('shared pipeline passed');`
  return runNode(items[0].workspace, ['--input-type=module'], { source, signal })
}
