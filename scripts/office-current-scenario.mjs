/** A fresh, synthetic office workload. Pure data: the runner owns files and sessions. */
import path from 'node:path'

const json = value => `${JSON.stringify(value, null, 2)}\n`
const csv = rows => `${rows.map(row => row.map(value => {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}).join(',')).join('\n')}\n`

const companyName = '澄川数策（完全虚构）'
const period = '2026-11'

// The runner must intersect this with the live catalog for parent and child.
// Prompt instructions alone are not a tool authorization boundary.
export const builtinOfficeToolPolicy = Object.freeze({
  mode: 'aether-native-only',
  allowedTools: [
    'read_file', 'write_file', 'edit_file', 'list_files', 'delete_file', 'create_dir',
    'list_skills', 'get_skill', 'calculate', 'get_time', 'office_document', 'office_inspect',
    'plan_update', 'todo_list', 'todo_create', 'todo_update', 'todo_delete',
    'subagent', 'subagent_start', 'subagent_send', 'subagent_wait', 'subagent_cancel', 'subagent_participants', 'subagent_inbox',
    'browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
    'browser_click', 'browser_scroll', 'browser_press_key', 'browser_wait', 'browser_close',
  ],
  requiredTools: ['read_file', 'write_file', 'list_files', 'delete_file', 'office_document', 'office_inspect', 'get_skill', 'subagent', 'browser_open', 'browser_snapshot'],
  forbiddenTools: ['execute_cmd', 'run_command', 'run_terminal_command', 'terminal_exec', 'install_package', 'run_skill_script', 'http_request', 'web_fetch', 'office_environment'],
  forbiddenRuntimePaths: ['WPS', 'Office COM', 'LibreOffice', 'Python', 'shell', 'Node scripts', 'external browser', 'HTTP server', 'MCP/remote office conversion'],
  officeOperations: ['create', 'inspect', 'edit', 'append_sheets', 'recalculate'],
  disclosure: 'Native engine/client capabilities only. Inspection is bounded extraction, not visual review. PDF revision is version reconstruction, not arbitrary PDF editing.',
})

