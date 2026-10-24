/** Read-only business/version/isolation acceptance for the office campaign.
 * It never starts an app, contacts a model, executes delivered code or repairs
 * role output. Format extraction is supplied by audit-office-artifacts.py.
 */
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat, writeFile, mkdir } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { officeCompanySeedFiles, officeCompanyAcceptance } from './office-company-campaign-plan.mjs'

const roleIds = ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance']
const stages = { baseline: 'v001', revision: 'v002', collaboration: 'v003' }
const money = value => Math.round((value + Number.EPSILON) * 100) / 100
const canonical = value => resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || !rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\') && rel !== '..' && !isAbsolute(rel) }
const hashText = text => createHash('sha256').update(text).digest('hex')
const formatOf = path => extname(path).toLowerCase().slice(1)
const digest = value => { assert.ok(typeof value === 'string' && /^(?:sha256:)?[a-f\d]{64}$/i.test(value), 'Expected a SHA-256 digest'); return value.replace(/^sha256:/i, '').toLowerCase() }
const maxJsonBytes = 64 * 1024 * 1024

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function readJson(path) {
  assert.ok((await stat(path)).size <= maxJsonBytes, 'JSON exceeds the bounded audit limit')
  return JSON.parse(await readFile(path, 'utf8'))
}
async function exists(path) { try { await stat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function boundedPath(root, path) {
  const absolute = resolve(path)
  assert.ok(inside(root, absolute), 'Reference escapes its allowed root: ' + absolute)
  const [realRoot, actual] = await Promise.all([realpath(root), realpath(absolute)])
  assert.ok(inside(realRoot, actual), 'Reference follows a link outside its allowed root: ' + absolute)
  return actual
}

/** Strict CSV parser including quoted commas/newlines and doubled quotes. */
export function parseCsv(text) {
  const rows = [], row = []; let field = '', quoted = false, closed = false
  text = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') { quoted = false; closed = true }
      else field += char
    } else if (char === '"') {
      assert.equal(field, '', 'Quote inside an unquoted CSV field'); assert.equal(closed, false)
      quoted = true
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false
      if (char !== ',') { rows.push(row.splice(0)); if (char === '\r' && text[index + 1] === '\n') index++ }
    } else { assert.equal(closed, false, 'Unexpected text after a closed CSV quote'); field += char }
  }
  assert.equal(quoted, false, 'Unterminated CSV quote')
  if (field !== '' || row.length || closed) { row.push(field); rows.push(row.splice(0)) }
  assert.ok(rows.length > 0 && rows[0].length > 0, 'CSV has no header')
  const headers = rows.shift()
  assert.ok(headers.every(Boolean) && new Set(headers).size === headers.length, 'CSV has blank or duplicate headers')
  for (const value of rows) assert.equal(value.length, headers.length, 'CSV row width differs from header')
  return { headers, rows, records: rows.map(values => Object.fromEntries(headers.map((key, index) => [key, values[index]]))) }
}

/** Derives expectations from raw supplied synthetic facts, rather than copying
 * expected totals into model output or trusting submitted manifests. */
export function computeOfficeOracle(seeds = officeCompanySeedFiles) {
  const baseline = seeds.baseline, revision = JSON.parse(seeds.revision['revision-v2.json'])
  const company = JSON.parse(baseline['company-v1.json'])
  const contracts = parseCsv(baseline['contracts-v1.csv']).records
  const invoices = parseCsv(baseline['receivables-v1.csv']).records
  const people = parseCsv(baseline['employees-v1.csv']).records
  const expenses = parseCsv(baseline['expense-budget-v1.csv']).records
  const pipeline = parseCsv(baseline['sales-pipeline-v1.csv']).records
  const num = value => { const result = Number(value); assert.ok(Number.isFinite(result), 'Non-numeric business fact'); return result }
  const sum = (rows, read) => money(rows.reduce((total, row) => total + read(row), 0))
  const revenue = month => sum(contracts, row => {
    const start = new Date(row.start_date + 'T00:00:00Z'), date = new Date(month + '-01T00:00:00Z')
    const delta = (date.getUTCFullYear() - start.getUTCFullYear()) * 12 + date.getUTCMonth() - start.getUTCMonth()
    return delta >= 0 && delta < num(row.service_months) ? num(row.net_contract_amount) / num(row.service_months) : 0
  })
  const salary = sum(people, row => num(row.monthly_gross)), supplement = money(salary * .12)
  const expense = sum(expenses, row => num(row.november_net_budget))
  const original = {
    signedNetContracts: sum(contracts, row => num(row.net_contract_amount)),
    probabilityWeightedPipeline: sum(pipeline, row => num(row.net_amount) * num(row.probability)),
    octoberRevenue: revenue('2026-10'), novemberRevenue: revenue('2026-11'),
    octoberReceivablesGross: sum(invoices.filter(row => row.invoice_date <= '2026-10-31'), row => num(row.invoice_gross) - num(row.cash_received_gross)),
    headcount: people.length, novemberGrossSalary: salary, employerSupplement: supplement,
    peopleCost: money(salary + supplement), nonPeopleBudget: expense,
    discretionaryBudget: sum(expenses.filter(row => row.protection === 'discretionary'), row => num(row.november_net_budget)),
    totalExpense: money(salary + supplement + expense)
  }
  const changes = Object.fromEntries(revision.changes.map(change => [change.id, change]))
  const contract = contracts.find(row => row.contract_id === changes.CH001.subject)
  const invoice = invoices.find(row => row.contract_id === contract.contract_id)
  const oldMonthly = num(contract.net_contract_amount) / num(contract.service_months)
  const remaining = num(changes.CH001.newNetAmount) - oldMonthly
  const employee = changes.CH002.employee, start = new Date(employee.employment_start + 'T00:00:00Z')
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  const payrollDays = daysInMonth - start.getUTCDate() + 1
  const newSalary = money(num(employee.monthly_gross) * payrollDays / daysInMonth), newSupplement = money(newSalary * .12)
  const peopleCost = money(original.peopleCost + newSalary + newSupplement)
  const discretionary = expenses.filter(row => row.protection === 'discretionary').map(row => ({ ...row,
    amount: row.expense_id === changes.CH003.subject ? num(changes.CH003.newAmount) : row.expense_id === changes.CH004.subject ? num(changes.CH004.proposedAmount) : num(row.november_net_budget) }))
  const updated = {
    c002NetContract: num(changes.CH001.newNetAmount), c002OctoberRevenue: oldMonthly,
    c002RemainingFiveMonthsNet: remaining, c002MonthlyRevenueFromNovember: money(remaining / (num(contract.service_months) - 1)),
    novemberTotalRevenue: money(original.novemberRevenue - oldMonthly + remaining / (num(contract.service_months) - 1)),
    c002GrossAdjustment: money((num(contract.net_contract_amount) - num(changes.CH001.newNetAmount)) * (1 + num(contract.vat_rate))),
    c002GrossReceivableAfterAdjustment: money(num(changes.CH001.newNetAmount) * (1 + num(contract.vat_rate)) - num(invoice.cash_received_gross)),
    headcount: original.headcount + 1, e009PayrollDays: payrollDays, e009GrossSalary: newSalary,
    e009Supplement: newSupplement, e009Cost: money(newSalary + newSupplement), novemberPeopleCost: peopleCost,
    cloudBudget: num(changes.CH003.newAmount), requestedMarketingBudget: num(changes.CH004.proposedAmount),
    proposedDiscretionaryTotal: sum(discretionary, row => row.amount), discretionaryCap: num(changes.CH005.discretionaryCap),
    finalTotalExpenseUpperBound: money(peopleCost + num(changes.CH005.discretionaryCap) + sum(expenses.filter(row => row.protection === 'fixed'), row => num(row.november_net_budget)))
  }
  for (const [key, expected] of Object.entries(officeCompanyAcceptance.baselineExpected)) assert.equal(original[key], expected, 'Plan baseline oracle mismatch: ' + key)
  for (const [key, expected] of Object.entries(officeCompanyAcceptance.revisionExpected)) assert.equal(updated[key], expected, 'Plan revision oracle mismatch: ' + key)
  return { company: company.name, baseline: original, revision: updated }
}

