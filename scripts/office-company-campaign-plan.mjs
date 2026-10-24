/** Data only: six genuine office roles, shared synthetic business facts and
 * reviewable acceptance. The root owns file materialization, Work sessions,
 * submission timing, browser execution and independent result verification.
 */

const json = value => JSON.stringify(value, null, 2) + '\n'
const csv = rows => rows.map(row => row.map(value => {
  const text = String(value)
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
}).join(',')).join('\n') + '\n'

export const officeCompany = {
  name: '青禾智研', legalStatus: '完全虚构的测试公司', currency: 'CNY',
  period: { closeMonth: '2026-10', forecastMonth: '2026-11' },
  business: '向企业提供流程分析软件及实施服务，客户、员工、合同和预算全部为合成测试数据。',
  policies: {
    amounts: '合同额、收入和费用均为不含税金额；应收发票与收款为含税金额，禁止混加。',
    tax: '本场景服务销项税率固定 6%，仅作为合成数据计算条件，不据此声称真实税务合规。',
    recognition: '服务期从月初开始的合同按服务月均匀分摊收入；签约、开票、回款与收入确认分别核算。',
    payroll: '本场景雇主附加成本为应计工资的 12%；月中入职按当月实际日历天数计薪，入职日计入。无需计算真实个人所得税或实际支付。',
    rounding: '金额四舍五入到分；百分比保持数值格式。先保留计算精度，按明细金额落账，再合计。',
    openingCash: 420000, openingCashDate: '2026-11-01',
    cashBudget: '420000 为十一月一日期初现金。费用表及人员成本数值直接作为本演练当月现金支出，不另加进项税；不建模税款结缴。现金预测需明确这一假设，不能将其冒称正式现金流量表。',
    forecastCollections: '仅使用已开票未回款余额并按明确收款日期预测；销售机会概率加权金额单列，不充当已实现收入或确定现金。',
    businessCalendar: '所有日期均为 Asia/Shanghai 的业务日期；不需要联系真实客户、发送邮件、付款、签署或外部发布。'
  }
}

const contracts = [
  ['contract_id', 'customer', 'owner_employee_id', 'start_date', 'service_months', 'net_contract_amount', 'vat_rate', 'status'],
  ['C001', '松柏制造（合成）', 'E003', '2026-10-01', 12, 240000, 0.06, 'signed'],
  ['C002', '晨光物流（合成）', 'E004', '2026-10-01', 6, 144000, 0.06, 'signed'],
  ['C003', '云杉零售（合成）', 'E003', '2026-11-01', 3, 96000, 0.06, 'signed']
]
const receivables = [
  ['invoice_id', 'contract_id', 'invoice_date', 'invoice_gross', 'cash_received_gross', 'received_date', 'remaining_due_date'],
  ['INV001', 'C001', '2026-10-01', 254400, 127200, '2026-10-15', '2026-11-15'],
  ['INV002', 'C002', '2026-10-01', 152640, 76320, '2026-10-18', '2026-11-20'],
  ['INV003', 'C003', '2026-11-01', 101760, 0, '', '2026-11-25']
]
const employees = [
  ['employee_id', 'display_name', 'department', 'job_family', 'monthly_gross', 'employment_start', 'status'],
  ['E001', '林澄（合成）', '财务', 'finance', 18000, '2026-01-01', 'active'],
  ['E002', '周禾（合成）', '人事', 'people', 16000, '2026-01-01', 'active'],
  ['E003', '沈言（合成）', '销售', 'sales', 22000, '2026-01-01', 'active'],
  ['E004', '许宁（合成）', '客户成功', 'customer_success', 18000, '2026-01-01', 'active'],
  ['E005', '顾远（合成）', '研发', 'engineering', 26000, '2026-01-01', 'active'],
  ['E006', '叶舟（合成）', '研发', 'engineering', 24000, '2026-01-01', 'active'],
  ['E007', '唐雨（合成）', '运营', 'operations', 17000, '2026-01-01', 'active'],
  ['E008', '苏晴（合成）', '项目管理', 'pmo', 21000, '2026-01-01', 'active']
]
const expenses = [
  ['expense_id', 'category', 'november_net_budget', 'owner_role', 'protection'],
  ['B001', '办公租赁', 12000, 'operations', 'fixed'],
  ['B002', '云资源', 18000, 'operations', 'discretionary'],
  ['B003', '市场活动', 15000, 'sales', 'discretionary'],
  ['B004', '差旅', 8000, 'operations', 'discretionary'],
  ['B005', '协作软件', 5000, 'operations', 'discretionary']
]
const pipeline = [
  ['opportunity_id', 'customer', 'owner_employee_id', 'net_amount', 'probability', 'expected_sign_date', 'stage'],
  ['O001', '远山电子（合成）', 'E003', 264000, 0.6, '2026-11-18', 'proposal'],
  ['O002', '清流食品（合成）', 'E004', 180000, 0.35, '2026-12-05', 'discovery'],
  ['O003', '星野设备（合成）', 'E003', 120000, 0.8, '2026-11-28', 'negotiation']
]
const milestones = [
  ['milestone_id', 'contract_id', 'deliverable', 'owner_role', 'due_date', 'dependency', 'status'],
  ['M001', 'C001', '需求确认与实施计划', 'sales', '2026-11-03', '', 'planned'],
  ['M002', 'C002', '实施范围确认与客户培训', 'sales', '2026-11-12', '', 'planned'],
  ['M003', 'C003', '账号开通与上线检查', 'operations', '2026-11-06', 'M001', 'planned'],
  ['M004', 'ALL', '十一月预算批准', 'pmo', '2026-11-05', '', 'planned'],
  ['M005', 'ALL', '月度经营评审', 'pmo', '2026-11-26', 'M002;M003;M004', 'planned']
]

