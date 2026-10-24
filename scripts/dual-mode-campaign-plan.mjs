/** Data only: fresh real-model campaign inputs. The runner owns UI, queues and evidence. */
export const campaignRequirements = {
  code: [
    { id: 'G01', batch: 1, title: '悔棋与重做', request: '完善悔棋和重做：可连续退回和恢复多步，悔棋后另下新子必须丢弃旧分支；胜局悔棋恢复正确执棋与未结束状态。', acceptance: ['连续撤销三步再恢复三步，棋盘、轮次、步数一致', '撤销后新落子，重做不可用', '胜局撤销后可继续合法落子'] },
    { id: 'G02', batch: 1, title: '棋谱与复盘', request: '增加独立棋谱面板和复盘模式：逐手前进、后退、首手、末手、直接选择手数；复盘不能悄悄改变当前对局。显示落子坐标、颜色与最后一手。', acceptance: ['选择棋谱手数会重建对应棋盘', '退出复盘恢复当前对局', '复盘期间落子入口行为明确'] },
    { id: 'G03', batch: 2, title: '本地人机对战', request: '增加本地人机模式与先后手、至少两个难度。AI 必须优先完成己方即将获胜的五连并阻挡对方直接获胜点；搜索有明确耗时边界，计算期间界面可响应，重开或切模式后旧计算结果不能落入新盘。不要宣称职业棋力。', acceptance: ['已知四连局面选择直接制胜点', '无法制胜时阻挡对方单一制胜点', '计算中重开不会出现旧局落子', 'AI 思考期间菜单和移动端滚动正常'] },
    { id: 'G04', batch: 2, title: '对局时钟', request: '增加双人对局时钟，提供不限时和至少两个限时预设、暂停/继续与超时判负。用时间戳计算，不靠计时器 tick 数量累计；切到后台再回来不能延长剩余时间。暂停时禁止落子。', acceptance: ['只扣当前执棋一方时间', '暂停不扣时且不能落子', '超时结束并禁止继续落子', '后台返回后时间校准'] },
    { id: 'G05', batch: 3, title: '自动保存与恢复', request: '增加有版本号的本地自动保存和继续上次对局，覆盖棋盘、历史、规则、执棋、时钟状态；恢复前校验存档。坏存档需给可恢复提示并允许新开，不能白屏或默默串入其他游戏。', acceptance: ['刷新后恢复同一棋盘和轮次', '损坏存档显示可行动提示', '存储 key 使用本项目命名空间', '时钟恢复语义有文档和验证'] },
    { id: 'G06', batch: 3, title: '棋谱导入与导出', request: '增加带版本号的 JSON 棋谱导出与导入。逐手重放验证颜色顺序、坐标、重复点和终局之后多余落子；非法文件整份拒绝且保留当前棋盘。提供可粘贴文本入口，避免只能依赖系统文件对话框。', acceptance: ['导出再导入结果与完整棋谱一致', '重复坐标、越界、颜色错误和终局后多走均拒绝', '失败后当前对局不变'] },
    { id: 'G07', batch: 4, title: '完整键盘操作', request: '完善无障碍与纯键盘对局：棋盘单一 Tab 入口，方向键移动焦点，Enter/Space 落子，已落点读出颜色和坐标；连续落子、悔棋、重开与 Tab 离开再进入后焦点可预测，胜负与轮次用 live region 提示。', acceptance: ['连续键盘走两手及以上无需鼠标救场', 'Tab 离开再返回仍可继续移动焦点', '每点语义包含坐标与占用状态', '弹窗焦点可进入退出'] },
    { id: 'G08', batch: 4, title: 'H5 与桌面体验', request: '完成 360×800、390×844、768×1024、1440×900 布局；棋盘和核心操作均可见且无横向溢出，触屏落点准确，按钮触控区合理。提供亮/暗主题并跟随系统，尊重减少动态效果偏好，采用克制的 Apple 风格。', acceptance: ['四档视口无横向溢出', '手机可完成落子/悔棋/重开', '主题切换保持对局', '棋盘缩放后点击命中正确交叉点'] },
    { id: 'G09', batch: 5, title: '对局设置与结果', request: '增加对局设置和结果面板：玩家名字、双人/人机、先后手、时钟选项、最后一手和五连获胜路径高亮、可选手数标记；更改影响规则的选项需明确新开，结果能复制为可读文本。', acceptance: ['设置不会暗中改写正在进行的盘', '四个方向胜局均高亮正确五连', '手数开关不改变规则状态', '结果包含双方与胜负原因'] },
    { id: 'G10', batch: 5, title: '战术练习与发布质量', request: '增加至少三个可验证的“一手取胜/必须防守”练习局面和答案反馈，练习与正式对局完全隔离；补齐运行、规则、存档格式、已知限制和测试说明。清理未处理异常和无效资源请求，给出可部署的静态 web 产物，不虚报测试通过。', acceptance: ['三题答案经独立规则检查合法', '练习结束可回到原对局且无污染', '新目录直接启动服务可运行', '浏览器控制台无未处理异常，核心资源成功加载'] }
  ],
  work: [
    { id: 'W01', batch: 1, title: '棋盘与开局配置', request: '增加 9 路、13 路、19 路棋盘、贴目与黑白玩家名称。明确采用中国数子法；配置变更必须经明确新局操作。各尺寸棋盘交叉点、边角与坐标必须正确，不能用五连胜判围棋胜负。', acceptance: ['三档棋盘点数分别 81/169/361', '新局配置独立生效', '贴目参与白方最终得分', '边角落点与坐标准确'] },
    { id: 'W02', batch: 1, title: '提子与劫争规则', request: '加强围棋规则并增加局面测试：同一手同时提取多个无气棋块、落子先提对手后判己方自杀、禁止自杀，采用局面超级劫（position superko）禁止非停一手落子重复历史棋盘。停一手不被 superko 错误禁止；悔棋后重建合法历史。', acceptance: ['边角单子和整块提子正确', '先提对方获得气的落子合法', '纯自杀拒绝且历史/执棋不变', '立即回提与更长循环重复被拒绝', '双方停一手合法'] },
    { id: 'W03', batch: 2, title: '终局与数子', request: '实现双方连续停一手进入计分、认输结束、恢复对弈，并增加可审查的死子标记确认流程。按中国数子法计算活子与独占空点加贴目；中立公气不算任何一方，界面显示分项、死子修改及最终确认。不要声称自动准确判断所有死活或双活。', acceptance: ['两次连续停一手进入计分，一次后落子会重置', '封闭黑地/白地/中立点按分项计分', '死子标记可撤销且双方确认后锁定结果', '恢复对弈保留合法局面', '认输不误作数子结果'] },
    { id: 'W04', batch: 2, title: '悔棋与复盘', request: '增加完整落子/提子/停一手记录、连续悔棋重做、逐手复盘和跳转。重放必须同时恢复被提棋子、双方提子数、执棋、连续 pass 与 superko 历史；复盘与正式盘独立，分支后旧 redo 失效。', acceptance: ['跨提子和 pass 的撤销重做一致', '跳转指定手数重建同一局面', '悔棋后另走会丢弃旧 redo', '复盘退出恢复正式盘'] },
    { id: 'W05', batch: 3, title: 'SGF 导入导出', request: '支持 SGF FF[4] GM[1] 主线导入与导出，含 SZ/KM/PB/PW/RE、B/W 落子和空坐标 pass，正确处理属性转义；支持文本粘贴。只承诺实际支持的子集，遇到变体树或无法安全解释的设置节点明确拒绝或给出可审查的主线选择，禁止静默丢数据。导入须逐手合法验证并原子替换当前盘。', acceptance: ['合法主线导出再导入相同', 'pass、玩家名转义和贴目正确', '非法坐标/重复落子/不支持结构明确告知', '导入失败原盘不变'] },
    { id: 'W06', batch: 3, title: '持久化与对局档案', request: '增加版本化自动保存和本地对局档案，可继续未完成局、查看已完成局、删除指定档案。恢复必须校验完整历史并还原当前阶段；损坏记录可隔离并重新开始。存储与五子棋项目完全隔离。', acceptance: ['刷新恢复提子、pass、计分阶段和历史', '不同档案互不覆盖', '删除一项不影响其他项', '坏数据不会白屏或覆盖正常档案'] },
    { id: 'W07', batch: 4, title: '围棋时钟', request: '增加不限时与双方基本用时+日式读秒预设，显示基本时间、剩余读秒次数和当前读秒，暂停时禁止落子；以时间戳计算，后台再回来正确校准。明确读秒耗尽/落子切换/停一手/计分阶段的计时语义。', acceptance: ['只扣执棋方且基本时间到后进入读秒', '合法落子在规则内重置当前读秒', '读秒耗尽判负并禁止继续', '计分阶段停表，后台时间正确'] },
    { id: 'W08', batch: 4, title: 'H5 无障碍体验', request: '完善 360×800、390×844、768×1024、1440×900 响应布局与触屏落子，19 路小屏提供明确可用的精确选点方案。支持方向键、Enter/Space、合理 Tab 顺序、状态播报、亮暗主题和减少动态效果。棋盘不能被固定工具栏遮住。', acceptance: ['四档视口没有横向溢出', '19 路手机边角可以准确选择并确认', '键盘连续落子和 pass 可用', '主题/尺寸切换保持对局状态'] },
    { id: 'W09', batch: 5, title: '入门辅助与规则说明', request: '增加可切换的选中棋块气数/连通块高亮、最后一手与手数显示，以及至少三个提子/禁自杀/劫争入门练习。辅助仅解释规则，不冒充职业 AI 或自动死活分析；练习状态与正式对局隔离。', acceptance: ['连通棋块共享气去重正确', '边角气数与提子后气数正确', '三题规则反馈可验证', '辅助开关和练习不污染正式盘'] },
    { id: 'W10', batch: 5, title: '规则回归与发布质量', request: '把规则测试做成用户可打开的只读测试报告页面，覆盖提子、自杀、superko、pass、数子、SGF 往返、悔棋；显示真实执行结果与失败信息，不能写死全绿。补齐运行、采用规则、SGF 支持范围、死活人工确认和部署说明，完成内置浏览器桌面/手机最终验收。', acceptance: ['测试页真实执行断言，故意非法局面被正确拒绝', '核心规则覆盖与断言结果可复核', '生产入口和资源可访问，无未处理异常', '规则与未支持范围明确'] }
  ]
}