const requiredClaims = {
  baseline: {
    finance: ['octoberRevenue', 'novemberRevenue', 'octoberReceivablesGross', 'novemberGrossSalary', 'employerSupplement', 'peopleCost', 'nonPeopleBudget', 'totalExpense'],
    people: ['headcount', 'novemberGrossSalary', 'employerSupplement', 'peopleCost'],
    sales: ['signedNetContracts', 'probabilityWeightedPipeline'],
    operations: ['nonPeopleBudget', 'discretionaryBudget'],
    pmo: ['octoberRevenue', 'novemberRevenue', 'peopleCost', 'totalExpense'], compliance: []
  },
  revision: {
    finance: ['c002MonthlyRevenueFromNovember', 'novemberTotalRevenue', 'c002GrossAdjustment', 'c002GrossReceivableAfterAdjustment', 'novemberPeopleCost', 'proposedDiscretionaryTotal'],
    people: ['headcount', 'e009PayrollDays', 'e009GrossSalary', 'e009Supplement', 'e009Cost', 'novemberPeopleCost'],
    sales: ['c002NetContract', 'c002OctoberRevenue', 'c002GrossAdjustment', 'requestedMarketingBudget'],
    operations: ['cloudBudget', 'proposedDiscretionaryTotal'],
    pmo: ['discretionaryCap', 'novemberPeopleCost', 'requestedMarketingBudget'], compliance: []
  }
}
const labels = {
  octoberRevenue: '十月确认收入', novemberRevenue: '十一月基线收入', octoberReceivablesGross: '十月底已开票应收含税余额',
  novemberGrossSalary: '十一月基线工资', employerSupplement: '基线雇主附加成本', peopleCost: '基线人员总成本',
  nonPeopleBudget: '基线非人员预算', discretionaryBudget: '基线可调四项预算', totalExpense: '基线总费用',
  headcount: '本版本人数', signedNetContracts: '已签不含税合同总额', probabilityWeightedPipeline: '机会概率加权额（与确认收入分开）',
  c002MonthlyRevenueFromNovember: 'C002 十一月起月收入', novemberTotalRevenue: '修订后十一月总收入',
  c002GrossAdjustment: 'C002 含税发票调减草案金额', c002GrossReceivableAfterAdjustment: 'C002 调整后含税未收余额',
  novemberPeopleCost: '修订后十一月人员总成本', proposedDiscretionaryTotal: '决议前四项费用提案合计',
  e009PayrollDays: 'E009 十一月计薪日历天数', e009GrossSalary: 'E009 当月工资', e009Supplement: 'E009 当月附加成本', e009Cost: 'E009 当月总成本',
  c002NetContract: 'C002 修订后不含税合同总额', c002OctoberRevenue: 'C002 保持不变的十月收入',
  requestedMarketingBudget: '销售提出的待批准活动预算', cloudBudget: '修订后云资源预算', discretionaryCap: '管理层批准的可调总额上限',
  approvedDiscretionaryTotal: '最终批准的四项费用合计', approvedTotalExpense: '最终批准费用总额'
}
const factual = new Set(['c002NetContract', 'requestedMarketingBudget', 'cloudBudget', 'discretionaryCap'])
const claimIds = (role, stage) => stage === 'collaboration'
  ? [...requiredClaims.revision[role], ...(['finance', 'operations', 'pmo'].includes(role) ? ['approvedDiscretionaryTotal', 'approvedTotalExpense'] : [])]
  : requiredClaims[stage][role]