export const officeRevisionFacts = {
  schemaVersion: 1, changeSet: 'NOV-REV-002', effectiveDate: '2026-11-01',
  changes: [
    { id: 'CH001', authoritativeOwner: 'sales', subject: 'C002', oldNetAmount: 144000, newNetAmount: 120000,
      explanation: '客户确认缩减总服务范围，已完成的十月收入 24000 不回退；剩余五个月分摊余下 96000。已收 76320 不变，原全额发票应提出含税 25440 的红冲/贷项调整草案，不执行真实开票。培训日期改为 2026-11-18。' },
    { id: 'CH002', authoritativeOwner: 'people', employee: { employee_id: 'E009', display_name: '陆溪（合成）', department: '客户成功', job_family: 'customer_success', monthly_gross: 15000, employment_start: '2026-11-11', status: 'approved_to_join' },
      explanation: '新增客户成功专员，从十一月十一日起计入当月成本；原八位员工不变。该岗位已获批准，不可在削减预算时静默移除。' },
    { id: 'CH003', authoritativeOwner: 'operations', subject: 'B002', oldAmount: 18000, newAmount: 12000,
      explanation: '取得同等服务等级的合成云资源报价，十一月预算可降至 12000；仅制作采购比较和审批草案，不实际下单。' },
    { id: 'CH004', authoritativeOwner: 'sales', subject: 'B003', proposedAmount: 20000,
      explanation: '销售申请客户研讨活动预算由 15000 增至 20000；这是待批准提案，不能当成已批准预算。' },
    { id: 'CH005', authoritativeOwner: 'pmo', discretionaryCap: 30000,
      explanation: '管理层要求十一月云资源、市场活动、差旅、协作软件四项合计不超过 30000；工资、附加成本、办公租赁不在此上限内。各方必须提交差异与取舍，PMO 给出有依据的版本化决议并收齐 ACK。' },
    { id: 'CH006', authoritativeOwner: 'compliance', classification: 'internal-synthetic',
      explanation: '对外展示稿只保留岗位/部门和汇总薪资，不包含逐人薪资；内部工资明细仍保留在 HR/财务受控工作文件。所有最终资料必须带“合成数据演练”标识、版本和来源说明。' }
  ],
  referenceResolution: { status: '仅供调度器验收的可行方案，不作为模型必须照抄的唯一方案',
    cloud: 12000, marketing: 10000, travel: 3000, tools: 5000,
    discretionaryTotal: 30000, peopleCost: 192640, rent: 12000, totalExpense: 234640 }
}

export const officeCompanySeedFiles = {
  baseline: {
    'company-v1.json': json(officeCompany),
    'contracts-v1.csv': csv(contracts), 'receivables-v1.csv': csv(receivables),
    'employees-v1.csv': csv(employees), 'expense-budget-v1.csv': csv(expenses),
    'sales-pipeline-v1.csv': csv(pipeline), 'milestones-v1.csv': csv(milestones),
    'document-register-v1.csv': csv([
      ['document_id', 'title', 'owner_role', 'classification', 'status'],
      ['D001', '月度资金及预算分析', 'finance', 'internal-finance', 'planned'],
      ['D002', '人员计划及入职手册', 'people', 'internal-people', 'planned'],
      ['D003', '客户经营与范围变更建议', 'sales', 'internal', 'planned'],
      ['D004', '运营排期及采购方案', 'operations', 'internal', 'planned'],
      ['D005', '经营评审及管理决议', 'pmo', 'internal', 'planned'],
      ['D006', '文控及版本一致性检查', 'compliance', 'internal', 'planned']
    ])
  },
  // Materialize this only when the revision phase is dispatched. The optional
  // reference resolution stays in the plan for the root, outside model input.
  revision: { 'revision-v2.json': json({ ...officeRevisionFacts, referenceResolution: undefined }) }
}