const browserInstructions = (origin) => `开发和验收必须使用 Aether 内置 browser_* 工具，不得用外部浏览器、Playwright/Puppeteer 或 shell 截图替代。页面预览地址固定为 ${origin}。先 browser_tabs 复用本会话标签，未有标签才 browser_open；修改后 browser_navigate 到带版本查询参数的本项目地址并重新 browser_snapshot。点击/填写/按键前使用最新 navigationId。每条需求至少做一个与该需求有关的真实浏览器操作并核对 DOM 状态，之后读 browser_console 和 browser_network。视口验证用 browser_set_viewport。验收后保留本会话预览标签供下一轮复用，不要主动关闭。模型无视觉能力时用结构快照验证并明确该限制；不要反复调用不支持的 screenshot。文件只能写当前项目目录，不读取、修改、打开另一个游戏的目录、端口或标签。不要关闭其他会话标签或服务。`

export function createCampaignPlan({ codeWorkspace, workWorkspace, codeOrigin, workOrigin }) {
  if (![codeWorkspace, workWorkspace, codeOrigin, workOrigin].every(value => typeof value === 'string' && value)) throw new Error('Both owned workspaces and preview origins are required')
  if (codeWorkspace.toLowerCase() === workWorkspace.toLowerCase() || codeOrigin === workOrigin) throw new Error('Code and Work must use distinct workspaces and origins')
  const make = (mode, workspace, origin, base) => ({
    mode, workspace, origin,
    baseline: `${base}\n当前项目目录：${workspace}。使用原生 HTML/CSS/JavaScript 的模块化静态 web 项目，真实写入 index.html、独立样式和规则/界面模块；不依赖 CDN。界面为中文，Apple 风格内容优先、稀疏工具栏、清楚的主次层级，桌面及 H5 均可操作；保持高对比、可见键盘焦点和减少动态效果，避免重型 3D、持续动画和无意义装饰。自行运行有意义的规则测试。建立 CHANGELOG.md 与 README.md，记录实际完成和未解决问题。先完成本条基础任务，后续会逐批增加需求。\n${browserInstructions(origin)}`,
    requirements: campaignRequirements[mode].map(item => ({ ...item, acceptance: [...item.acceptance],
      prompt: `[${item.id}] ${item.title}\n${item.request}\n验收要求：${item.acceptance.map((value, index) => `${index + 1}. ${value}`).join('；')}。\n${browserInstructions(origin)}\n完成后在 CHANGELOG.md 记录 ${item.id}、实际验证步骤和结果；有失败先修复再复验，无法完成则如实记录，不把待发队列当成已完成。` }))
  })
  return {
    schemaVersion: 1,
    incrementalRequirementsPerProject: 10,
    batchesPerProject: 5,
    code: make('code', codeWorkspace, codeOrigin, '开发可运行的 15×15 五子棋：本地双人黑白轮流落子，采用自由五子棋（至少五连即胜，不含禁手），四方向胜负、重复点/越界/终局后禁止落子、基础悔棋和重开、当前执棋和坐标提示。棋盘使用语义可操作交叉点。'),
    work: make('work', workWorkspace, workOrigin, '开发可运行的 9 路本地双人围棋：黑白轮流落子、同色棋块与气、提子、禁止自杀、基础立即回提劫限制、停一手、重开，明确显示当前执棋和提子数。棋盘使用语义可操作交叉点。基础完成后再逐项扩展完整对局功能。')
  }
}