const definitions = [
  {
    id: 'operations', name: '运营总监 · 林澄',
    expertise: '经营节奏、资源统筹、供应商预算、风险登记与跨部门交付；能把事实转成负责人、日期和可验收动作。',
    files: ['operations-plan.xlsx', 'operating-brief.docx'],
    assignment: '为十一月经营例会准备可执行运营方案。XLSX 至少含费用预算、交付里程碑、风险行动三张表；费用表逐项引用 expense_id，金额列是数值，合计使用公式。DOCX 为 2—3 页经营简报，包含三个客户项目、里程碑负责人、预算结构、上线前依赖和三个具体风险及触发条件。不得把应收账款写成已到账资金。依据 milestones.csv 给出日期，不编造客户批准。summary.json 指标需包含 expenseTotal、launchDate、milestoneCount。',
    revise: '按修订输入下调云资源费用，重排 C103 上线及培训日期；保留其他费用与责任人。读取财务和人事 v1 的汇总，把预算变化与人员保障写入 v2 简报；明确人事 v1 尚未包括本次新增人员，不照抄旧总额。',
    reads: ['finance', 'people'],
    v1: { expenseTotal: 45000, launchDate: '2026-11-20', milestoneCount: 4 },
    v2: { expenseTotal: 42000, launchDate: '2026-11-25', milestoneCount: 4 }
  },
  {
    id: 'finance', name: '财务总监 · 许衡',
    expertise: '权责发生制、应收对账、滚动现金预测、Excel 公式与管理报告；严格区分签约、收入、开票和回款。',
    files: ['finance-model.xlsx', 'finance-memo.pdf'],
    assignment: '编制十一月资金与收入分析。XLSX 至少含合同收入、应收明细、人员成本、现金预测四张表；金额为数值，使用可读公式且提供计算后读回值，保留合同/员工 ID。PDF 为 2 页管理层备忘录，解释收入与回款口径、月底现金预测及三项风险。期初现金取 company.json；预计收款只取本月到期未收余额；费用和雇主成本按输入约定直接作现金支出。summary.json 指标含 monthlyRevenue、receivableBalance、grossPayroll、employerCost、expenseTotal、forecastClosingCash。不得声称已付款、已开真实发票或正式税务意见。',
    revise: '重算 C103 缩减后月收入和含税应收、半月入职工资、云费用及现金预测。读取销售和人事 v1 汇总，在 v2 逐条说明其旧口径与本次修订的差额；C103 已收款不变，不可再次全额收款。',
    reads: ['sales', 'people'],
    v1: { monthlyRevenue: 50000, receivableBalance: 143100, grossPayroll: 120000, employerCost: 134400, expenseTotal: 45000, forecastClosingCash: 263700 },
    v2: { monthlyRevenue: 45000, receivableBalance: 127200, grossPayroll: 129000, employerCost: 144480, expenseTotal: 42000, forecastClosingCash: 240720 }
  },
  {
    id: 'people', name: '人事总监 · 周知',
    expertise: '组织发展、岗位能力、入职运营、人员预算和隐私分级；能形成可执行人员计划与规范手册。',
    files: ['workforce.xlsx', 'onboarding-guide.docx'],
    assignment: '制作十一月人员盘点与入职执行包。XLSX 分人员清单、工资计算、岗位覆盖三张表，使用 employee_id，工资与雇主附加成本分别列出，按日历日含入职日计薪。DOCX 为 2—3 页入职与岗位协作手册，按第一天/第一周/首月列责任人、交接物和验收条件，写清虚构公司的资料分级与访问申请流程。初始没有新入职者，应明确现有 6 人和常设流程，不能凭空招聘。summary.json 指标含 headcount、grossPayroll、employerCost、newStarterDate（初始为 null）。个人明细只放本部门工作簿，面向跨部门的摘要仅汇总。',
    revise: '新增已批准的 E007 客户成功专员，2026-11-16 入职，十一月仅计 15/30 天工资。更新人员表和手册的真实入职日程；读取运营 v1 的上线安排，明确其旧日期已由权威修订更新，给出支持 2026-11-25 上线的培训安排。',
    reads: ['operations'],
    v1: { headcount: 6, grossPayroll: 120000, employerCost: 134400, newStarterDate: null },
    v2: { headcount: 7, grossPayroll: 129000, employerCost: 144480, newStarterDate: '2026-11-16' }
  },
  {
    id: 'sales', name: '销售总监 · 沈言',
    expertise: 'B2B 客户经营、销售预测、商机分层、合同范围与回款协同；不将概率预测包装成已实现业绩。',
    files: ['commercial-review.pptx', 'account-actions.csv'],
    assignment: '准备 6 页经营评审演示文稿：业务范围、已签合同、应收与日期、概率加权商机、客户行动、决策请求。PPTX 必须有清晰标题、数据表或图和可读脚注，不能只是大段文本。CSV 每行一个合同/商机行动，含 entity_id、customer、owner、next_action、due_date、net_amount、probability、weighted_amount、status，正确引用输入 ID；合同和商机类型分别标明，不能混加。summary.json 指标含 signedNetTotal、weightedPipeline、receivableBalance、c103DueDate。所有客户沟通仅为内部草稿，不实际发信。',
    revise: '应用 C103 合同缩减和到期日变化、O203 概率上调，更新演示文稿与行动 CSV。读取法务和产品 v1 汇总，列出范围变更待确认事项及最新版上线日期；写明旧材料依赖已过期，不能承诺旧上线日。',
    reads: ['legal', 'product'],
    v1: { signedNetTotal: 270000, weightedPipeline: 280000, receivableBalance: 143100, c103DueDate: '2026-11-25' },
    v2: { signedNetTotal: 255000, weightedPipeline: 290000, receivableBalance: 127200, c103DueDate: '2026-11-28' }
  },
  {
    id: 'product', name: '产品总监 · 顾远',
    expertise: '需求取舍、可访问性、版本计划、验收标准和产品叙事；把需求关联到客户价值与容量约束。',
    files: ['release-requirements.docx', 'release-review.pptx'],
    assignment: '为企业服务产品十一月版本输出需求规格和评审材料。DOCX 为 3—4 页，逐项覆盖 features.csv 的需求 ID、问题、用户流程、至少 2 条可检查验收条件、依赖及不做事项；所有数据来自输入，不能让模型去开发平台代码。PPTX 5 页，展示目标、三项功能、20 人日容量分配、上线里程碑、风险与待决事项；不要只列空泛口号。summary.json 指标含 featureCount、plannedPersonDays、capacityPersonDays、remainingPersonDays、launchDate。表述是规划草案，不能冒称功能已上线或测试已通过。',
    revise: '加入已批准的 F104 键盘可访问性需求 3 人日，保持容量 20 人日并计算余量；上线改至 2026-11-25。读取运营与销售 v1 汇总，明确客户承诺需同步修订，给出具体交接清单；不要削减旧需求以虚构充足容量。',
    reads: ['operations', 'sales'],
    v1: { featureCount: 3, plannedPersonDays: 16, capacityPersonDays: 20, remainingPersonDays: 4, launchDate: '2026-11-20' },
    v2: { featureCount: 4, plannedPersonDays: 19, capacityPersonDays: 20, remainingPersonDays: 1, launchDate: '2026-11-25' }
  },
  {
    id: 'legal', name: '法务文控总监 · 苏谨',
    expertise: '合同审阅、风险分级、文档版本管理、敏感资料脱敏和证据追踪；区分事实、假设与待批准条款。',
    files: ['contract-review.pdf', 'document-register.txt'],
    assignment: '对三份合成合同形成 2—3 页 PDF 内部审阅意见：逐合同列金额/税额口径、服务期、应收、范围与日期，提出有事实依据的风险和补充条款建议。TXT 为 UTF-8 制表符分隔的文控登记册，含 document_id、owner_role、title、classification、expected_version；逐项登记 document-register.csv 的 12 份计划文档，状态写 planned，不能把未生成文件标为已验收。summary.json 指标含 contractCount、signedNetTotal、signedGrossTotal、registeredDocumentCount、c103DueDate。所有意见是合成业务草案，不代替法律意见或签字。',
    revise: '为 C103 金额缩减生成明确的范围变更审阅与含税调整数额，更新回款到期日，登记版本为 v2 并保留 v1。读取财务和销售 v1 汇总，标记其中 C103 金额已过期；列出未签署/未开票的执行边界，不伪造审批。',
    reads: ['finance', 'sales'],
    v1: { contractCount: 3, signedNetTotal: 270000, signedGrossTotal: 286200, registeredDocumentCount: 12, c103DueDate: '2026-11-25' },
    v2: { contractCount: 3, signedNetTotal: 255000, signedGrossTotal: 270300, registeredDocumentCount: 12, c103DueDate: '2026-11-28', c103GrossReduction: 15900 }
  }
]

