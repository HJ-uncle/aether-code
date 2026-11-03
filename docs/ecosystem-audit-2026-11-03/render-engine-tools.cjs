const fs=require('fs'),p='D:/dev/aether-code/docs/ecosystem-audit-2026-11-03/',j=JSON.parse(fs.readFileSync(p+'engine-tools.json','utf8'));
const family={
'agent':['本租户自定义Agent数据库；inline Agent只参加list/get的只读合并，写入作用于本地DB。','list/get返回可读目录/详情；create/update/delete返回预览与pendingAction；do_*在confirmed=true后写库，返回含ID/名称的文本回执。'],
'browser':['当前tenant/root会话授权的在线Aether客户端宿主；截图需要视觉模型，点击/填写/按键需要可视目标与新navigationId。','桥接返回ToolResult，output通常为JSON：tab信息、snapshot元素、控制台/网络或操作结果；失败metadata含code/operationPerformed/recovery，不能把success=false当操作成功。'],
'cmd':['引擎宿主程序+args；工作区cwd校验、命令策略；不是客户端终端标签管理器。','后台启动JSON {jobId,status,message}，metadata.commandJob；前台返回stdout/stderr文本和metadata {commandJob,exitCode,signal,outputTruncated}，非零真实退出为失败。'],
'codegraph':['需要codegraph包与已有项目索引；index仅显式用户要求；缺包/缺索引有提示，不自动证明验证通过。','按action返回文本统计、符号/调用链/文件列表或异步建索引进度；部分“缺索引”是success=true的能力提示，不能当图查询成功。'],
'cron':['general工具；按tenant作用自动化，精确id；workspace target需明确项目。','JSON作业/预览或automationReceipt，删除是文本；定时任务删除不取消正在运行实例。'],
'file':['绑定工作区路径边界；普通文件，版本/hash及锁；写入和删除走显式ChangeStore记录。','格式化内容/JSON或文本回执，读写版本metadata；write/edit/delete成功可附change，供文件变更UI与撤回。'],
'get-context':['当前执行tenant/session；只读，历史检索不跨其它会话。','get_current_context为Markdown环境/工具/历史摘要；search_history为原始归档JSON及分页，图片恢复额外dataUrl进入视觉通道。'],
'http-request':['引擎网络请求，经guardedHttp和当前security mode；不是用户浏览器网络请求。','格式化HTTP状态、请求/响应头和正文文本；HTTP响应本身返回success=true，即使状态是4xx/5xx；应读状态码判断业务成功。'],
'install-package':['general工具；工作区package.json/npm。安装复用execute_cmd策略；首次confirm=false只提示确认。','install_package返回确认/安装文本；list_packages实际枚举package.json dependencies/devDependencies声明，不核验node_modules或真正全局包。'],
'lsp':['TS内置适配器或项目安装且配置可用的ESLint；不支持HTML/CSS。','文本诊断列表（最多展示200条）或DIAGNOSTIC_UNSUPPORTED失败；有诊断项时success=true表示诊断执行完成，不表示无错误。'],
'memory':['resolved memory scopes(global/session)启用；当前tenant、执行session；跨scope节点不可关联。','文本记录/检索/列表/删除/关联回执；写入含节点ID，关闭时MEMORY_DISABLED。'],
'office':['general；原生库随引擎发布，授权工作区DOCX/XLSX/PPTX/PDF；环境探测不授权外部软件。','office_document/inspect JSON {path,expectedHash,sizeBytes,format,summary,warnings,content?,contentIncluded,contentTruncated,contentPage?,validation,visualValidation}；写入附change；环境返回探测JSON。'],
'search':['授权工作区路径；grep优先ripgrep，可降级Node；glob不递归展开读取全文。','文本匹配路径/行列表，metadata分页count/offset/hasMore/nextOffset，grep还记录backend与失败状态；没有结果不等于搜索失败。'],
'skill':['受allowedSkills/OSM/项目配置筛选；本地SKILL.md或inline正文；脚本需真实技能路径和bash。','list/get返回技能目录/Markdown；run_skill_script返回退出输出文本，可包含失败/取消状态。没有本地路径的inline技能不可执行对应脚本。'],
'subagent':['继承父工具权限；默认read-only，implementer默认inherit；不能递归创建、无用户提问/审批通道；控制基于canonical执行身份。','同步outcomeText+机器状态；异步接纳runId/childSessionId；wait/cancel回执pending或真实终态；send队列回执；participants/inbox分页JSON。'],
'task':['general；本租户持久后台task queue，不是command job/subagent run。','task_list返回文本目录；status返回完整JobRecord JSON；cancel返回能否取消的文本提示，success=true不保证已终止。'],
'todo':['当前tenant/session计划；plan_update始终可用；旧todo CRUD仍受允许集。','plan_update返回持久TaskPlan JSON+metadata.internalControl=plan；失败带可用savedPlan/recovery；旧todo工具返回文本ID和状态。'],
'web-fetch':['HTTP/HTTPS；引擎guardedHttp，safe时额外域名配置；不执行浏览器JavaScript。','网页正文Markdown/提取文本，附URL/类型/长度；内容可能截断，非2xx失败。']
};
const specific={
calculate:['无外部运行时；数字、运算符、括号表达式，拒绝非有限值。','文本 expression = result；错误Math error。'],
get_time:['引擎系统时钟与Intl时区。','文本日期/locale或Unix秒；默认UTC/iso，所谓iso文本末尾附(timezone)，并非严格ISO8601时区后缀。'],
command_output:[null,'JSON CommandJobOutput {job,entries:[{seq,stream,text}],nextCursor,earliestCursor,truncated,hasMore}，metadata.commandJob。'],
cancel_command:[null,'JSON CommandJobSnapshot：schemaVersion,jobId,sessionId,ownerSessionId,runId/ownerRunId/turnId/toolCallId?,version,status,command,args,cwd,background,timestamps,exitCode,signal,error?,cursor,earliestCursor；等待可追踪进程退出。'],
office_environment:[null,'JSON OfficeEnvironment {schemaVersion:1,checkedAt,expiresAt,runtime,status,python,office:{com,registryStatus,libreOfficePath,conversionVerified:false},limitations}；120秒缓存，只读探测候选能力。'],
subagent_send:[null,'JSON持久发送回执 + metadata.collaborationReceipt；queued仅接纳，不代表读取/完成；requestKey默认当前toolCallId。'],
subagent_wait:[null,'pending时JSON SubagentWait；结束时outcomeText(run)；metadata.subagentObservation含观察与机器状态。'],
subagent_cancel:[null,'与subagent_wait相同观察合同；pending表示取消请求在处理中，不是已终止。'],
subagent_participants:[null,'JSON {participantId,...分页参与者结果}；cursor绑定当前root任务。'],
subagent_inbox:[null,'JSON {participantId,...分页收件回执}；无正文，自动整合不由模型指定sender。'],
ask_user:['需要当前任务交互通道；子代理不提供；两项以上具体选择。','本工具execute仅“请求已发出”文本；ReAct识别ask_user形成持久Pending，通过客户端答复续跑，不应以此空成功代替用户已回答。'],
read_file:[null,'auto等模式：带读取统计、完整文件版本metadata与格式内容；exact模式JSON {path,expectedHash,encoding,lineEnding,utf8Bom,startLine,endLine,totalLines,content}；图片模式原生dataUrl JSON。'],
edit_file:[null,'成功版本回执与metadata/change；expectedHash匹配后替换确切文本，失败或版本冲突不应猜hash重试。'],
list_files:[null,'目录条目文本；metadata {count,truncated,truncationReason}。默认recursive=false,maxResults=500，最大2000。'],
delete_file:[null,'Moved to trash文本 +change；仅普通文件，不支持目录/符号链接；记录失败可能metadata.fileMutationApplied=true,rollbackAvailable=false。'],
create_dir:[null,'Created directory文本；mkdir recursive，不附文件内容change回执。'],
cron_list:[null,'JSON {jobs:CronJob[]}。'],
cron_preview:[null,'JSON cronService.preview的实际后续UTC触发时间；不保存、不启动任务。'],
cron_create:[null,'JSON {automationReceipt:{kind:automation,schemaVersion:2,jobId,operation:created},summary,job:{id,name,enabled,nextRunAt,configuration}}。'],
cron_update:[null,'与cron_create同形；operation为updated/enabled/disabled；expectedRevision可防并发覆盖。'],
cron_delete:[null,'Automation deleted/未找到文本；已运行任务独立，不随之取消。'],
list_skills:[null,'名称+简短描述目录，可附当前OSM隐藏方法论数量；不含schema、脚本文件清单或正文。'],
get_skill:[null,'完整SKILL.md或受限references/*.md正文；无本地文件且无inlineContent返回未找到。'],
search_history:[null,'JSON {messages,totalMatches,nextOffset,backend,scope}；messages含messageId,role,turnId,createdAt,modelId,content,contentOffset,contentChars,nextContentOffset及images；messageId/imageIndex可恢复原图dataUrl。']
};
const notes={
execute_cmd:'args默认[]；background=false；timeoutMs省略无限，执行拒绝0；description仍有“Code模式”旧措辞，实际各profile一致。',
list_packages:'global有schema但execute仅解构后未参与分支；标题“已安装”实际只是package.json声明。',
browser_wait:'JSON schema只required tabId；Zod运行时还要求selector或text，timeoutMs省略/0无限。',
browser_fill:'JSON schema未编码ref/selector互斥；Zod执行要求恰好一项。',
browser_scroll:'Zod限制deltaX/Y在-10000..10000，模型JSON schema仅number。',
search_history:'JSON schema未写required query/messageId；执行要求至少一项非空；limit默认10，上限10，单段正文2000字符。',
subagent:'role枚举implementer/spec-reviewer/code-quality-reviewer；Code保留本工具但不开放agent_list/agent_get，description仍建议用它们找Agent ID。',
subagent_start:'schema继承subagent；异步接纳不代表结束，父任务仍等待真实执行和结果落盘。',
office_document:'Zod与执行还有语义校验：create必须missing，写操作真实hash；append_sheets每次1-4新表；PPTX slide/textRun成对；schema只是静态合同一层。',
office_inspect:'分页延续有限提取预览，contentOffset最大3145728 UTF-16字符；不代表整文档、整工作簿或视觉验证。',
run_skill_script:'timeoutMs最大2147483647源自src/core/utils/operation-timeout.ts:2；0/省略无截止；safe模式扩展策略拒绝。',
glob_search:'运行默认cwd=.,limit=100,offset=0；schema number，执行要求整数。',
grep_search:'运行默认path=.,caseSensitive=false,maxResults=50,offset=0；timeoutMs省略或0不限时。',
task_list:'Zod实际limit整数1..200，默认20，JSON schema只number。',
get_current_context:'includeTools默认true,includeHistory默认false；工具描述只截50字符，但provider收到完整schema，二者不可混淆。',
http_request:'responseType schema无binary，执行代码保留binary分支；auth schema仅object+描述，内部还支持digest/oauth2/custom，不代表这些分支已完整枚举为模型契约。',
codegraph:'action依赖query/nodeId条件只在description/execute；index会写索引，不是所有action都只读。',
remember:'required是content,type,tags；emotionalValence范围只有文字提示，无schema minimum/maximum。'
};
const readonly=new Set(['calculate','get_time','read_file','list_files','glob_search','grep_search','get_current_context','search_history','office_environment','office_inspect','command_output','browser_tabs','browser_snapshot','browser_screenshot','browser_console','browser_network','browser_network_request','subagent_wait','subagent_participants','subagent_inbox','list_skills','get_skill']);
for(const t of j.tools){const f=t.sourceFile.split('/')[2],a=family[f]??['当前会话已注册能力。','ToolResult输出。'],s=specific[t.name]??[];t.environment=s[0]??a[0];t.returnDetails=s[1]??a[1];t.notes=notes[t.name]??'';t.executionMode=t.name==='subagent'?'subagent':readonly.has(t.name)?'readonly':'serial';t.orchestrationBypass=['subagent','subagent_wait','subagent_cancel'].includes(t.name);if(t.name==='cancel_command')t.parametersSource='parameters constant in src/tools/cmd/job-tools.ts:6';t.profileNote=t.name==='plan_update'?'所有profile始终内建':t.profile.memoryScopeCanExtendCode?'general与code均需memory scope启用':t.profile.code?'general/Work与code候选，仍需通过允许集':'仅general/Work候选，仍需通过允许集';}
j.returnContract={required:{success:'boolean',output:'string'},optional:{status:'succeeded|failed|cancelled|interrupted|waiting',error:'string',durationMs:'number',needsConfirmation:'boolean',pendingAction:'{type:string,...}',metadata:'Record<string,unknown>',change:'Record<string,unknown>'},note:'These output fields are runtime envelopes, not typed output schemas delivered with tool definitions.'};
fs.writeFileSync(p+'engine-tools.json',JSON.stringify(j,null,2)+'\n');
let md=fs.readFileSync(p+'engine-audit-intro.md','utf8').replaceAll('\\'+String.fromCharCode(96),String.fromCharCode(96));
md+='| 工具原名 | 显示名 | profile | 必填参数 | 源码 |\n|---|---|---|---|---|\n';
for(const t of j.tools)md+='| '+t.name+' | '+t.displayName+' | '+t.profileNote+' | '+(t.parameters.required?.join(', ')||'见schema/运行校验')+' | ['+t.sourceFile+':'+t.line+'](D:/dev/ai-agent-engine/'+t.sourceFile+':'+t.line+') |\n';
const fence=String.fromCharCode(96).repeat(3);
for(const t of j.tools){md+='\n### '+t.name+' — '+t.displayName+'\n\n来源：['+t.sourceFile+':'+t.line+'](D:/dev/ai-agent-engine/'+t.sourceFile+':'+t.line+')。'+t.profileNote+'。执行模式：'+t.executionMode+(t.orchestrationBypass?'（编排等待/子代理不占普通工具槽）':'')+'。\n\n**模型原始说明**\n\n'+t.description+'\n\n**完整输入 JSON Schema**\n\n'+fence+'json\n'+JSON.stringify(t.parameters,null,2)+'\n'+fence+'\n\n**返回与环境**\n\n'+t.returnDetails+'\n\n'+t.environment+(t.notes?'\n\n**运行细节/契约差异**：'+t.notes:'')+'\n';}
fs.writeFileSync(p+'engine-tools.md',md);console.log(JSON.stringify({tools:j.tools.length,markdownBytes:Buffer.byteLength(md),jsonBytes:fs.statSync(p+'engine-tools.json').size}));