export function businessClaimInstructions(role, stage) {
  assert.ok(roleIds.includes(role) && stages[stage], 'Unknown office role/stage')
  return `独立验收补充合同（不得复制未计算的数字）：本轮 evidence 写到 evidence/${stages[stage]}/，保留前轮。
发布目录 ${role}/${stages[stage]} 中使用 manifest.json。manifest.artifacts 的 relativePath 默认相对该发布版本目录；引用本人私有正式产物时加 scope="workspace"、relativePath 相对本人工作区。不得跨他人工作区。
manifest.claims 使用数组，每项 {id,value,unit,period,basis,status,evidence:[{path,scope,sha256,kind,sheet,cell}]}。金额用数值和 unit="CNY"，人数用 people，天数用 days；period 填 2026-10 或 2026-11，basis 明确 net/gross/count，status 区分 forecast/proposed/approved。kind="xlsx-cell" 时填真实工作表名与 A1 单元格，数值必须在真实产物读回；计算项应引用公式格并保留重算证据，不得为了通过在其他 JSON 写一个同名答案。CSV 原始事实可用 kind="csv-cell"、row（首个数据行为 1）和 column（表头名）。
本角色本轮必须能定位的指标：${claimIds(role, stage).map(id => `${id}=${labels[id]}`).join('；') || '文控以实际文档注册、问题及交接证据为主，无额外虚构金额指标'}。
交接消息 kind 使用 handoff/ack/nack/decision/change-request，toRole 必须是六角色 ID 之一；接收者 ACK 写在自己的 messages 前缀，ackOf 指实际消息 ID、observedRevision 指原消息 revision、correlationId 保持一致，并填 decision=accepted/rejected/needs-change、appliedArtifactReferences（真实路径及 sha256）。需要多人确认时逐个发消息，不写一份虚构全员 ACK。
${role === 'pmo' && stage === 'collaboration' ? 'PMO 的 decisions.json 使用 {schemaVersion:1,revision:"v003",baseRevision:"v002",status:"approved",budget:{cloud,marketing,travel,tools,people,rent},conflicts:[{id,proposals:[{role,revision,amount,evidence}],chosen,reason,owner,affectedRoles}],evidence:[]}。决议必须至少保留一项真实预算冲突和两方提案证据，并与已核算工作簿一致。' : ''}`
}

function planRoots(plan) {
  assert.equal(plan.roles?.length, 6, 'Expected six roles')
  assert.deepEqual([...plan.roles.map(role => role.id)].sort(), [...roleIds].sort())
  const publishPrefixes = plan.roles.map(role => resolve(role.publishPrefix))
  const publishRoot = dirname(publishPrefixes[0])
  assert.ok(publishPrefixes.every(path => canonical(dirname(path)) === canonical(publishRoot)))
  const inputRoot = plan.inputRoot
  assert.ok(inputRoot, 'Serialized plan must include inputRoot for independent input-integrity checks')
  const roots = [{ path: resolve(inputRoot), owner: 'input', scope: 'input' }, { path: publishRoot, owner: 'publication', scope: 'publication' },
    ...plan.roles.map(role => ({ path: resolve(role.workspace), owner: role.id, scope: 'workspace' }))]
  for (let left = 0; left < roots.length; left++) for (let right = left + 1; right < roots.length; right++) {
    assert.ok(!inside(roots[left].path, roots[right].path) && !inside(roots[right].path, roots[left].path), 'Audit roots overlap')
  }
  return { roots, inputRoot: resolve(inputRoot), publishRoot }
}

export async function captureOfficeSnapshot(plan, { maxFiles = 20000 } = {}) {
  const { roots } = planRoots(plan), files = [], issues = []
  for (const root of roots) {
    const walk = async directory => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) { issues.push({ path, reason: 'Symbolic link is not followed by the independent audit' }); continue }
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) {
          if (files.length >= maxFiles) throw new Error('Snapshot file-count limit reached; incomplete snapshots must not be certified')
          await boundedPath(root.path, path)
          const before = await stat(path), sha256 = await hashFile(path), after = await stat(path)
          assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs, 'File changed during snapshot')
          files.push({ path, relativePath: relative(root.path, path).replaceAll('\\', '/'), owner: root.owner, scope: root.scope, sha256, bytes: after.size, mtimeMs: after.mtimeMs })
        }
      }
    }
    if (await exists(root.path)) await walk(root.path)
    else issues.push({ path: root.path, reason: 'Missing audit root' })
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), complete: issues.length === 0, files, issues }
}

function normalizeClaims(claims) {
  if (Array.isArray(claims)) return claims
  if (claims && typeof claims === 'object') return Object.entries(claims).map(([id, value]) => value && typeof value === 'object' ? { id, ...value } : { id, value })
  return []
}