export const officeHandoffContract = {
  schemaVersion: 1,
  outputConvention: '<own workspace>/deliverables/v001, v002, v003; <publishRoot>/<role>/vNNN',
  messageConvention: '<publishRoot>/<senderRole>/messages/<unique-message-id>.json',
  manifestFields: ['schemaVersion', 'role', 'revision', 'baseRevision', 'generatedAt', 'inputHashes', 'artifacts', 'claims', 'unresolvedIssues'],
  artifactFields: ['relativePath', 'mediaType', 'sha256', 'bytes', 'classification', 'readbackEvidence'],
  messageFields: ['schemaVersion', 'messageId', 'createdAt', 'fromRole', 'toRole', 'kind', 'revision', 'baseRevision', 'correlationId', 'requiresAck', 'claims', 'evidence'],
  ackFields: ['ackOf', 'observedRevision', 'decision', 'reason', 'appliedArtifactReferences'],
  rules: [
    '每个角色只写自己的工作区和 publish 下自己的角色前缀；他人成果、公共输入、其他会话及浏览器标签均只读，禁止直接修改。',
    'v001/v002/v003 一旦发布不可覆写。修订使用新版本，保留来源版本、文件哈希、变更清单和撤回说明；不要共享可写的 latest.json。',
    '消息采用唯一 ID，收件人只在自己的 messages 目录写 ACK/NACK；重试使用同一 correlationId 并注明 retryOf，防止重复应用。',
    '业务声明必须带范围、月份、币种、含税/不含税口径和文件页码或工作表单元格；不能只复制自然语言结论。',
    '发现 baseRevision 过期或金额冲突时先 NACK/提出异议，保留两方版本和差异；由明确数据 owner 或 PMO 决议推进，禁止最后写入者胜出。',
    '各角色可独立完成 v001，不因其他角色尚未发布而无限等待；将待交接信息列为待核实。v003 结论必须使用已发布、已核验的对方版本，不能把缺失输出当成功。',
    '共享发布区只发布必要的角色摘要及脱敏成果；逐人薪资底表留在自己的工作区，财务接收 HR 的部门合计与带校验值的受控摘要即可。',
    '跨角色通知使用上述本地 handoff 文件；不发送真实邮件、聊天消息、支付、签署或公开发布。'
  ]
}

