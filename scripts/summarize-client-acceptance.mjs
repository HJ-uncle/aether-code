/** Summarize the exact Playwright JSON, retaining every file and every skip/failure. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv[2]) throw new Error('Playwright JSON result is required')
const input = resolve(root, process.argv[2])
const output = resolve(root, process.argv[3] ?? 'docs/test-reports/2026-10-09-client-full-acceptance.md')
const report = JSON.parse(readFileSync(input, 'utf8'))
const rows = [], details = []
function feature(file) {
 if (/^account/.test(file)) return '账号与认证'
 if (/^engine/.test(file)) return '引擎打包、安装与通信'
 if (/^browser/.test(file)) return '浏览器与网络调试'
 if (/^(model|composer|utility)/.test(file)) return '模型、输入配置与辅助操作'
 if (/^(mcp|skill|knowledge|memory|agent-resource)/.test(file)) return 'MCP、Skill、知识库与记忆'
 if (/^terminal/.test(file)) return '终端与粘贴、尺寸、Shell'
 if (/^git/.test(file)) return 'Git 与项目隔离'
 if (/^(editor|monaco|lsp|diagnostics)/.test(file)) return '编辑器、Monaco 与 LSP'
 if (/^subagent/.test(file)) return '子 Agent 生命周期与状态'
 if (/^command-job/.test(file)) return '命令任务与进程状态'
 if (/^(change|changes|file-change|edit-file)/.test(file)) return '文件改动、差异与撤回'
 if (/^(remote|workspace|attachment|preview-resource)/.test(file)) return '远端连接与项目、文件、上传同步'
 if (/^(root-run|approval|chat|history|streaming|thinking|anthropic|security|pending)/.test(file)) return '对话、历史、审批、恢复与安全'
 if (/^tool/.test(file)) return '工具反馈与开发操作'
 return '工作台、布局与综合功能'
}
function visit(suite, file, target) {
 for (const spec of suite.specs ?? []) {
   for (const test of spec.tests ?? []) {
     const last = test.results?.at(-1)
     const explicit = (test.annotations ?? []).find(x => x.type === 'skip' || x.type === 'fixme')
     const status = last?.status === 'passed' ? 'passed' :
       last?.status === 'skipped' ? (explicit ? 'skipped' : 'notRun') : 'failed'
     target[status]++
     target.total++
     if (/远端|远程|remote/i.test(spec.title)) target.remoteTitles++
     details.push({ file, title: spec.title, kind: target.kind, feature: target.feature,
       status, reason: explicit?.description, error: status === 'failed' ? last?.error?.message : undefined })
   }
 }
 for (const child of suite.suites ?? []) visit(child, file, target)
}
for (const suite of report.suites) {
 const file = suite.file.replace(/\\/g, '/').split('/').at(-1)
 const source = readFileSync(join(root, 'e2e', file), 'utf8')
 const kind = /electron\.launch\s*\(/.test(source) ? '真实 Electron UI' :
   /(?:createServer\s*\(|\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(|\bfetch\s*\()/.test(source) ?
   '本机进程、API 或文件集成' : '纯函数或文件契约'
 const row = { file, feature: feature(file), kind, total: 0, passed: 0, failed: 0, skipped: 0, notRun: 0, remoteTitles: 0 }
 visit(suite, file, row)
 rows.push(row)
}
const totals = { files: rows.length, total: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 }
for (const row of rows) for (const key of ['total', 'passed', 'failed', 'skipped', 'notRun']) totals[key] += row[key]
const aggregate = key => {
 const map = new Map()
 for (const row of rows) {
   const name = row[key]
   if (!map.has(name)) map.set(name, { name, files: 0, total: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 })
   const item = map.get(name); item.files++
   for (const stat of ['total', 'passed', 'failed', 'skipped', 'notRun']) item[stat] += row[stat]
 }
 return [...map.values()]
}
const md = [
 '# 客户端完整验收：2026-10-09', '',
 '以本轮 Playwright 原始 JSON 为准；workers 固定为 1，retries 为 0。',
 '', '**结果：' + totals.total + ' 项，' + totals.passed + ' 通过，' + totals.failed + ' 失败，' + totals.skipped + ' 显式跳过，' + totals.notRun + ' 未运行；' + totals.files + ' 个文件。**', '',
 '## 验收层次', '',
 '| 类型 | 文件 | 用例 | 通过 | 失败 | 跳过 | 未运行 |',
 '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
 ...aggregate('kind').map(x => '| ' + [x.name,x.files,x.total,x.passed,x.failed,x.skipped,x.notRun].join(' | ') + ' |'), '',
 '类型按测试文件的实际 electron.launch、本机进程/API 启动入口分类。同一文件的纯函数辅助断言计入该文件，不能将全部自动化用例称为全部真实 UI 测试。', '',
 '真实 Electron 用例运行编译后的 out，经过 Chromium、preload 与 IPC。真实引擎对话用例采用本地可控制的模型 Provider，因此能严格验证工具和协议副作用；外部模型质量、长期可用性由本轮正式五会话真实模型开发另外验证。部分远端 UI 用例的 HTTP 服务是受控夹具，不能据此宣称互联网跨机器链路已完成；真实 12499 引擎与两个保留项目的客户端联动结果另有记录。', '',
 '## 功能分类', '',
 '| 功能 | 文件 | 用例 | 通过 | 失败 | 跳过 | 未运行 |',
 '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
 ...aggregate('feature').map(x => '| ' + [x.name,x.files,x.total,x.passed,x.failed,x.skipped,x.notRun].join(' | ') + ' |'), '',
 '## 全部文件清单', '',
 '| 文件 | 层次 | 用例 | 通过 | 失败 | 跳过 | 未运行 | 标题含远端/remote |',
 '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
 ...rows.map(x => '| ' + [x.file,x.kind,x.total,x.passed,x.failed,x.skipped,x.notRun,x.remoteTitles].join(' | ') + ' |'), '',
 '“标题含远端/remote”仅辅助定位，不能表示这些文件中的全部用例都是远端操作。', '',
 '## 历史失败与修复', '',
 '初轮 755 项：731 通过、8 失败、3 显式跳过、13 serial 未运行，原始日志、JSON 和 trace 均保留。', '',
 '- 产品缺陷：123456 token 被转换成 123.456K，保存校验只接受整数 K，导致改名或编辑开关也被阻止。现支持最多三位小数 K，精确回转整数 token，统一表单与保存校验；保护原密钥和隐藏能力。新增 token 精度、非法输入、最大安全整数及真实表单编辑回归。',
 '- 浏览器原生截图：desktopCapturer await 跨越 React/native 布局更新，旧 bounds 的采样点落到新网络面板。现仅采样 bounds 稳定帧并等待实际像素绘制，原六采样点和最大色差 4 的断言保留。',
 '- 子 Agent 夹具：辅助记忆检索先到，其请求只有 user 消息、无工具；旧选择器误选它。现选择实际带 system 的 Agent 请求；此 code profile 专项夹具显式关闭记忆，其他记忆功能及默认会话记忆保持实测。中间失败仍保留。',
 '- 根运行初轮 beforeAll 曾启动异常，原始证据保留。最终同步版本重点复跑未复现；新增公开 engine snapshot 诊断以便后续失败准确定位，不能把原因无证据归到某次修复。',
 '- 诊断 reporter 将 serial 因前例失败而未执行误归环境 skip；现显式 skip 与未运行分开报告。',
 '',
 '## 原始证据', '',
 '[最终 Playwright JSON](' + input.replace(/\\/g, '/') + ')', '',
 '[逐条机器清单](' + output.replace(/\.md$/, '.json').replace(/\\/g, '/') + ')', '',
 '构建、Runtime identity 和正式五会话模型/项目/资源指标以总报告及 runtime/longrun 原始证据为准。', ''
]
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, md.join('\n'))
writeFileSync(output.replace(/\.md$/, '.json'), JSON.stringify({ totals, rows, details, input }, null, 2))
console.log(JSON.stringify({ output, totals, kinds: aggregate('kind') }))