export async function auditOfficeCompany({ plan, stage = 'baseline', artifactReport, writeEvidence, initialSnapshot, previousSnapshot, sessionEvidence, crudEvidence }) {
  assert.ok(stages[stage], 'Unknown office audit stage')
  const { inputRoot, publishRoot } = planRoots(plan), revision = stages[stage]
  const checks = [], versions = [], artifacts = [], messages = [], verifiedClaims = [], requiredVersions = ['v001', ...(stage === 'baseline' ? [] : ['v002']), ...(stage === 'collaboration' ? ['v003'] : [])]
  const check = async (id, run, context = {}) => {
    try { const detail = await run(); checks.push({ id, status: 'passed', ...context, detail }); return detail }
    catch (error) { checks.push({ id, status: error.code === 'NOT_VERIFIED' ? 'not-verified' : 'failed', ...context, detail: error.message }); return null }
  }
  const missing = message => { const error = new Error(message); error.code = 'NOT_VERIFIED'; throw error }
  const oracle = computeOfficeOracle()
  const sources = { ...officeCompanySeedFiles.baseline, ...(stage === 'baseline' ? {} : officeCompanySeedFiles.revision) }
  for (const [name, contents] of Object.entries(sources)) await check('input.' + name, async () => {
    const path = await boundedPath(inputRoot, resolve(inputRoot, name))
    assert.equal(await hashFile(path), hashText(contents), 'Common business input differs from its approved synthetic seed')
    return { path, sha256: hashText(contents) }
  })

  const fileReports = artifactReport?.files || []
  const findReport = path => fileReports.find(item => canonical(item.path || resolve(artifactReport.root, item.relativePath)) === canonical(path))
  const resolveReference = async (role, directory, reference) => {
    const root = reference.scope === 'workspace' ? role.workspace : directory
    const name = reference.relativePath ?? reference.path
    assert.ok(typeof name === 'string' && name, 'Artifact/evidence path is missing')
    assert.ok(!isAbsolute(name) || inside(root, name), 'Absolute reference escapes its declared scope')
    return boundedPath(root, resolve(root, name))
  }
  const proofValue = async (role, directory, proof, requireFormula) => {
    const path = await resolveReference(role, directory, proof), sha256 = await hashFile(path)
    assert.equal(digest(proof.sha256), sha256, 'Claim evidence hash does not match actual file')
    if (proof.kind === 'csv-cell') {
      assert.equal(requireFormula, false, 'Computed business totals require workbook formula evidence')
      assert.equal(formatOf(path), 'csv'); assert.ok((await stat(path)).size <= 8 * 1024 * 1024)
      const data = parseCsv(await readFile(path, 'utf8'))
      assert.ok(Number.isInteger(proof.row) && proof.row > 0 && proof.row <= data.records.length)
      assert.ok(data.headers.includes(proof.column))
      const value = Number(data.records[proof.row - 1][proof.column]); assert.ok(Number.isFinite(value))
      return { value, path, sha256, locator: { row: proof.row, column: proof.column } }
    }
    assert.equal(proof.kind, 'xlsx-cell', 'Business evidence must locate an actual XLSX/CSV cell')
    const report = findReport(path)
    if (!report) missing('Independent format report lacks the referenced workbook: ' + path)
    assert.equal(digest(report.sha256), sha256, 'Format report is stale for this workbook')
    assert.equal(report.sourceUnchanged, true, 'Format extraction did not certify unchanged source')
    const sheet = report.content?.sheets?.find(item => item.name === proof.sheet), cell = sheet?.cells?.[proof.cell]
    if (!cell) missing('Business evidence cell absent or truncated: ' + proof.sheet + '!' + proof.cell)
    if (requireFormula) assert.ok(typeof cell.formula === 'string' && cell.formula.startsWith('='), 'Calculated metric is hardcoded instead of referencing a real formula')
    let value = cell.value
    if (cell.formula) {
      const calculation = report.formulas?.find(item => item.sheet === proof.sheet && item.cell === proof.cell)
      if (calculation?.status !== 'passed' || !Number.isFinite(calculation.expected)) missing('Formula was not independently recalculated: ' + proof.sheet + '!' + proof.cell)
      value = calculation.expected
      if (cell.cachedValue != null) assert.ok(Math.abs(Number(cell.cachedValue) - value) < .005, 'Formula cache disagrees with independent calculation')
    }
    assert.ok(typeof value === 'number' && Number.isFinite(value), 'Evidence is not a numeric cell')
    return { value, path, sha256, locator: { sheet: proof.sheet, cell: proof.cell }, formula: cell.formula ?? null }
  }

  for (const role of plan.roles) {
    for (const version of requiredVersions) {
      const directory = resolve(role.publishPrefix, version), context = { role: role.id, revision: version }
      const manifest = await check('manifest.schema', async () => {
        const candidates = ['manifest.json', 'artifact-manifest.json'].map(name => join(directory, name)), present = []
        for (const path of candidates) if (await exists(path)) present.push(path)
        assert.equal(present.length, 1, 'Expected one unambiguous published manifest')
        const path = await boundedPath(role.publishPrefix, present[0]), value = await readJson(path)
        assert.equal(value.schemaVersion, 1); assert.equal(value.role, role.id); assert.equal(value.revision, version)
        assert.equal(value.baseRevision ?? null, version === 'v001' ? null : 'v' + String(Number(version.slice(1)) - 1).padStart(3, '0'))
        assert.ok(Number.isFinite(Date.parse(value.generatedAt)), 'Manifest needs a real generatedAt')
        assert.ok(Array.isArray(value.artifacts) && value.artifacts.length > 0)
        assert.ok(value.inputHashes && typeof value.inputHashes === 'object', 'Manifest lacks input hashes')
        const inputs = Array.isArray(value.inputHashes) ? value.inputHashes : Object.entries(value.inputHashes).map(([path, hash]) => ({ path, sha256: typeof hash === 'string' ? hash : hash.sha256 }))
        assert.ok(inputs.length > 0, 'Manifest input hash list is empty')
        for (const input of inputs) {
          assert.ok(typeof input.path === 'string' && input.path)
          const inputPath = resolve(inputRoot, input.path)
          const allowedRoot = [inputRoot, publishRoot, role.workspace].find(root => inside(root, inputPath))
          assert.ok(allowedRoot, 'Input reference escapes shared inputs, publications and own workspace')
          await boundedPath(allowedRoot, inputPath)
          assert.equal(digest(input.sha256), await hashFile(inputPath), 'Manifest cites stale/false input hash')
        }
        assert.ok(Array.isArray(value.unresolvedIssues), 'Manifest must state unresolved issues, including an empty array')
        versions.push({ role: role.id, revision: version, path, sha256: await hashFile(path), claims: normalizeClaims(value.claims), unresolvedIssues: value.unresolvedIssues })
        return value
      }, context)
      if (!manifest) continue
      const seen = new Set()
      for (const descriptor of manifest.artifacts) await check('manifest.artifact', async () => {
        const path = await resolveReference(role, directory, descriptor)
        assert.ok(!seen.has(canonical(path)), 'Duplicate artifact in one manifest'); seen.add(canonical(path))
        const size = (await stat(path)).size, hash = await hashFile(path)
        assert.ok(size > 0); assert.equal(descriptor.bytes, size); assert.equal(digest(descriptor.sha256), hash)
        assert.ok(typeof descriptor.classification === 'string' && descriptor.classification)
        assert.ok(typeof descriptor.mediaType === 'string' && descriptor.mediaType)
        const actual = { role: role.id, revision: version, path, sha256: hash, bytes: size, format: formatOf(path), classification: descriptor.classification }
        artifacts.push(actual)
        return actual
      }, context)
      if (version !== revision) continue
      for (const [name] of role.deliverables) await check('deliverable.format-readback', async () => {
        const path = await boundedPath(role.workspace, resolve(role.workspace, 'deliverables', version, name)), hash = await hashFile(path), format = formatOf(path)
        if (format === 'csv') {
          assert.ok((await stat(path)).size <= 8 * 1024 * 1024)
          const parsed = parseCsv(await readFile(path, 'utf8'))
          assert.ok(parsed.rows.length > 0)
          return { path, sha256: hash, rows: parsed.rows.length, columns: parsed.headers }
        }
        const report = findReport(path)
        if (!report) missing('No independent format/visual report for formal deliverable: ' + path)
        assert.equal(digest(report.sha256), hash); assert.equal(report.format, format); assert.equal(report.sourceUnchanged, true)
        assert.ok(!report.checks?.some(item => item.status === 'failed'), 'Independent document checks failed')
        assert.ok(report.checks?.some(item => item.status === 'passed'), 'No positive independent document check')
        if (['docx', 'pptx', 'pdf'].includes(format) && report.visual?.reviewStatus !== 'passed') missing('Rendered layout was not independently reviewed: ' + path)
        if (format === 'xlsx' && !report.formulas?.some(item => item.status === 'passed')) missing('No independently verified formula in the workbook')
        return { path, sha256: hash, format }
      }, context)
      const claims = normalizeClaims(manifest.claims)
      await check('claims.unique', () => assert.equal(new Set(claims.map(item => item.id)).size, claims.length), context)
      for (const id of claimIds(role.id, stage)) await check('business.' + id, async () => {
        const claim = claims.find(item => item.id === id)
        assert.ok(claim, 'Required business claim absent: ' + id)
        assert.ok(typeof claim.value === 'number' && Number.isFinite(claim.value))
        assert.equal(claim.unit, id === 'headcount' ? 'people' : id === 'e009PayrollDays' ? 'days' : 'CNY')
        assert.equal(claim.period, id.startsWith('october') || id === 'c002OctoberRevenue' ? '2026-10' : '2026-11')
        assert.equal(claim.basis, id === 'headcount' || id === 'e009PayrollDays' ? 'count' : /GrossAdjustment|GrossReceivable|ReceivablesGross|GrossSalary/.test(id) ? 'gross' : 'net')
        assert.ok(['actual', 'forecast', 'proposed', 'approved'].includes(claim.status), 'Business status must be explicit')
        if (id === 'requestedMarketingBudget') assert.equal(claim.status, 'proposed')
        if (id.startsWith('approved')) assert.equal(claim.status, 'approved')
        assert.ok(Array.isArray(claim.evidence) && claim.evidence.length > 0, 'No actual cell proof for claim')
        const proof = await proofValue(role, directory, claim.evidence[0], !factual.has(id))
        assert.ok(Math.abs(proof.value - claim.value) < .005, 'Manifest amount disagrees with actual artifact cell')
        const expected = stage === 'baseline' ? oracle.baseline[id] : oracle.revision[id]
        if (id === 'approvedDiscretionaryTotal') assert.ok(proof.value >= 0 && proof.value <= oracle.revision.discretionaryCap, 'Approved discretionary budget exceeds cap')
        else if (id === 'approvedTotalExpense') assert.ok(proof.value >= oracle.revision.novemberPeopleCost + 12000 && proof.value <= oracle.revision.finalTotalExpenseUpperBound, 'Approved total omits protected cost or exceeds budget')
        else assert.ok(Math.abs(proof.value - expected) < .005, `Independent expected ${expected}, observed ${proof.value}`)
        const verified = { role: role.id, revision, id, value: proof.value, status: claim.status, proof }
        verifiedClaims.push(verified)
        return verified
      }, context)
    }
    const messageRoot = resolve(role.publishPrefix, 'messages')
    if (await exists(messageRoot)) for (const entry of await readdir(messageRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      await check('message.schema', async () => {
        const path = await boundedPath(role.publishPrefix, join(messageRoot, entry.name)), message = await readJson(path)
        assert.equal(message.schemaVersion, 1); assert.equal(message.fromRole, role.id)
        assert.ok(roleIds.includes(message.toRole) && message.toRole !== role.id)
        assert.ok(typeof message.messageId === 'string' && message.messageId)
        assert.ok(['handoff', 'ack', 'nack', 'decision', 'change-request'].includes(message.kind))
        assert.ok(typeof message.correlationId === 'string' && message.correlationId)
        assert.ok(/^v\d{3}$/.test(message.revision)); assert.equal(typeof message.requiresAck, 'boolean')
        assert.ok(Number.isFinite(Date.parse(message.createdAt)))
        messages.push({ ...message, path, sha256: await hashFile(path) })
        return { path, messageId: message.messageId, kind: message.kind }
      }, { role: role.id })
    }
  }

  await check('cross-role.verified-numbers-agree', () => {
    const groups = new Map()
    for (const claim of verifiedClaims) {
      const key = claim.id + ':' + claim.revision
      if (groups.has(key)) assert.ok(Math.abs(groups.get(key).value - claim.value) < .005, 'Cross-role value conflict for ' + claim.id)
      else groups.set(key, claim)
    }
    return { independentlyLocatedClaims: verifiedClaims.length }
  })
  await check('messages.unique-identity', () => assert.equal(new Set(messages.map(message => message.messageId)).size, messages.length))
  for (const message of messages) await check('message.published-revision', async () => {
    assert.ok(versions.some(version => version.role === message.fromRole && version.revision === message.revision), 'Message cites an unpublished sender revision')
    assert.equal(message.baseRevision ?? null, message.revision === 'v001' ? null : 'v' + String(Number(message.revision.slice(1)) - 1).padStart(3, '0'))
    if (['handoff', 'decision'].includes(message.kind)) {
      assert.ok(Array.isArray(message.evidence) && message.evidence.length > 0, 'Handoff/decision has no verifiable source evidence')
      const role = plan.roles.find(role => role.id === message.fromRole)
      for (const reference of message.evidence) {
        const path = await resolveReference(role, resolve(role.publishPrefix, message.revision), reference)
        assert.equal(digest(reference.sha256), await hashFile(path))
      }
    }
  }, { role: message.fromRole })
  for (const message of messages.filter(value => value.kind === 'ack' || value.kind === 'nack')) await check('message.ack-integrity', async () => {
    const original = messages.find(value => value.messageId === message.ackOf)
    assert.ok(original, 'ACK references a nonexistent message')
    assert.equal(message.fromRole, original.toRole); assert.equal(message.toRole, original.fromRole)
    assert.equal(message.correlationId, original.correlationId); assert.equal(message.observedRevision, original.revision)
    assert.ok(['accepted', 'rejected', 'needs-change'].includes(message.decision))
    if (message.kind === 'ack' && message.decision === 'accepted') {
      assert.ok(Array.isArray(message.appliedArtifactReferences) && message.appliedArtifactReferences.length > 0, 'Accepted ACK lacks actual applied artifacts')
      const role = plan.roles.find(role => role.id === message.fromRole)
      for (const reference of message.appliedArtifactReferences) {
        const path = await resolveReference(role, resolve(role.publishPrefix, message.revision), reference)
        assert.equal(await hashFile(path), digest(reference.sha256))
      }
    }
    return { ackOf: original.messageId, observedRevision: original.revision }
  }, { role: message.fromRole })
  if (stage !== 'baseline') for (const role of plan.roles) for (const handoff of role.handoffs) await check('handoff.required-route', () => {
    assert.ok(messages.some(message => message.fromRole === role.id && message.toRole === handoff.to && ['handoff', 'decision'].includes(message.kind)), 'Required handoff route was never published')
    return handoff
  }, { role: role.id })
  if (stage === 'collaboration') for (const role of roleIds.filter(role => role !== 'pmo')) await check('decision.recipient-ack', () => {
    const decisions = messages.filter(message => message.fromRole === 'pmo' && message.toRole === role && message.kind === 'decision' && message.revision === 'v003')
    assert.ok(decisions.length > 0, 'No final PMO decision delivered to this role')
    for (const decision of decisions) assert.ok(messages.some(message => message.fromRole === role && message.kind === 'ack' && message.decision === 'accepted' && message.ackOf === decision.messageId), 'Final decision not actually acknowledged')
  }, { role })

  if (stage === 'collaboration') await check('decision.budget-and-conflict-evidence', async () => {
    const owner = plan.roles.find(role => role.id === 'pmo'), directory = resolve(owner.publishPrefix, 'v003')
    const path = await boundedPath(directory, join(directory, 'decisions.json')), decision = await readJson(path)
    assert.equal(decision.schemaVersion, 1); assert.equal(decision.revision, 'v003'); assert.equal(decision.baseRevision, 'v002'); assert.equal(decision.status, 'approved')
    const budget = decision.budget
    assert.ok(budget && ['cloud', 'marketing', 'travel', 'tools', 'people', 'rent'].every(key => Number.isFinite(budget[key]) && budget[key] >= 0))
    assert.equal(budget.cloud, oracle.revision.cloudBudget); assert.equal(budget.people, oracle.revision.novemberPeopleCost); assert.equal(budget.rent, 12000)
    const discretionary = money(budget.cloud + budget.marketing + budget.travel + budget.tools), total = money(discretionary + budget.people + budget.rent)
    assert.ok(discretionary <= oracle.revision.discretionaryCap)
    for (const role of ['finance', 'operations', 'pmo']) {
      assert.equal(verifiedClaims.find(claim => claim.role === role && claim.id === 'approvedDiscretionaryTotal')?.value, discretionary)
      assert.equal(verifiedClaims.find(claim => claim.role === role && claim.id === 'approvedTotalExpense')?.value, total)
    }
    assert.ok(Array.isArray(decision.conflicts) && decision.conflicts.length > 0, 'No retained conflict-resolution evidence')
    for (const conflict of decision.conflicts) {
      assert.ok(conflict.id && conflict.reason && conflict.owner && Array.isArray(conflict.affectedRoles) && conflict.affectedRoles.length > 0)
      assert.ok(Array.isArray(conflict.proposals) && new Set(conflict.proposals.map(proposal => proposal.role)).size >= 2, 'Conflict must retain proposals from at least two roles')
      for (const proposal of conflict.proposals) {
        const role = plan.roles.find(role => role.id === proposal.role)
        assert.ok(role && versions.some(version => version.role === role.id && version.revision === proposal.revision))
        assert.ok(Number.isFinite(proposal.amount) && Array.isArray(proposal.evidence) && proposal.evidence.length > 0)
        for (const reference of proposal.evidence) {
          assert.notEqual(reference.scope, 'workspace', 'PMO conflict proof must use readable published evidence, not another private workspace')
          const source = await resolveReference(role, resolve(role.publishPrefix, proposal.revision), reference)
          assert.equal(await hashFile(source), digest(reference.sha256))
        }
      }
    }
    return { path, discretionary, total, conflicts: decision.conflicts.length }
  })

  const snapshot = await captureOfficeSnapshot(plan)
  await check('snapshot.complete', () => assert.equal(snapshot.complete, true, JSON.stringify(snapshot.issues)))
  const currentFiles = new Map(snapshot.files.map(file => [canonical(file.path), file]))
  await check('snapshot.matches-inspected-evidence', () => {
    const inspected = [...versions, ...artifacts, ...verifiedClaims.map(claim => claim.proof)]
    for (const file of inspected) assert.equal(currentFiles.get(canonical(file.path))?.sha256, file.sha256, 'File changed between inspection and final snapshot: ' + file.path)
    return { inspected: inspected.length }
  })
  for (const [name, previous] of [['initial', initialSnapshot], ['previous', previousSnapshot]]) if (previous) await check('immutability.' + name, () => {
    if (name === 'initial') assert.ok(previous.capturedBeforeFirstRun === true && previous.baselineKind === 'pre-run', 'An initial isolation baseline must explicitly be captured before the first run; post-start observations cannot certify earlier writes')
    assert.equal(previous.complete, true, 'Cannot certify isolation from an incomplete earlier snapshot')
    let protectedCount = 0
    for (const file of previous.files) {
      const immutable = file.scope === 'input' || file.scope === 'publication' || /(^|\/)deliverables\/v\d{3}\//.test(file.relativePath)
      if (!immutable) continue
      const current = currentFiles.get(canonical(file.path))
      assert.ok(current, 'An immutable input or prior publication disappeared: ' + file.path)
      assert.equal(current.sha256, file.sha256, 'An immutable input or prior version was overwritten: ' + file.path)
      protectedCount++
    }
    return { protectedFiles: protectedCount }
  })
  if (!initialSnapshot) await check('immutability.initial-evidence', () => missing('No independently captured pre-run snapshot; unchanged inputs cannot prove all past writes'))
  if (stage !== 'baseline' && !previousSnapshot) await check('immutability.prior-version-evidence', () => missing('No previous-stage snapshot; immutable historical revisions are not independently established'))

  await check('isolation.write-ownership', () => {
    if (!Array.isArray(writeEvidence?.events)) missing('Independently captured file events are required; final file placement alone cannot identify the writer')
    assert.ok(writeEvidence.source && writeEvidence.source !== 'role-self-report', 'Role self-report is not independent write evidence')
    const observed = new Set(), deniedAttempts = []
    for (const event of writeEvidence.events) {
      if (event.actor === 'harness' && event.harnessOwned === true) continue
      const role = plan.roles.find(role => role.id === event.roleId)
      assert.ok(role, 'Write event lacks an attributable role')
      assert.ok(event.sessionId && event.toolCallId, 'Write event lacks session/tool-call provenance')
      assert.ok(['succeeded', 'failed', 'denied'].includes(event.outcome), 'Mutation event outcome must be explicit')
      const session = sessionEvidence?.roles?.find(value => value.role === role.id)
      if (session) assert.equal(event.sessionId, session.sessionId, 'Write event came from another role session')
      assert.ok(typeof event.path === 'string' && isAbsolute(event.path), 'Write event path must be resolved absolutely')
      assert.ok(['create', 'read', 'update', 'delete', 'write', 'mkdir', 'rename'].includes(event.operation), 'Unknown filesystem operation in independent provenance')
      if (event.outcome === 'denied' || event.outcome === 'failed') {
        if (event.outcome === 'failed' && event.operation !== 'read' && event.mutated !== false && !inside(role.workspace, event.path) && !inside(role.publishPrefix, event.path)) missing('Failed cross-boundary command may have partially written; independent no-mutation evidence is missing')
        deniedAttempts.push({ role: role.id, path: event.path, outcome: event.outcome }); continue
      }
      if (event.operation === 'read') {
        assert.ok(inside(role.workspace, event.path) || inside(inputRoot, event.path) || inside(publishRoot, event.path), 'Role read or enumerated outside assigned roots: ' + (event.toolName ?? event.operation) + ' ' + event.path)
        continue
      }
      assert.ok(inside(role.workspace, event.path) || inside(role.publishPrefix, event.path), 'Cross-role or common-input write: ' + event.path)
      observed.add(role.id)
    }
    assert.deepEqual([...observed].sort(), [...roleIds].sort(), 'No attributed write evidence for one or more roles')
    return { events: writeEvidence.events.length, roles: [...observed], rejectedOrFailedAttempts: deniedAttempts }
  })
  await check('isolation.write-coverage', () => {
    if (writeEvidence?.complete !== true) missing('Observed built-in operations are only partial evidence; opaque commands, missing tool results or capture gaps prevent whole-run isolation certification')
    return { source: writeEvidence.source, complete: true }
  })
  await check('crud.temporary-deletion-and-retention', async () => {
    if (!crudEvidence?.complete || crudEvidence.source === 'role-self-report' || !Array.isArray(crudEvidence.entries)) missing('Independent CRUD evidence is required; a role checklist alone does not prove create/read/update/delete')
    const events = writeEvidence?.events || []
    for (const role of plan.roles) for (const format of new Set(role.deliverables.map(([path]) => formatOf(path)))) {
      const entry = crudEvidence.entries.find(entry => entry.role === role.id && entry.revision === revision && entry.format === format)
      assert.ok(entry, `Missing ${role.id}/${format} real temporary CRUD evidence`)
      assert.ok(inside(resolve(role.workspace, 'temp'), entry.tempPath), 'Deletion target is outside the actor temporary directory')
      assert.equal(entry.deleteAllowed, true); assert.equal(entry.purpose, 'delete-test')
      const registryPath = await boundedPath(role.workspace, entry.registryPath), registry = await readJson(registryPath)
      const registryEntries = Array.isArray(registry) ? registry : registry.entries
      const permission = registryEntries?.find(item => canonical(resolve(role.workspace, item.path)) === canonical(entry.tempPath))
      assert.ok(permission?.owner === role.id && permission.deleteAllowed === true && permission.purpose === 'delete-test', 'Actual temporary registry did not authorize this deletion')
      assert.ok(entry.createdSha256 && entry.modifiedSha256); assert.notEqual(digest(entry.createdSha256), digest(entry.modifiedSha256), 'Update did not modify real bytes')
      const formal = await boundedPath(role.workspace, entry.formalPath)
      assert.equal(digest(entry.formalSha256), await hashFile(formal), 'Formal original was damaged by CRUD')
      assert.equal(await exists(entry.tempPath), false, 'Explicitly deleted temporary file still exists')
      const operationEvents = {}
      assert.equal(new Set(Object.values(entry.toolCallIds || {})).size, 4, 'CRUD phases reuse a tool-call identity')
      for (const operation of ['create', 'read', 'update', 'delete']) {
        const event = events.find(event => event.toolCallId === entry.toolCallIds?.[operation] && event.roleId === role.id && canonical(event.path) === canonical(entry.tempPath))
        assert.ok(event?.outcome === 'succeeded', 'CRUD step has no successful independent tool provenance: ' + operation)
        assert.equal(event.operation, operation, 'CRUD references the wrong tool operation')
        assert.ok(Number.isFinite(event.at), 'CRUD event lacks a captured timestamp')
        operationEvents[operation] = event
      }
      assert.ok(operationEvents.create.at <= operationEvents.update.at && operationEvents.update.at <= operationEvents.read.at && operationEvents.read.at <= operationEvents.delete.at, 'CRUD timestamps do not prove readback of the modification before deletion')
      assert.equal(digest(operationEvents.create.afterSha256), digest(entry.createdSha256))
      assert.equal(digest(operationEvents.update.afterSha256), digest(entry.modifiedSha256))
      assert.equal(digest(operationEvents.read.readSha256), digest(entry.modifiedSha256))
      assert.equal(digest(operationEvents.delete.beforeSha256), digest(entry.modifiedSha256))
    }
    return { entries: crudEvidence.entries.length }
  })
  if (stage !== 'baseline') await check('recovery.verified-roundtrip', async () => {
    if (!Array.isArray(crudEvidence?.recoveries)) missing('Independent corruption/recovery evidence is missing')
    for (const role of plan.roles) {
      const entry = crudEvidence.recoveries.find(entry => entry.role === role.id && entry.format === role.recoveryFormat)
      assert.ok(entry && entry.corruptionDetected === true && entry.readbackVerified === true, 'Recovery was not detected and read back')
      assert.ok(inside(resolve(role.workspace, 'temp'), entry.restoredPath))
      const restored = await boundedPath(role.workspace, entry.restoredPath), original = await boundedPath(role.workspace, entry.originalPath)
      assert.equal(await hashFile(original), digest(entry.originalSha256), 'Recovery source no longer matches its preserved original')
      assert.equal(await hashFile(restored), digest(entry.originalSha256), 'Restored bytes do not match preserved source')
      assert.notEqual(digest(entry.corruptSha256), digest(entry.originalSha256))
      assert.ok(Array.isArray(entry.toolCallIds) && entry.toolCallIds.length >= 3)
      for (const id of entry.toolCallIds) assert.ok(writeEvidence?.events?.some(event => event.toolCallId === id && event.roleId === role.id), 'Recovery lacks independent tool provenance')
    }
  })
  await check('sessions.independent-real-work', () => {
    if (!sessionEvidence?.roles) missing('Independent six-session runtime evidence is missing')
    assert.equal(sessionEvidence.roles.length, 6)
    assert.equal(new Set(sessionEvidence.roles.map(value => value.sessionId)).size, 6)
    const runIds = sessionEvidence.roles.flatMap(value => (value.runs || []).filter(run => requiredVersions.includes(run.revision)).map(run => run.runId))
    assert.equal(new Set(runIds).size, runIds.length, 'The same real run was attributed to more than one office stage')
    assert.deepEqual(sessionEvidence.roles.map(value => value.role).sort(), [...roleIds].sort())
    for (const role of sessionEvidence.roles) {
      assert.equal(role.mode, 'work'); assert.ok(role.sessionId); assert.equal(role.modelId, 'deepseek-v4.1-flash-1017')
      const expected = plan.roles.find(value => value.id === role.role)
      assert.equal(canonical(role.workspace), canonical(expected.workspace))
      for (const version of requiredVersions) {
        const run = role.runs?.find(value => value.revision === version)
        assert.ok(run?.runId && run.terminalOutcome === 'succeeded', 'Queued/incomplete/failed stage is not a completed real turn')
      }
    }
    return { sessions: 6, revisions: requiredVersions }
  })
  if (stage === 'collaboration') await check('final.unresolved-issues', () => {
    for (const version of versions.filter(version => version.revision === 'v003')) for (const issue of version.unresolvedIssues) {
      if (typeof issue === 'string' || !issue.severity) missing('Unclassified remaining issue in final publication: ' + version.role)
      assert.ok(!['blocking', 'blocker', 'critical', 'high'].includes(issue.severity), 'Final publication still has an unresolved blocking issue: ' + version.role)
    }
  })
  const summary = { passed: checks.filter(check => check.status === 'passed').length, failed: checks.filter(check => check.status === 'failed').length,
    notVerified: checks.filter(check => check.status === 'not-verified').length, checks: checks.length }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), stage, revision,
    passed: summary.failed === 0 && summary.notVerified === 0, summary, oracle, checks, versions, artifacts, verifiedClaims, messages, snapshot,
    limitations: ['Structural/render/formula checks are delegated to an independently supplied audit-office-artifacts.py report and bound to current file hashes.',
      'A snapshot cannot prove which session wrote a file; complete runtime write provenance and six real Work run identities are separately required.',
      'Document narrative quality and semantic consistency outside the explicitly located metrics still require reviewing the actual rendered outputs.'] }
}