const roles = [
  { id: 'finance', title: '财务与经营分析', inputs: ['company-v1.json', 'contracts-v1.csv', 'receivables-v1.csv', 'employees-v1.csv', 'expense-budget-v1.csv'],
    goal: '为经营例会建立十月收入/应收对账和十一月资金、人员及费用预算，区分合同额、确认收入、发票、回款和机会预测，形成可审查的管理建议。',
    deliverables: [
      ['finance-model.xlsx', '输入、月度收入、应收、人员成本、费用预算、现金预测、校验表；使用可复算公式和明确单位，输入/公式样式区分，有汇总图表、冻结标题和打印区域。'],
      ['finance-memo.docx', '经营分析备忘录，包含结论、关键数字、假设、风险与需批准事项，表格和页码完整。'],
      ['finance-memo.pdf', '从同版本正式文档导出的可读 PDF，核对分页、表格、字体和数字。'],
      ['finance-ledger.csv', '可复用的合同收入/应收及预算明细，保留稳定 ID、月份、口径与数值列。']
    ],
    baselineAcceptance: ['十月收入 44000；十一月基线收入 76000；C003 不计入十月收入。', '十月底仅已开票 INV001/INV002 的应收余额合计 203520；十一月新票 INV003 单列，不混入十月底余额。', '十一月基线工资 162000、雇主附加 19440、人员成本 181440，非人员预算 58000，总费用 239440。', '公式不是写死结果：在本人临时副本把云预算加 1000，重算后总费用必须相应加 1000，随后恢复，提交前无 #REF!/#VALUE! 等错误。'],
    revision: '读修订事实与已发布 Sales/HR/运营 v002 摘要，C002 剩余合同额按五个月重摊并提列发票调整草案；纳入 E009 日历日成本和云报价。把销售 20000 活动提案与 PMO 30000 上限冲突分列，不替 PMO 擅自批准。形成 v002 差异桥和更新预测。',
    handoffs: [{ to: 'pmo', subject: '收入、人员成本、预算冲突及现金影响' }, { to: 'compliance', subject: '财务口径、公式校验及发布脱敏证据' }],
    inbound: ['sales: C002 合同范围和发票调整事实', 'people: E009 成本摘要', 'operations: 云采购报价', 'pmo: 最终预算决议'] },
  { id: 'people', title: '人事与组织运营', inputs: ['company-v1.json', 'employees-v1.csv', 'milestones-v1.csv'],
    goal: '交付可执行的十一月编制与入职管理包，算清人员成本，说明岗位责任、入职检查清单、培训排期和权限收回机制。',
    deliverables: [
      ['people-plan.xlsx', '人员台账、部门汇总、月度成本、招聘/入职任务、培训排期及校验；公式计算工资附加成本，不暴露逐人薪资到公开摘要。'],
      ['onboarding-guide.docx', '面向新员工的入职手册和经理检查清单，包含负责人、时点、可验收条件、资料分级及权限规则。'],
      ['onboarding-guide.pdf', '供内部阅览的同版本导出件，检查可检索文字与分页。'],
      ['employee-register.csv', '稳定员工 ID 的结构化台账；不得捏造身份证、手机号、银行账户。']
    ],
    baselineAcceptance: ['八位在职员工无重号，部门人数合计八人，工资与附加成本与基线一致。', '对人员明细和管理层汇总分级，publish 摘要不含逐人薪资；入职手册职责、日期、检查项可执行。', '读回生成的 DOCX/XLSX/CSV，验证人数、中文名、日期类型和金额，不用文件存在代替内容正确。'],
    revision: '纳入十一月十一日入职的 E009：当月计薪二十天，工资 10000、附加 1200、当月成本 11200；编制变九人，培训及权限申请排期更新。输出 v002 部门增量摘要和变更对照，原八人不被覆盖。',
    handoffs: [{ to: 'finance', subject: '部门人数与 E009 当月增量成本 11200' }, { to: 'operations', subject: 'E009 设备/账号/培训准备清单' }, { to: 'compliance', subject: '薪资明细与可发布摘要的分级策略' }],
    inbound: ['operations: 设备账号准备时间', 'pmo: 编制与运营资源决议', 'compliance: 对外稿脱敏检查'] },
  { id: 'sales', title: '销售与客户成功', inputs: ['company-v1.json', 'contracts-v1.csv', 'receivables-v1.csv', 'sales-pipeline-v1.csv', 'milestones-v1.csv'],
    goal: '制作客户经营计划与管理层汇报，明确已签合同、机会漏斗、回款跟进和客户交付责任，形成客户范围变更的可审查草案。',
    deliverables: [
      ['customer-plan.xlsx', '合同、机会漏斗、概率加权预测、回款待办及客户成功里程碑；机会收入与已签收入分开。'],
      ['customer-brief.pptx', '六至八页经营评审演示文稿：客户组合、漏斗、收入/回款口径、重点客户风险、实施排期、待批准决策；含可编辑图表或准确图形与来源。'],
      ['scope-change-proposal.docx', 'C002 范围变更/沟通草案，明确原方案、变更项、金额、服务期及待批准事项，不能伪造客户签署。'],
      ['customer-brief.pdf', '与 PPTX 同版本导出件，逐页视觉检查，标题、图表、中文字体和页边距一致。'],
      ['customer-followups.csv', '客户 ID、负责人、日期、动作、状态、依据版本的跟进清单，仅本地草案，不发送真实消息。']
    ],
    baselineAcceptance: ['已签合同不含税总额 480000，机会概率加权总额 317400，二者分栏且不混为确认收入。', '客户与合同、发票、里程碑均按稳定 ID 关联；不存在客户串项或错误复制金额。', 'PPTX/PDF 至少六页且与底表金额一致，每页无溢出/遮挡；至少一页明确需批准事项。'],
    revision: '把 C002 总额改为 120000、培训改到十一月十八日，十月确认收入保持 24000；提出含税 25440 调整草案并保持已收 76320 不变。提出活动预算 20000 的商业理由和可缩减方案，明确待 PMO 批准，向财务发送金额口径证据。',
    handoffs: [{ to: 'finance', subject: 'C002 合同总额、已实现月份与发票调整事实' }, { to: 'operations', subject: '客户培训改期与服务准备' }, { to: 'pmo', subject: '活动预算申请及可削减方案' }],
    inbound: ['finance: 应收和收入口径核对', 'operations: 培训资源可行性', 'pmo: 活动预算批准/驳回决议'] },
  { id: 'operations', title: '运营与采购协调', inputs: ['company-v1.json', 'expense-budget-v1.csv', 'milestones-v1.csv', 'employees-v1.csv'],
    goal: '完成十一月运营排期、服务资源和采购方案，在交付与预算约束间提供有依据的选择，包含负责人、依赖、风险与验收节点。',
    deliverables: [
      ['operations-plan.xlsx', '月度排期、资源容量、采购比较、预算、风险/待办；费用和日期依赖可追溯，公式合计及数据验证有效。'],
      ['operations-runbook.docx', '客户上线/培训、入职设备账号准备及应急回退流程，含责任人、检查点和审批边界。'],
      ['operations-runbook.pdf', '正式可读导出，流程、表格与页码完整。'],
      ['operations-tasks.csv', '可导入任务清单，稳定任务 ID、owner、开始/截止日期、依赖、状态、版本。']
    ],
    baselineAcceptance: ['预算五项合计 58000，其中可调四项 46000；租赁 12000 单列。', '五项里程碑均有责任、日期和依赖，无结束早于开始或自依赖；识别可调资源而非伪造已经下单。', 'XLSX、DOCX、PDF、CSV 的主要排期、预算与任务 ID 一致。'],
    revision: '采用云资源 12000 的可比报价，列明等价服务条件与回退要求；接收 C002 培训改期及 E009 入职准备，更新资源冲突。对销售活动 20000 与管理层上限 30000 提交至少两个可审查方案，不通过覆盖销售或财务文件“消除”冲突。',
    handoffs: [{ to: 'finance', subject: '云采购费用 12000 与预算差异' }, { to: 'people', subject: 'E009 准备完成条件与日期' }, { to: 'sales', subject: '客户培训资源安排' }, { to: 'pmo', subject: '三万元上限的可行费用组合与取舍' }],
    inbound: ['sales: 培训日期与活动需求', 'people: 入职与账号清单', 'pmo: 最终资源预算决议'] },
  { id: 'pmo', title: 'PMO 与经营管理', inputs: ['company-v1.json', 'expense-budget-v1.csv', 'milestones-v1.csv', 'contracts-v1.csv', 'employees-v1.csv'],
    goal: '建立经营评审包、跨部门依赖及决策台账；在共同事实基础上提出计划，待各角色发布后审阅证据并协调预算和版本冲突。',
    deliverables: [
      ['management-dashboard.xlsx', '指标与证据索引、里程碑、预算汇总、风险、决策和行动项；每个数值关联来源版本。'],
      ['management-review.pptx', '八至十页经营评审：现状、财务、人力、客户、运营、冲突、决策与跟进；缺失证据明确标待核实。'],
      ['decision-minutes.docx', '评审纪要与决策草案，包含提案人、不同意见、依据、决议、owner、截止与 ACK 状态。'],
      ['management-review.pdf', '演示稿正式导出，核对逐页版式和跨页数字一致性。'],
      ['decision-register.csv', '稳定决策 ID、议题、基线版本、决定、owner、期限、状态和证据路径。']
    ],
    baselineAcceptance: ['v001 可独立产出并标记其他角色待核实，禁止编造已经收到的交接、批准或 ACK。', '经营指标区分实际、预测、提案和批准；同一指标不出现两个没有说明的金额。', '任务依赖、风险和决策有明确负责人，PPTX/PDF 与决策台账一致。'],
    revision: '正式施加四项可调费用合计不超过 30000 的约束，工资/附加/租赁受保护；收集销售与运营方案、财务核算、人事入职和文控意见，登记每项冲突。v002 先列提案与待核实证据；协作阶段才能在 v003 决议中给出批准方案、理由、影响和 ACK 要求。不得自行改写其他角色产物。',
    handoffs: [{ to: 'finance', subject: '批准预算及现金预测重算要求' }, { to: 'people', subject: '保护已批准编制及入职资源要求' }, { to: 'sales', subject: '活动预算批准与客户计划调整' }, { to: 'operations', subject: '资源费用组合决议' }, { to: 'compliance', subject: '决议证据与 ACK 完整性复核' }],
    inbound: ['finance: 收入/成本与差异桥', 'people: 人数及增量成本', 'sales: 业务事实及预算提案', 'operations: 可行资源组合', 'compliance: 版本/脱敏/证据风险'] },
  { id: 'compliance', title: '合规与文控', inputs: ['company-v1.json', 'document-register-v1.csv', 'contracts-v1.csv', 'employees-v1.csv'],
    goal: '建立公司文档分级、版本、来源和审批制度，检查经营材料的一致性与可追溯性；提供文控建议，不冒充律师、审计师或真实合规认证。',
    deliverables: [
      ['document-control-policy.docx', '命名/版本、只读发布、审批与撤回、保留/删除、数据分级、冲突处理和证据要求，附可执行检查清单。'],
      ['document-register.xlsx', '文档主表、版本关系、问题登记、审批与 ACK、脱敏检查；唯一 ID/版本组合校验及状态验证。'],
      ['document-control-policy.pdf', '正式可检索导出，中文、表格、页码与 DOCX 一致。'],
      ['document-awareness.pptx', '四至六页内部培训，说明合成数据、薪资最小披露、版本冲突、恢复与删除审计。'],
      ['document-register.csv', '机器可读版本与问题清单，保留稳定 ID、owner、哈希、前版、分类和处置状态。']
    ],
    baselineAcceptance: ['六类文件责任人及分类齐全；不会把尚未收到的文件登记为已审查通过。', '临时删除、恢复、哈希、版本和批准证据要求可执行，问题分为阻断/需修正/建议并给 owner。', '公共展示稿不含逐人薪资；合成数据标识、来源和资质边界明确。'],
    revision: '发布 CH006 的展示稿最小披露要求；检查各角色 v002 的版本链、金额口径、公式/导出校验、删除与恢复证据，并记录预算冲突未解决项。协作阶段核对最终决议及所有 ACK，形成逐件可复核的问题清单；不得替别人修改文件或把未复验问题直接关闭。',
    handoffs: [{ to: 'pmo', subject: '阻断项、版本冲突、脱敏与 ACK 缺口' }, { to: 'finance', subject: '财务导出与金额证据整改' }, { to: 'people', subject: '薪资摘要最小披露检查' }, { to: 'sales', subject: '演示与合同草案版本检查' }, { to: 'operations', subject: '排期与采购审批证据检查' }],
    inbound: ['所有角色: manifest、变更记录、CRUD/恢复证据', 'pmo: 决议及 ACK 汇总索引'] }
]

