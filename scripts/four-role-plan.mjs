/** Acceptance prompts only: no implementation, expected outputs, or model replies. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const additions = [
  { id: 'R1', title: '完整终局', text: '增加停一手、连续双方停一手结束、认输；结束后禁止落子。按中国数子法面积计分（棋子+仅被单色围住的空点，双方相邻为空区不计），白贴6.5目，明确显示计算方法和限制；重开清除终局和计分。' },
  { id: 'R2', title: '可靠悔棋和重做', text: '增加撤销/重做，落子、提子、停一手、劫限制、执棋、终局都须一并恢复；撤销后走新分支清空重做。按钮禁用状态准确；至少覆盖提子后撤销与重做、双停终局撤销。' },
  { id: 'R3', title: '刷新恢复', text: '使用带版本号的本地存档，刷新后恢复棋盘、历史和当前执棋；损坏或不兼容存档提示后安全恢复，不能白屏；新开一局明确清除旧存档。数据仅在本地，文案不能承诺云同步。' },
  { id: 'R4', title: '棋谱与复盘', text: '支持JSON棋谱导出、通过可粘贴文本框导入与逐步复盘（初始局面/上一手/下一手/末手）。导入逐步验证合法性，非法棋谱不能部分覆盖当前对局；复盘只读，退出回到当前实战局面。不得假称支持SGF。' },
  { id: 'R5', title: '移动端与无障碍收尾', text: '完善360/390/768像素宽度与桌面布局，无横向溢出；移动触摸先预选，再确认落子，减少误触；键盘方向键移动棋盘焦点、Enter落子，焦点可见且读屏能知道坐标/颜色。按钮不依赖hover，触摸目标足够清楚；回归R1-R4后更新README和变更日志。' },
]

export function makePrompts(workspace) {
  const common = `这是获准直接执行的真实四角色协作验收，项目“弈舟”，工作区 ${workspace}。中文产物与简洁苹果风格界面。产品/运营/开发/测试分别是独立会话，通过此目录的真实交接文件协作，监督者会转发进度。保留其他角色改动，仅写自己负责的目录。任务做到当前验收完成后总结，不循环等待其他角色、不空转、不编造完成证据。需要其他角色修正时写入交接文件。资料和运行依赖从当前产品真实工具发现；不要借用其他项目、Codex私有依赖或修改全局环境。不要访问数据库/凭据。\n`
  const base = '目标：可运行的9路本地双人围棋Web，兼容H5。正确轮流落子、棋块与气、提子、禁止自杀、简单劫（禁止立即回提）、重开，重复点/越界拒绝；这是围棋，不是五子棋。无需账号、远程服务器或联网对战。后面会追加五项需求，暂不预先扩展。'
  return {
    product: common + `你是产品负责人，负责 product/ 和 handoff/product.md。${base}\n先写 handoff/product.md：产品范围、可测规则、初版验收标准、给开发/测试的决策。随后真实生成 product/产品需求.docx、product/项目计划.xlsx、product/产品评审.pptx、product/使用说明.pdf 四种原生办公格式，内容分别侧重PRD、里程碑/分工、评审说明、用户操作。每份至少有实质内容，文档相互一致；表格包含有意义的公式并实际重算。将未实现项标成计划，不能称已验收。最后检查每个文件，给出真实路径和检查结果；创建/检查/显示优先使用本产品办公生态。不要修改app/和operations/。`,
    operations: common + `你是运营负责人，负责 operations/ 和 handoff/operations.md。${base}\n制定正式上市运营准备：operations/运营计划.docx（目标人群、渠道、分阶段行动和风险）、operations/运营预算.xlsx（模拟预算、转化漏斗、公式与汇总，明确是假设而非真实业绩）、operations/发布宣讲.pptx（6页以内）、operations/常见问题.pdf（玩法/隐私/本地存档现状和反馈流程）。四种原生格式都需真实生成并检查；公式实际重算，不能仅填缓存。参考product/和handoff/product.md若已存在；不存在先按本任务的基线生成且标明待产品确认，不空转等待。把发布检查清单写到handoff/operations.md。不要修改app/和product/。`,
    development: common + `你是开发负责人，负责 app/ 和 handoff/development.md。${base}\n实现独立静态模块化HTML/CSS/JavaScript项目，app/index.html是入口，不依赖CDN。棋盘交叉点可被真实按钮/键盘操作和读屏定位，视觉克制、中文。先看handoff/product.md若存在，并实现基线；维护app/README.md、app/CHANGELOG.md、规则测试。使用产品内置浏览器做真实落子交互、查看console/network；开发预览服务使用受管理后台命令，记录实际地址/jobId到handoff/development.md，不猜接口、不改客户端源码。测试会话只负责qa/及缺陷交接，你须阅读handoff/qa.md（存在时）修复真实问题。不要写其他角色文档目录。`,
    qa: common + `你是测试负责人，负责 qa/ 和 handoff/qa.md。${base}\n先交付qa/测试计划.md与qa/规则用例.json，覆盖提子、自杀、劫、重复落子、重开、桌面/H5和键盘。独立设计具体合法落子序列、期望棋盘与拒绝结果；规则期望不能直接照抄实现。检查app/和handoff/development.md若存在，能执行就实际运行规则测试和产品内置浏览器测试；尚无应用则明确待开发并结束本轮，勿反复等候。缺陷必须写期望/实际/复现/证据到handoff/qa.md，不能仅说通过。不得修改app/，开发由另一个会话执行。`
  }
}

export function savePlan(campaign, round) {
  const workspace = join(resolve(campaign), `round-${round}`, 'workspace')
  const folder = join(resolve(campaign), 'plans', `round-${round}`)
  mkdirSync(folder, { recursive: true })
  const prompts = makePrompts(workspace)
  for (const [role, prompt] of Object.entries(prompts)) writeFileSync(join(folder, `${role}-baseline.txt`), prompt)
  for (const item of additions) {
    const body = `[${item.id} ${item.title}] 中途新增需求，请并入当前项目，保留原需求与其他角色改动。\n${item.text}\n开发实现并实际验证；测试独立复核并写缺陷；产品/运营同步相关交付。仅完成本条及原有待办，不跳过未完成项。`
    writeFileSync(join(folder, `${item.id}.txt`), body)
  }
  writeFileSync(join(folder, 'plan.json'), JSON.stringify({ workspace, roles: Object.keys(prompts), additions, createdAt: new Date().toISOString() }, null, 2))
  return { workspace, folder }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(savePlan(process.argv[2], Number(process.argv[3] || 1))))
