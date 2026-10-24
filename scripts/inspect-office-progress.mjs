/** Bounded read-only status summary; no full-history polling or model calls. */
import { openSync, closeSync, fstatSync, readSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root=resolve(process.argv[2]||'.ae/office-company-20261023163242581')
const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'))
const sessions=join(state.profile,'engine','state','sessions')
function tail(path){
  const fd=openSync(path,'r')
  try{
    const size=fstatSync(fd).size,start=Math.max(0,size-512*1024),buf=Buffer.alloc(size-start)
    const n=readSync(fd,buf,0,buf.length,start),lines=buf.subarray(0,n).toString('utf8').split('\n')
    if(start)lines.shift()
    return lines.flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
  }finally{closeSync(fd)}
}
const rows=[]
for(const [id,role]of Object.entries(state.roles)){
  const tenant=readdirSync(sessions,{withFileTypes:true}).find(x=>x.isDirectory()&&existsSync(join(sessions,x.name,role.sessionId+'.jsonl')))?.name
  const history=tenant?tail(join(sessions,tenant,role.sessionId+'.jsonl')):[]
  const current=history.filter(row=>row.payload?.metadata?.rootRunId===role.lastStatus?.run?.runId)
  rows.push({role:id,status:role.lastStatus?.run?.status,runId:role.lastStatus?.run?.runId,
    recentTools:current.filter(row=>row.type==='tool').slice(-3).map(row=>({at:row.timestamp,dbSeq:row.dbSeq,name:row.payload.toolName,status:row.payload.metadata?.status,success:row.payload.metadata?.success,result:String(row.payload.content||'').slice(0,400)})),
    recentAssistant:current.filter(row=>row.type==='assistant'&&row.payload.content).slice(-1).map(row=>({at:row.timestamp,text:String(row.payload.content).slice(0,600)}))})
}
console.log(JSON.stringify({at:new Date().toISOString(),root,peakRunning:state.peakRunning,sampledSixRunningMinutes:state.sampledSixRunningMs/60000,rendererErrors:state.rendererErrors,processErrors:state.processErrors,rows},null,2))