export const officeCompanyAcceptance = {
  baselineExpected: {
    signedNetContracts: 480000, probabilityWeightedPipeline: 317400,
    octoberRevenue: 44000, novemberRevenue: 76000, octoberReceivablesGross: 203520,
    novemberGrossSalary: 162000, employerSupplement: 19440, peopleCost: 181440,
    nonPeopleBudget: 58000, discretionaryBudget: 46000, totalExpense: 239440
  },
  revisionExpected: {
    c002NetContract: 120000, c002OctoberRevenue: 24000, c002RemainingFiveMonthsNet: 96000,
    c002MonthlyRevenueFromNovember: 19200, novemberTotalRevenue: 71200,
    c002GrossAdjustment: 25440, c002GrossReceivableAfterAdjustment: 50880,
    headcount: 9, e009PayrollDays: 20, e009GrossSalary: 10000, e009Supplement: 1200, e009Cost: 11200,
    novemberPeopleCost: 192640, cloudBudget: 12000, requestedMarketingBudget: 20000,
    proposedDiscretionaryTotal: 45000, discretionaryCap: 30000,
    finalTotalExpenseUpperBound: 234640
  },
  invariants: [
    '六个不同 Work 会话、六个不同工作区；全过程写文件均属于本人工作区或本人 publish 前缀，共同输入及他人前缀无改变。',
    '基础阶段有六次真实提交及六个可核验 v001；修订阶段再有六次真实提交和六个 v002，不把排队或自报完成当成成功。',
    'docx/xlsx/pptx/pdf/csv 五种格式均有真实内容、可读回、经业务修订生成新版本；扩展名、MIME 和文件结构相符。',
    '每类格式至少有一次本人明确登记临时副本的创建/读取/修改/删除证据；删除后文件确实不存在，审计记录和正式原件仍保留。',
    '至少财务 XLSX、销售 PPTX、人事 DOCX、运营 PDF、文控 CSV 分别完成一次临时损坏检测→从保留版本恢复→读回与哈希校验，不能以重新空建代替恢复。',
    '所有 XLSX 关键结果来自公式并有重算/差异校验；保留公式文本与计算结果证据，不用模型叙述或写死缓存冒充公式正确。',
    'DOCX/PPTX/PDF 有真实渲染或页面预览证据，中文与图表无裁切/重叠，导出的数字与同版本源文件一致；没有渲染工具时明确失败，不能省略验收。',
    '交接消息 ID 唯一、版本/哈希存在且匹配；收件人在自己前缀写 ACK，过期 baseRevision 被明确 NACK 或保留为冲突，不静默套用。',
    'PMO 最终决议的可调费用不超过 30000，保留受保护人员和租赁；每个受影响 owner 有实际 ACK 和自己 v003 的应用证据。',
    'C002、E009、云费用在财务、销售、人事、运营、管理材料中口径一致；提案与批准不混淆；文控未复验问题不虚假关闭。',
    '没有真实邮件、支付、签署、公开发布；没有真实个人敏感信息或虚构专业认证。'
  ],
  coverageByFormat: {
    docx: ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance'],
    xlsx: ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance'],
    pptx: ['sales', 'pmo', 'compliance'],
    pdf: ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance'],
    csv: ['finance', 'people', 'sales', 'operations', 'pmo', 'compliance']
  }
}

