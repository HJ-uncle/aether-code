/** Read-only UI recovery against a fully copied run; never opens the original databases.
 * Usage: node scripts/replay-five-session-client.mjs <original-run> [--prepare-only]
 * Starts only when explicitly run without --prepare-only; wait for replay-ready.json. */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { Transform } from 'node:stream'
const execFileAsync = promisify(execFile)
const original = path.resolve(process.argv[2] ?? '')
if (!process.argv[2] || !fs.existsSync(path.join(original, 'active-report.json'))) throw new Error('Completed original run is required')
const acceptanceName = process.env.AETHER_CLIENT_HISTORY_ONLY === '1' ? 'client-history-acceptance.json' : 'client-acceptance.json'
const runsRoot = path.dirname(original)
if (!runsRoot.endsWith(path.join('longrun-20261009', 'runs'))) throw new Error('Unexpected original run root')
const stamp = new Date().toISOString().replace(/[-:.]/g, '')
const replay = fs.mkdtempSync(path.join(runsRoot, 'replay-' + stamp + '-'))
const copied = path.join(replay, 'state')
const artifactRoot = 'D:/dev/aether-code/resources/engine/win32-x64'
const expectedBuildId = process.env.AETHER_CLIENT_EXPECTED_BUILD_ID
if (!expectedBuildId) throw new Error('AETHER_CLIENT_EXPECTED_BUILD_ID is required for frozen replay acceptance')
const buildManifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'dist/runtime/build-manifest.json'), 'utf8'))
if (buildManifest.buildId !== expectedBuildId) throw new Error('Packaged build differs from recovery baseline')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function inventory(directory) { const rows=[]; const visit=(folder)=>{ for(const item of fs.readdirSync(folder,{withFileTypes:true})) { const file=path.join(folder,item.name); if(item.isSymbolicLink()) throw new Error('Unexpected symbolic link in run state'); if(item.isDirectory())visit(file);else rows.push({path:path.relative(directory,file),bytes:fs.statSync(file).size,sha256:hash(file)}) }};visit(directory);return rows.sort((a,b)=>a.path.localeCompare(b.path)) }
const isState = row => /(?:^|[\\/])(?:global|sessions|memory|workspace|skills)[\\/]/.test(row.path) || /(?:\.db(?:-(?:wal|shm))?|\.sqlite(?:-(?:wal|shm))?|\.jsonl)$/i.test(row.path) && !/(?:^|[\\/])logs[\\/]/.test(row.path)
const before = inventory(original)
const beforeState = before.filter(isState)
fs.cpSync(original, copied, { recursive: true, errorOnExist: true, force: false })
const after = inventory(original), clone = inventory(copied)
if (JSON.stringify(beforeState)!==JSON.stringify(after.filter(isState))) throw new Error('Original state changed during snapshot copy')
const copiedIndex = new Map(clone.map(row => [row.path, row]))
if (beforeState.some(row => JSON.stringify(row)!==JSON.stringify(copiedIndex.get(row.path)))) throw new Error('Copied state identity differs from original')
const write = (name,value)=>fs.writeFileSync(path.join(replay,name),JSON.stringify(value,null,2))
write('state-copy-identity.json',{at:new Date().toISOString(),original,copied,files:before,originalStateUnchangedDuringCopy:true,copyStateMatches:true,stateFiles:beforeState,scope:'Full closed run directory including DB/WAL/SHM and global/session state; projects stay original and are accessed read-only'})
const manifest = JSON.parse(fs.readFileSync(path.join(copied,'active-start.json'),'utf8'))
manifest.baseUrl='http://127.0.0.1:12499';manifest.replay=true;manifest.originalRun=original
fs.writeFileSync(path.join(replay,'active-start.json'),JSON.stringify(manifest,null,2))
const token=randomBytes(32).toString('hex');fs.writeFileSync(path.join(replay,'.instance-token'),token,{mode:0o600})
if(process.argv.includes('--prepare-only')) {console.log(JSON.stringify({prepared:true,replay,copied,buildId:expectedBuildId}));process.exit(0)}
const env={...process.env};const envFile='D:/dev/ai-agent-engine/.env'
if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){const text=line.trim();const i=text.indexOf('=');if(!text||text.startsWith('#')||i<1)continue;const key=text.slice(0,i).trim();if(!(key in env))env[key]=text.slice(i+1).trim().replace(/^["']|["']$/g,'')}
const secrets=[token,...Object.entries(env).filter(([key,value])=>/key|token|secret|password|credential/i.test(key)&&value?.length>=8).map(([,value])=>value)]
const redact=text=>secrets.reduce((out,secret)=>out.split(secret).join('[REDACTED]'),String(text)).replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
const log=()=>{let pending='';return new Transform({transform(chunk,_encoding,callback){pending+=chunk.toString('utf8');const lines=pending.split(/\r?\n/);pending=lines.pop()||'';for(const line of lines)this.push(redact(line)+'\n');callback()},flush(callback){if(pending)this.push(redact(pending));callback()}})}
const ps=async(script,extra={})=>{const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:8*1024*1024,env:{...process.env,...extra}});return stdout.trim()?JSON.parse(stdout.trim().replace(/^\uFEFF/,'')):[]}
const table=()=>ps("$rows=@(Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString();name=$_.Name}});ConvertTo-Json -InputObject $rows -Compress")
const key=row=>row.pid+':'+row.startTicks,known=new Map();let engine,closed,stopping=false,timer
async function capture(){const rows=await table();const current=new Map(rows.map(row=>[key(row),row]));const accepted=new Map([...known].filter(([id])=>current.has(id)).map(([id])=>[id,current.get(id)]));let changed=true;while(changed){changed=false;for(const row of rows){if(accepted.has(key(row)))continue;if([...accepted.values()].some(parent=>row.parentPid===parent.pid&&BigInt(row.startTicks)>=BigInt(parent.startTicks))){accepted.set(key(row),row);changed=true}}}for(const [id,row]of accepted)known.set(id,row);write('owned-processes.json',{at:new Date().toISOString(),observed:[...known.values()],live:[...accepted.values()]});return [...accepted.values()]}
process.on('SIGINT',()=>{stopping=true});process.on('SIGTERM',()=>{stopping=true})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function freePort(){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(12499,'127.0.0.1',()=>server.close(resolve))})}
try {
 await freePort()
 Object.assign(env,{PORT:'12499',HOST:'127.0.0.1',AUTH_ENABLED:'false',AETHER_INSTANCE_TOKEN:token,DATA_DIR:path.join(copied,'agent.db'),KNOWLEDGE_DATA_DIR:path.join(copied,'knowledge.db'),WORKSPACE_ROOT:path.dirname(runsRoot),AETHER_GLOBAL_DIR:path.join(copied,'global'),SKILLS_ROOT:path.join(copied,'skills'),MCP_CONFIG_PATH:path.join(copied,'mcp.json'),QA_LOG_DIR:path.join(replay,'logs'),ENABLE_LONG_TERM_MEMORY:'true',DEFAULT_SECURITY_MODE:'standard',DISABLE_TELEMETRY:'true',HISTORY_BACKEND:'jsonl',MAX_ITERATIONS:'96',LLM_FALLBACK_MODEL:''})
 engine=spawn(path.join(artifactRoot,'runtime/node.exe'),[path.join(artifactRoot,'dist/main.js')],{cwd:copied,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
 engine.stdout.pipe(log()).pipe(fs.createWriteStream(path.join(replay,'engine.out.log')));engine.stderr.pipe(log()).pipe(fs.createWriteStream(path.join(replay,'engine.err.log')))
 engine.on('exit',(code,signal)=>{closed={code,signal}})
 const rootProcess=(await table()).find(row=>row.pid===engine.pid);if(!rootProcess)throw new Error('Replay engine start identity unavailable');known.set(key(rootProcess),rootProcess);await capture()
 timer=setInterval(()=>{void capture().catch(error=>write('process-capture-error.json',{message:redact(error.message)}))},5000)
 const readyDeadline=Date.now()+90000;let ready=false
 while(Date.now()<readyDeadline&&!closed){try{const health=await fetch(manifest.baseUrl+'/health',{signal:AbortSignal.timeout(2000)});const meta=await fetch(manifest.baseUrl+'/meta',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());if(health.ok&&meta.data?.buildId===expectedBuildId){ready=true;break}}catch{}await sleep(300)}
 if(!ready)throw new Error('Replay engine did not become ready with expected build')
 write('replay-ready.json',{at:new Date().toISOString(),originalRun:original,replay,copied,buildId:expectedBuildId,pid:rootProcess.pid,startTicks:rootProcess.startTicks,scope:'Restarted recovery against copied final state; not original load/health/overlap evidence'})
 console.log(JSON.stringify({ready:true,replay,buildId:expectedBuildId}))
 const deadline=Date.now()+10*60000
 while(Date.now()<deadline&&!closed&&!stopping){if(fs.existsSync(path.join(replay,acceptanceName)))break;await sleep(500)}
 if(!fs.existsSync(path.join(replay,acceptanceName)))throw new Error('Terminal client acceptance missing')
 const accepted=JSON.parse(fs.readFileSync(path.join(replay,acceptanceName),'utf8'));if(!accepted.passed)throw new Error('Terminal client recovery failed')
 write('replay-outcome.json',{passed:true,finishedAt:new Date().toISOString(),client:accepted,scope:'Copied-state terminal recovery only'})
} catch(error){write('replay-outcome.json',{passed:false,error:redact(error.stack),finishedAt:new Date().toISOString()});process.exitCode=1}
finally {
 clearInterval(timer);stopping=true
 if(engine){await capture().catch(()=>{});const outcome=await ps("$expected=ConvertFrom-Json -InputObject $env:AETHER_REPLAY_PROCESS_IDENTITIES;$stopped=@();$reused=@();$gone=@();$errors=@();foreach($item in ($expected|Sort-Object {[long]$_.startTicks} -Descending)){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$item.pid) -ErrorAction SilentlyContinue;if(-not $p){$gone+=[int]$item.pid;continue};if($p.CreationDate.ToUniversalTime().Ticks.ToString() -ne [string]$item.startTicks){$reused+=[int]$item.pid;continue};try{Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop;$stopped+=[int]$item.pid}catch{$errors+=$_.Exception.Message}};Start-Sleep -Milliseconds 700;$remaining=@();foreach($item in $expected){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$item.pid) -ErrorAction SilentlyContinue;if($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq [string]$item.startTicks){$remaining+=[int]$item.pid}};[pscustomobject]@{stopped=$stopped;alreadyGone=$gone;reusedSkipped=$reused;remaining=$remaining;errors=$errors}|ConvertTo-Json -Depth 6 -Compress",{AETHER_REPLAY_PROCESS_IDENTITIES:JSON.stringify([...known.values()])});write('cleanup-processes.json',{at:new Date().toISOString(),match:'PID+CreationDate ticks only',...outcome});if(outcome.remaining?.length||outcome.errors?.length)process.exitCode=1}
 const originalFinal=inventory(original);const finalState=originalFinal.filter(isState);const stateUnchanged=JSON.stringify(beforeState)===JSON.stringify(finalState);const initialByPath=new Map(before.map(row=>[row.path,row]));const diagnosticChanges=originalFinal.filter(row=>!isState(row)&&JSON.stringify(initialByPath.get(row.path))!==JSON.stringify(row));write('original-preservation.json',{at:new Date().toISOString(),stateUnchanged,stateFiles:finalState,allowedDiagnosticChanges:diagnosticChanges,scope:'Original DB/WAL/SHM and global/sessions/workspace/skills state hashes strictly unchanged; diagnostic evidence updates separately recorded'});if(!stateUnchanged)process.exitCode=1
}