function nativeRequirements(role, version) {
  const scratch = `departments/${role.id}/scratch/${version}`
  const format = ({ operations: 'xlsx', finance: 'xlsx', people: 'docx', sales: 'pptx', product: 'docx', legal: 'pdf' })[role.id]
  const crud = format === 'pdf'
    ? `PDF无任意edit：用office_document.create在${scratch}/crud-original.pdf原生创建含CRUD-INITIAL的短文并inspect；再原生创建${scratch}/crud-revised.pdf，将同一字段改为CRUD-VERIFIED后inspect。这是版本重建式更新，crud.json必须写updateSemantics="version-rebuild"、originalEditSupported=false，不是原文件编辑。最后delete_file分别删除这两份scratch文件，list_files确认原路径不存在。`
    : `在${scratch}/crud-probe.${format}用office_document.create原生创建最小文档，含唯一字段CRUD-INITIAL，然后inspect。用office_document.edit把该字段改为CRUD-VERIFIED：DOCX/PPTX使用唯一oldText/newText，XLSX使用准确sheet/cell/value；只用刚读到的同文件expectedHash。再inspect确认新字段真实存在，最后delete_file删除这一个scratch文件并list_files确认原路径不存在。${format === 'xlsx' ? '同一scratch工作簿另设A2=10、B2={formula:"A2*2"}，先recalculate和inspect得到20；edit A2为15后再recalculate和inspect得到30，证明输入改动带动依赖。运营角色额外用append_sheets追加一个新测试表，inspect确认旧表仍在。不要猜测append_sheet或append_rows operation。' : ''}`
  return `【严格限制：全部能力由Aether内置完成】
只调用平台原生工具，父任务和子代理同样受限。禁止WPS、Office/COM、LibreOffice、Python、PowerShell/CMD/shell、Node/JS执行脚本、外部办公应用或浏览器、安装依赖、启动本地服务、HTTP/远程转换服务。禁止execute_cmd/run_command/install_package/run_skill_script/http_request/web_fetch/office_environment及同类绕行。不得写待执行程序、宏、base64二进制或把脚本塞进其他工具。即使skill建议旧外部办法，也以本委托限制为准，记录缺口而非绕过。
可先get_skill阅读aether-office。DOCX/XLSX/PPTX/PDF只能由office_document原生create/inspect/edit/append_sheets/recalculate生成和操作，只读复核优先office_inspect。DOCX/PDF create用markdown；PPTX create用presentation.slides（title、bullets、table、notes）；XLSX create用workbook.sheets。create的expectedHash="missing"，edit/append_sheets/recalculate必须复用同文件最新回执sha256；冲突先重新inspect，不删除正式文件规避冲突。
XLSX写入或修订公式后必须原生recalculate，再inspect核缓存和错误。采用当前支持的常见算术、跨表引用、SUM/COUNT/COUNTA/ROUND/IF；日期用输入ISO文本并直接引用，不假定DATE/TEXT或任意Excel函数都支持。employerCost=应计工资+雇主附加费，附加费另列，不能冒充总成本。不支持/循环引用如实记录；不得手写缓存或换成无关固定答案制造通过。
PPTX用短标题、简短要点、可读表格：最多6列，含要点时最多5行和2条要点，否则最多8行；不要把长文压成小字。PDF由Aether独立排版，不是假称从Word/PPT导出。PDF修订必须根据源内容在新版本路径create并保留旧文件。
${crud}
把实际create→inspect→edit或version-rebuild→inspect→delete步骤及XLSX重算/追加记录在${version}/crud.json：exactPath、operation、原生回执hash、真实值、原始错误、updateSemantics、deletedFromOriginalPath。只删除自己的scratch文件，不复制正式二进制、不删除正式成果或输入；回收站删除只表示原路径不存在，不称永久删除。未知hash填null并写missingEvidence，不能伪造。
CSV/TXT/JSON/Markdown与静态overview.html使用write_file/edit_file；不可用它们制造二进制Office文件。HTML无脚本、外部资源或网络请求，只展示真实摘要和两份核心文件的相对链接。
浏览器只用Aether browser_tabs/browser_open/browser_snapshot/browser_screenshot。先列出本会话标签并使用真实tabId；打开自己本轮overview.html的绝对路径或file URL（仅当原生工具支持）。一次明确拒绝后记录${version}/browser-evidence.json与blockers.md，继续其他工作；不启HTTP服务、不外部打开、不复制其他会话标签。仅看到HTML不证明Office链接已打开，文档预览另记。只有真实看到页面/幻灯片才称视觉检查；若当前内置工具不能呈现某格式，写visualReview.status="not-verified"并说明缺口，文本inspect不能冒充排版验收。`
}