const commonProfessionalRequirements = `请以正常公司办公交付标准完成业务目标，使用可用的专业文档/表格/演示/PDF 技能及工具，不因当前工具调用不方便而减少业务内容。你不具有真实财务、法律或审计资质，不作真实认证。
每个正式文件必须真实写入磁盘并重新读取验证；完整路径体现角色与版本，封面/说明页/元数据体现月份及“合成数据演练”。CSV 用 period、revision、data_scope 等字段记录，不在表头前插入会破坏导入的说明段。XLSX 保留可复算公式、明确单位、格式、打印设置和校验表；DOCX/PPTX/PDF 要实际渲染或预览检查中文字体、分页、表格和图表，并保留证据。不能用更名文本、截图拼装或空白壳替代原格式。读取能力正常也不能省略写入后的验证。
每轮在本人目录写 evidence/ 下的 input-hashes.json、artifact-manifest.json、readback.json、render-review.md 和 issues.json；记录实际工具结果、文件哈希、结构/页数/单元格/金额证据及未解决问题，不虚报已测。
执行安全的 CRUD：给每种本角色产物各复制一份到本人 temp/crud/，先写 temp-registry.json 记录路径、owner、sha256、purpose=delete-test、deleteAllowed=true；只对这些明确标记且位于本人 temp 内的副本进行业务字段修改、读回与删除验证。删除前检查绝对路径边界，删除后记录不存在，保留正式原件和不可删审计日志。禁止递归清理工作区、publish 或他人文件。
按角色指定格式做一次恢复演练：在本人 temp/recovery 下制作保留原件与故意损坏副本，验证损坏确被发现，再从保留版本恢复、重新读取并比较哈希。不能损坏正式文件或改用空白新文件充数。
所有协作仅通过本地版本化 publish 与 messages 协议进行；不发真实邮件、不付款、不签署、不对外发布。若权限、格式、渲染或工具失败，保留原件和错误证据，修正后复验；确实无法完成则明确列失败，不能缩减要求后宣布成功。`