async function cli() {
  const args = process.argv.slice(2), options = {}
  for (let index = 0; index < args.length; index += 2) { assert.ok(args[index].startsWith('--') && args[index + 1], 'Use --config file --output file [--snapshot-only true]'); options[args[index].slice(2)] = args[index + 1] }
  assert.ok(options.config && options.output, 'Use --config file --output file')
  const configPath = resolve(options.config), config = await readJson(configPath), base = dirname(configPath)
  const plan = config.plan ?? await readJson(resolve(base, config.planPath))
  const output = resolve(options.output), { roots } = planRoots(plan)
  assert.ok(roots.every(root => !inside(root.path, output)), 'Audit output must stay outside role/input/publication roots')
  const supplied = async key => config[key] ?? (config[key + 'Path'] ? readJson(resolve(base, config[key + 'Path'])) : undefined)
  const result = options['snapshot-only'] === 'true' ? await captureOfficeSnapshot(plan) : await auditOfficeCompany({ plan, stage: config.stage ?? 'baseline',
    artifactReport: await supplied('artifactReport'), writeEvidence: await supplied('writeEvidence'), initialSnapshot: await supplied('initialSnapshot'),
    previousSnapshot: await supplied('previousSnapshot'), sessionEvidence: await supplied('sessionEvidence'), crudEvidence: await supplied('crudEvidence') })
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ output, passed: result.passed, summary: result.summary, snapshotFiles: result.files?.length }) + '\n')
  if (result.passed === false || result.complete === false) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