function reviewRequirements(root, role, version) {
  return `调用恰好一名独立审阅子代理；${version === 'v2' ? '优先用上一轮已完成的真实resumeRunId续审，不可并发续跑；确实不可恢复才新建一名并记录原因。' : '使用subagent或subagent_start，等待真实终态，启动回执不代表完成。'}设置access="read-only"，完整传入公司根${root}、本部门${version}原格式文件、输入和至少两个关键核验指标，并明确继承上述内置工具限制。子代理只能使用office_inspect/read_file/calculate等原生只读能力，不编辑产物、不运行脚本、不创建浏览器页、不改其他部门。它必须独立读原文件并返回定位、实际数值/日期、复算过程、差异和未验证项，不只审summary.json。父任务将子代理真实返回原文写入departments/${role.id}/audit/${version}-review.md，标题记录真实childSessionId、runId、终态和读到的文件版本；不可冒称子代理亲自写文件。根据有证据的意见修正后，用同一子代理续审最终文件；无法完成则保留未完成结论，父任务自检不能替代独立审阅。`
}

function baseInstructions(root, role) {
  const workbook = role.files.find(file => file.endsWith('.xlsx'))
  const workbookContract = workbook
    ? `工作簿${workbook}增加“经营摘要”表，A1/B1为指标/值，第2行起A列依次是${Object.keys(role.v1).join('、')}，B列引用业务表实际计算值或公式（日期用ISO文本，空日期留空）。不要硬填与明细无关的数字。每次完整创建/修订后先原生recalculate再inspect。`
    : ''
  return `你是${companyName}的${role.name}。专业能力：${role.expertise}
这是真实执行的内部办公委托，客户、员工及商业数据均为合成数据。公司目录是${root}。六位总监同时工作：只写${path.join(root, 'departments', role.id)}；inputs和其他部门只读，禁止改平台代码、他人文件、共享配置或已有正式版本。不得联系真人、付款、签约或外部发布。
先读取inputs/v1/company.json和本部门CSV，核对币种、月份和含税口径。只读本轮公司材料，不访问此前测试目录、不借用旧成果。先给简短计划再真实完成工作，不停在建议。
${nativeRequirements(role, 'v1')}
初始产物放departments/${role.id}/v1，两个核心文件命名为${role.files.join('、')}。${role.assignment}${workbookContract}
写summary.json：{role:"${role.id}",version:"v1",period:"${period}",currency:"CNY",metrics:{上述指标},sources:[输入相对路径],assumptions:[],openIssues:[]}。role必须为稳定ID ${role.id}，姓名另列；正式文件要能独立读出相同数字。所有成果注明“合成数据演练”、版本、业务日期和来源，金额按明细四舍五入到分。无依据值保留待确认。
每个Office原件重新office_inspect；分页用同文件contentPage.nextOffset与expectedHash读到关键表格/指标，不把第一页当全文。v1/verification.json逐文件记录路径、原生回执字节数/SHA、operation、可见的工具调用ID、实际核心值、错误/重算结果和visualReview状态；工具未提供字段填null并注明缺口，不用脚本计算。summary不是唯一验收证据。
${reviewRequirements(root, role, 'v1')}
任何能力缺失、失败或文件打不开，立刻在本部门blockers.md记录时间、操作、原始错误、影响和复现步骤，只能在上述原生范围内尝试。缺项保留未通过并继续其他独立工作，不能把外部绕行或结构检查称为成功。最终报告真实路径、业务数字、原生工具证据、子代理、CRUD/浏览器和遗留问题。`
}

