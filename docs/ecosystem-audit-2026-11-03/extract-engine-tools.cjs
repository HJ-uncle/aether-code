const fs=require('fs'),path=require('path'),ts=require('D:/dev/ai-agent-engine/node_modules/typescript');
const root='D:/dev/ai-agent-engine', out='D:/dev/aether-code/docs/ecosystem-audit-2026-11-03';
const sourceFiles=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='__tests__')continue;const p=path.join(dir,e.name); if(e.isDirectory())walk(p); else if(p.endsWith('.ts')&&!p.endsWith('.test.ts'))sourceFiles.push(p)}}
walk(root+'/src/tools');sourceFiles.push(root+'/src/skills/math.ts',root+'/src/skills/time.ts');
const tools=[],unresolved=[];
for(const file of sourceFiles){
const src=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true),vars=new Map();
function collect(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)vars.set(n.name.text,n.initializer);ts.forEachChild(n,collect)}collect(sf);
const unk=n=>({$source:n.getText(sf)});
function val(n,stack=new Set()){if(!n)return undefined;
if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;
if(ts.isNumericLiteral(n))return Number(n.text);
if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;
if(ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isSatisfiesExpression(n)||ts.isTypeAssertionExpression(n))return val(n.expression,stack);
if(ts.isIdentifier(n)){if(n.text==='MAX_OPERATION_TIMEOUT_MS')return 2147483647; if(n.text==='undefined')return undefined; if(vars.has(n.text)&&!stack.has(n.text))return val(vars.get(n.text),new Set([...stack,n.text]));return unk(n)}
if(ts.isPrefixUnaryExpression(n)&&n.operator===ts.SyntaxKind.MinusToken)return -val(n.operand,stack);
if(ts.isArrayLiteralExpression(n)){const a=[];for(const e of n.elements){if(ts.isSpreadElement(e)){const v=val(e.expression,stack);a.push(...(Array.isArray(v)?v:[v]))}else a.push(val(e,stack))}return a}
if(ts.isObjectLiteralExpression(n)){const obj={};for(const p of n.properties){if(ts.isSpreadAssignment(p)){const v=val(p.expression,stack);Object.assign(obj,v?.$source?{['$spread'+Object.keys(obj).length]:v}:v)}else if(ts.isPropertyAssignment(p)){const k=p.name.text??p.name.getText(sf);if(['execute','preflight'].includes(k))continue;obj[k]=val(p.initializer,stack)}else if(ts.isShorthandPropertyAssignment(p)){obj[p.name.text]=val(p.name,stack)}}return obj}
if(ts.isPropertyAccessExpression(n)){const x=val(n.expression,stack);return x&&n.name.text in x?x[n.name.text]:unk(n)}
if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.AsteriskToken)return val(n.left,stack)*val(n.right,stack);
if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=val(n.left,stack),b=val(n.right,stack);if(['string','number'].includes(typeof a)&&['string','number'].includes(typeof b))return a+b}
return unk(n)}
function scan(n){if(ts.isObjectLiteralExpression(n)){const hasName=n.properties.some(p=>ts.isPropertyAssignment(p)&&p.name.getText(sf)==='name'&&ts.isStringLiteral(p.initializer));const hasParams=n.properties.some(p=>(ts.isPropertyAssignment(p)||ts.isShorthandPropertyAssignment(p))&&p.name.getText(sf)==='parameters');if(hasName&&(hasParams||n.properties.some(ts.isSpreadAssignment))){const x=val(n);if(x.name&&x.description&&x.parameters){tools.push({...x,sourceFile:path.relative(root,file).replaceAll('\\','/'),line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,parametersSource:n.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(sf)==='parameters')?.initializer.getText(sf)??'Inherited from subagentTool.parameters'})}}}ts.forEachChild(n,scan)}scan(sf);
if(file.endsWith('browser-tools.ts'))for(const d of val(vars.get('definitions'))){tools.push({name:'browser_'+d.action,displayName:d.displayName,description:d.description,parameters:{type:'object',additionalProperties:false,properties:d.properties??val(vars.get('tabProperties')),required:d.required??['tabId'],...(d.oneOf?{oneOf:d.oneOf}:{})},sourceFile:path.relative(root,file).replaceAll('\\','/'),line:sf.getLineAndCharacterOfPosition(vars.get('definitions').getStart()).line+1,parametersSource:'definitions → browserTools'})}
}
const allowedNames=new Set(['read_file','write_file','edit_file','list_files','delete_file','create_dir','office_document','office_inspect','office_environment','execute_cmd','command_output','cancel_command','ask_user','remember','recall','list_memories','forget','link_memories','list_skills','get_skill','run_skill_script','glob_search','grep_search','plan_update','todo_list','todo_create','todo_update','todo_delete','cron_list','cron_preview','cron_create','cron_update','cron_delete','task_list','task_cancel','task_status','subagent','subagent_start','subagent_send','subagent_wait','subagent_cancel','subagent_participants','subagent_inbox','web_fetch','http_request','get_current_context','search_history','install_package','list_packages','agent_list','agent_get','agent_create','agent_do_create','agent_update','agent_do_update','agent_delete','agent_do_delete','code_diagnose','codegraph','calculate','get_time',...tools.filter(t=>t.name.startsWith('browser_')).map(t=>t.name)]);
const codeText=fs.readFileSync(root+'/src/tools/tool-profile.ts','utf8').split('new Set([')[1].split('])')[0];const codeSet=new Set([...codeText.matchAll(/'([^']+)'/g)].map(m=>m[1]));
const unique=new Map();for(const t of tools)if(allowedNames.has(t.name))unique.set(t.name,t);
for(const t of unique.values()){t.profile={general:true,code:codeSet.has(t.name),memoryScopeCanExtendCode:['remember','recall','list_memories','forget','link_memories'].includes(t.name)};t.returnContract='ToolResult: { success:boolean, output:string, status?, error?, durationMs?, needsConfirmation?, pendingAction?, metadata?, change? }; output commonly carries JSON or plain text; no per-tool output schema is sent to the model.';}
const catalog=[...unique.values()].sort((a,b)=>a.sourceFile.localeCompare(b.sourceFile)||a.line-b.line);
for(const t of catalog)if(JSON.stringify(t.parameters).includes('$source'))unresolved.push(t.name);
const data={generatedAt:new Date().toISOString(),scope:'Static registered builtins plus three skill interface tools; excludes dynamic MCP and installed skills. Runtime request may expose a subset.',registrySource:'src/tools/registry-factory.ts',count:catalog.length,codeBuiltinCount:codeSet.size,unresolvedParameterReferences:unresolved,tools:catalog};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/engine-tools.json',JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({count:catalog.length,missing:[...allowedNames].filter(x=>!unique.has(x)),unresolved,names:catalog.map(t=>t.name)},null,2));