const recoveryFormat = { finance: 'xlsx', people: 'docx', sales: 'pptx', operations: 'pdf', pmo: 'xlsx', compliance: 'csv' }
const pathKey = value => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

export function createOfficeCompanyPlan({ roleWorkspaces, inputRoot, publishRoot, previewOrigins = {} }) {
  if (!inputRoot || !publishRoot || !roleWorkspaces) throw new Error('Office plan requires explicit inputRoot, publishRoot and six role workspaces')
  const paths = [inputRoot, publishRoot, ...roles.map(role => roleWorkspaces[role.id])]
  if (paths.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Every office role needs a concrete independent workspace')
  const normalized = paths.map(pathKey)
  if (new Set(normalized).size !== normalized.length) throw new Error('Office input, publish and role workspaces must be distinct')
  for (let left = 0; left < normalized.length; left++) for (let right = left + 1; right < normalized.length; right++) {
    if (normalized[left].startsWith(normalized[right] + '/') || normalized[right].startsWith(normalized[left] + '/')) throw new Error('Office input, publish and role workspaces must not nest inside each other')
  }
  const plans = roles.map(role => {
    const workspace = roleWorkspaces[role.id]
    const context = `你是青禾智研的${role.title}角色，角色 ID=${role.id}。你的唯一工作目录：${workspace}。只读合成输入目录：${inputRoot}。版本发布根目录：${publishRoot}，你只能写其中 ${role.id}/ 前缀，其他角色前缀只读。
业务月份：十月结账、十一月计划；币种人民币。先读取 ${role.inputs.join('、')}。正式产物按 deliverables/v001、v002、v003 分开，旧版本不覆盖。
${commonProfessionalRequirements}
本角色恢复演练指定格式：${recoveryFormat[role.id]}。
协作规则：${officeHandoffContract.rules.join('\n')}
manifest 字段：${officeHandoffContract.manifestFields.join(', ')}；artifact 字段：${officeHandoffContract.artifactFields.join(', ')}；消息字段：${officeHandoffContract.messageFields.join(', ')}；ACK 附加字段：${officeHandoffContract.ackFields.join(', ')}。`
    const browser = previewOrigins[role.id]
      ? `\n本角色 HTML 预览服务地址为 ${previewOrigins[role.id]}。如制作经营看板/验收索引页面，使用 Aether 内置 browser_* 辅助开发与检查，复用本会话标签，真实操作后读 snapshot/console/network；不得打开其他角色标签或外部浏览器替代。文件本身仍需专业格式读取与渲染。`
      : '\n如需要浏览器辅助查看本地看板/验收索引，使用 Aether 内置 browser_* 并只操作本会话标签；浏览器能力不足不能替代办公原格式的读取、修改和渲染验证。'
    const files = role.deliverables.map(([file, purpose]) => `${file}：${purpose}`).join('\n')
    return { ...role, workspace, publishPrefix: `${publishRoot}/${role.id}`, recoveryFormat: recoveryFormat[role.id],
      stages: [
        { id: `OFFICE-${role.id}-BASE`, kind: 'baseline', revision: 'v001',
          prompt: `${context}\n第一轮业务目标：${role.goal}\n交付文件：\n${files}\n基线验收：${role.baselineAcceptance.join('\n')}\n本轮先独立完成 v001 并发布必要摘要与 manifest。尚未收到其他角色产物时标为待核实，不无限等待、不编造对方结果。完成真实 CRUD 证据，准备恢复演练。${browser}` },
        { id: `OFFICE-${role.id}-REVISION`, kind: 'revision', revision: 'v002', baseRevision: 'v001',
          prompt: `${context}\n第二轮业务修订：先读取本人 v001 和新发布的 revision-v2.json，再完成：${role.revision}\n逐个正式文件修订成 v002，至少列出旧值→新值→依据→受影响页/表/单元格；DOCX/XLSX/PPTX/PDF/CSV 按本角色已有格式同步修订并重新读取、重算、渲染，保留 v001。完成指定恢复演练与安全删除证据。\n按协议发布 v002 和以下交接消息：${role.handoffs.map(item => `${item.to}：${item.subject}`).join('；')}。需要接收：${role.inbound.join('；')}。收件人尚未完成时保留待 ACK 状态，不写假 ACK。${browser}` },
        { id: `OFFICE-${role.id}-COLLAB`, kind: 'collaboration', revision: 'v003', baseRevision: 'v002',
          prompt: `${context}\n第三轮协作收口：读取相关角色实际发布的 v002 manifest、消息和证据，校验哈希/版本与业务口径；不能只相信消息里的数字。先处理收件箱，在本人 messages 写真实 ACK/NACK，保留 correlationId。发现过期 baseRevision 或冲突时记录原版本/新版本/影响/owner，不覆盖他人文件。\n${role.id === 'pmo' ? '你是经营决策 owner：比较财务、人事、销售、运营与文控证据，解决活动提案与 30000 上限冲突；明确批准四项费用、保护人员及租赁、列取舍理由。发布 v003 decisions.json 和更新的评审材料，向五位角色发带来源版本及 ACK 要求的决议消息；未收到 ACK 时如实保留待确认。' : `依据 PMO 的真实已发布 v003 决议和本角色负责事实，更新本人 v003 全套正式材料并读回/重算/导出；尚无决议时先提交核验与异议消息并明确等待项，不能自行伪造批准。对收到并实际应用的决议写带 appliedArtifactReferences 的 ACK。${role.id === 'compliance' ? '逐件检查最终版本链、脱敏、格式/渲染证据、恢复/删除审计与 ACK；只有复验通过才关闭问题。' : ''}`}\n本轮最终交付 reconciliation.json（自身声明、所用对方版本、差异、处理、未完成项）及 evidence/final-verification.md。不得将未解决预算、未收到 ACK 或打不开的产物宣称完成。${browser}` }
      ] }
  })
  return {
    schemaVersion: 1, company: officeCompany, inputRoot, publishRoot, roles: plans,
    handoffContract: officeHandoffContract, acceptance: officeCompanyAcceptance,
    seedFiles: officeCompanySeedFiles,
    scheduling: {
      requiredWorkSessions: 6, independentBaselineSubmissions: 6, minimumRevisionSubmissions: 6,
      stages: [
        'Create six independent Work sessions and run all six BASE prompts concurrently.',
        'Verify six real v001 publications. Materialize revision-v2.json, then submit six REVISION prompts, including while other sessions are active to exercise independent queues.',
        'After all v002 publications settle, dispatch PMO COLLAB to review evidence and publish its v003 decision; the other five may independently inspect v002 messages without writing a decision.',
        'Dispatch the other five COLLAB prompts after the PMO decision is visible; collect their own-prefix ACKs and v003 outputs.',
        'Give PMO and compliance a final evidence-only receipt/closure follow-up to reconcile ACKs and unresolved items. If corrections are needed, publish v004 with the same immutable-version contract.'
      ],
      caution: 'A completed model turn is not artifact acceptance. Keep per-session terminal outcomes, tool/browser evidence, format readbacks and source/target file hashes. Do not cancel an active writer or clear its workspace to make a deadline appear successful.'
    }
  }
}