function revisionInstructions(root, role) {
  return `继续担任${role.name}，仍只写${path.join(root, 'departments', role.id)}。用原生读取工具读inputs/v2/revision.json及自己的v1原件和summary.json。此轮不覆盖v1；核心文件名相同，新成果放本部门v2，用office_document.create根据读回事实和修订内容原生重建，不能复制二进制或外部转换。${role.revise}
${nativeRequirements(role, 'v2')}
只读交接：逐个读取${role.reads.map(id => `departments/${id}/v1/summary.json`).join('、')}，并读取每个来源部门至少一个原格式文件。v1是历史事实，新决议以revision.json为准。不得等待他人v2或修改他人文件；缺文件记录blocked，不伪造收到。
生成v2/ack.json：{role:"${role.id}",revision:"CC-2026-11-02",received:[{fromRole,path,sha256,observedVersion:"v1",decision:"accepted"或"needs-update"或"blocked",factsUsed:[],differences:[],missingEvidence:[]}],appliedChanges:[],openIssues:[]}。SHA只引用同文件原生回执，工具未提供则null并注明待补证，禁止编造或shell计算。给出实际事实与差异，不默认全部accepted。跨部门独立根通过版本化文件交接，不能声称subagent_send已向另一独立根成功投递。
完成v2两个核心文件、summary.json、verification.json、crud.json、overview.html、browser-evidence.json；沿用v1证据要求。summary.role仍为"${role.id}"、version为"v2"，sources包含修订与真实交接文件。数字/日期须同时更新原格式文件和摘要，不能只改JSON。工作簿经营摘要行序保持v1，写完后原生recalculate与inspect；employerCost仍指工资加附加费的总成本。工资细目只留人事/财务原件，交接摘要仅汇总。
${reviewRequirements(root, role, 'v2')}
失败追加blockers.md，继续不受影响工作。v1保留原字节；PDF新版本重建不等于任意PDF编辑。最终报告v1→v2差异、原件、ACK、原生工具证据和未解决阻塞。`
}

/**
 * @param {string} root Absolute company workspace directory.
 * @returns {{companyName:string,seedFiles:Array<{path:string,content:string,phase:string}>,revisionFiles:Array<{path:string,content:string,phase:string}>,roles:Array<object>}}
 * All paths are relative to root. Materialize revisionFiles only at round two.
 * roles.oracle is for independent verification; do not seed it into model inputs.
 */
export function createScenario(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('createScenario requires an absolute companyRoot')
  const seedFiles = []
  const seed = (name, content, phase = 'base') => seedFiles.push({ path: name, content, phase })
  seed('inputs/v1/company.json', json({
    companyName, fictional: true, period, currency: 'CNY', timezone: 'Asia/Shanghai',
    business: '向虚构企业交付流程管理软件与上线服务。此次仅制作内部业务草案。',
    openingCash: 300000, openingCashDate: '2026-11-01', employerCostRate: 0.12,
    productCapacityPersonDays: 20, plannedLaunchDate: '2026-11-20',
    rules: [
      '全部合同 2026-11-01 开始服务，合同净额按服务月数均匀确认；税率统一为合成条件 6%。',
      '应收=合同含税额减已收款。仅当月到期未收余额进入预计收款；商机不作为收入或确定现金。',
      '月薪按十一月 30 个日历日计薪，入职当日计入；雇主附加成本为应计工资的 12%，不计算真实个税。',
      '费用与雇主总成本直接作为当月预计现金支出，不另加税、不建模税款结缴。现金预测不是法定现金流量表。',
      '金额按明细四舍五入到分后合计；展示个人明细时限内部人事/财务文件，跨部门摘要只列汇总。',
      'v1 输入不可修改，修订以第二轮 inputs/v2/revision.json 为准；正式产物不可覆盖旧版本。'
    ]
  }))
  seed('inputs/v1/contracts.csv', csv([
    ['contract_id', 'customer', 'owner', 'net_amount', 'vat_rate', 'service_start', 'service_months', 'gross_received', 'remaining_due_date'],
    ['C101', '松柏仪器（虚构）', '沈言', 120000, 0.06, '2026-11-01', 12, 63600, '2026-11-15'],
    ['C102', '云杉物流（虚构）', '林澄', 60000, 0.06, '2026-11-01', 6, 31800, '2026-11-20'],
    ['C103', '清河工坊（虚构）', '沈言', 90000, 0.06, '2026-11-01', 3, 47700, '2026-11-25']
  ]))
  seed('inputs/v1/employees.csv', csv([
    ['employee_id', 'name', 'department', 'monthly_gross', 'start_date'],
    ['E001', '合成员工甲', '财务', 18000, '2026-01-01'],
    ['E002', '合成员工乙', '人事', 16000, '2026-01-01'],
    ['E003', '合成员工丙', '销售', 22000, '2026-01-01'],
    ['E004', '合成员工丁', '研发', 26000, '2026-01-01'],
    ['E005', '合成员工戊', '研发', 24000, '2026-01-01'],
    ['E006', '合成员工己', '运营', 14000, '2026-01-01']
  ]))
  seed('inputs/v1/expenses.csv', csv([
    ['expense_id', 'category', 'november_budget', 'owner_role'],
    ['B101', '办公租赁', 12000, 'operations'], ['B102', '云资源', 18000, 'operations'],
    ['B103', '客户活动', 9000, 'sales'], ['B104', '协作软件', 6000, 'operations']
  ]))
  seed('inputs/v1/pipeline.csv', csv([
    ['opportunity_id', 'customer', 'owner', 'net_amount', 'probability', 'expected_sign_date', 'stage'],
    ['O201', '望山制造（虚构）', '沈言', 200000, 0.6, '2026-11-18', 'proposal'],
    ['O202', '长川商贸（虚构）', '沈言', 160000, 0.5, '2026-11-23', 'evaluation'],
    ['O203', '栖木零售（虚构）', '沈言', 100000, 0.8, '2026-11-27', 'negotiation']
  ]))
  seed('inputs/v1/milestones.csv', csv([
    ['milestone_id', 'contract_id', 'title', 'owner_role', 'due_date', 'dependency'],
    ['M101', 'C101', '实施范围确认', 'sales', '2026-11-06', ''],
    ['M102', 'C102', '管理员培训', 'operations', '2026-11-12', ''],
    ['M103', 'C103', '上线验收', 'product', '2026-11-20', 'M101'],
    ['M104', 'C103', '客户使用培训', 'operations', '2026-11-21', 'M103']
  ]))
  seed('inputs/v1/features.csv', csv([
    ['feature_id', 'title', 'customer_problem', 'person_days', 'priority'],
    ['F101', '审批轨迹导出', '审计员需要按日期核对审批人和处理结果', 5, 'must'],
    ['F102', '部门权限模板', '管理员需要防止跨部门查看工资附件', 8, 'must'],
    ['F103', '批量导入结果提示', '运营需要定位失败行并只重试失败记录', 3, 'should']
  ]))
  seed('inputs/v1/document-register.csv', csv([
    ['document_id', 'owner_role', 'title', 'classification', 'expected_version'],
    ...definitions.flatMap((role, index) => role.files.map((name, fileIndex) => [
      `D${String(index * 2 + fileIndex + 1).padStart(3, '0')}`, role.id, name,
      role.id === 'people' || role.id === 'finance' ? 'internal-restricted' : 'internal', 'v1'
    ]))
  ]))
  seed('inputs/v2/revision.json', json({
    revision: 'CC-2026-11-02', baseVersion: 'v1', effectiveDate: '2026-11-01', approved: true,
    changes: [
      { id: 'R01', subject: 'C103', field: 'net_amount', before: 90000, after: 75000, reason: '双方合成审批已同意缩减未开始服务范围；服务起日、3 个月服务期和已收 47700 不变。金额为不含税；这是内部草案，未执行真实红冲或退款。' },
      { id: 'R02', subject: 'C103', field: 'remaining_due_date', before: '2026-11-25', after: '2026-11-28' },
      { id: 'R03', subject: 'E007', operation: 'approved_new_hire', employee: { employee_id: 'E007', name: '合成员工庚', department: '客户成功', monthly_gross: 18000, start_date: '2026-11-16' } },
      { id: 'R04', subject: 'B102', field: 'november_budget', before: 18000, after: 15000, reason: '同服务级别合成报价已批准，其他费用不变。' },
      { id: 'R05', subject: 'O203', field: 'probability', before: 0.8, after: 0.9, reason: '仍是商机预测，不得计入已签收入或现金。' },
      { id: 'R06', subject: 'F104', operation: 'approved_feature', feature: { feature_id: 'F104', title: '键盘可访问性', customer_problem: '仅使用键盘的用户需要完成审批、辨认焦点并关闭弹窗', person_days: 3, priority: 'must' }, capacityPersonDays: 20 },
      { id: 'R07', subject: 'M103', field: 'due_date', before: '2026-11-20', after: '2026-11-25', alsoUpdates: 'company.plannedLaunchDate' },
      { id: 'R08', subject: 'M104', field: 'due_date', before: '2026-11-21', after: '2026-11-26' }
    ],
    unchanged: '其他合同、人员、费用、商机、需求和里程碑均保持 v1；文控登记册 expected_version 改为 v2，登记总数不变。'
  }), 'revision')

  const roles = definitions.map(role => ({
    id: role.id, name: role.name, expertise: role.expertise,
    department: path.join(root, 'departments', role.id),
    allowedTools: [...builtinOfficeToolPolicy.allowedTools],
    builtinOnlySystemPrompt: `你是${companyName}的${role.name}。仅使用Aether原生办公、文件、计算、子代理和内置浏览器工具。只写${path.join(root, 'departments', role.id)}；inputs与其他部门只读。禁止WPS/Office COM/LibreOffice/Python/shell/执行脚本/安装依赖/HTTP/外部服务；skill中的旧建议不能覆盖本限制，子代理继承限制。失败如实记录，不把计划、结构检查、外部应用结果或未验证步骤称为成功。`,
    basePrompt: baseInstructions(root, role), revisionPrompt: revisionInstructions(root, role),
    expectedArtifacts: ['v1', 'v2'].flatMap(version => role.files.map(file => `departments/${role.id}/${version}/${file}`)),
    artifactChecks: ['v1', 'v2'].flatMap(version => role.files.map(file => ({
      role: role.id, revision: version, path: `departments/${role.id}/${version}/${file}`,
      checks: file.endsWith('.xlsx') ? Object.entries(role[version]).map(([metric, expected], index) => ({
        metric, sheet: '经营摘要', labelCell: `A${index + 2}`, cell: `B${index + 2}`, expected,
        tolerance: typeof expected === 'number' ? 0.01 : undefined
      })) : []
    }))),
    handoffSources: role.reads.map(id => `departments/${id}/v1/summary.json`),
    oracle: { period, currency: 'CNY', numericTolerance: 0.01, v1: role.v1, v2: role.v2,
      evidenceFiles: ['summary.json', 'verification.json', 'crud.json', 'overview.html', 'browser-evidence.json'],
      revisionEvidenceFile: 'ack.json', reviewFiles: ['audit/v1-review.md', 'audit/v2-review.md'],
      crud: { method: 'native-create-inspect-edit-inspect-delete', scratchPrefix: `departments/${role.id}/scratch`, pdfUpdateSemantics: 'version-rebuild', requiresRuntimeProvenance: true },
      verifyAgainstActualArtifacts: true }
  }))
  return {
    companyName,
    scenarioVersion: 'aether-native-only-v2',
    toolPolicy: { ...builtinOfficeToolPolicy, allowedTools: [...builtinOfficeToolPolicy.allowedTools], forbiddenTools: [...builtinOfficeToolPolicy.forbiddenTools] },
    seedFiles: seedFiles.filter(file => file.phase === 'base'),
    revisionFiles: seedFiles.filter(file => file.phase === 'revision'),
    roles
  }
}
