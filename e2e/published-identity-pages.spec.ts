/** Existing fixed-lease identity pages replace per-child lookups without weakening the fence. */
import { test, expect } from '@playwright/test'
import { parsePublishedIdentityPage } from '../src/renderer/src/core/engine/published-child-recovery'
import { preparePublishedSnapshot } from '../src/renderer/src/core/engine/published-snapshot-client'
import { getEngineSource, publishEngineSource } from '../src/renderer/src/core/engine/source'
import type { ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import type { PublishedChildUsage } from '../src/shared/published-child'
import { PublishedRecoveryCancelledError } from '../src/renderer/src/core/engine/published-recovery-control'

const fence = { tenantId:'tenant',parentSessionId:'session',rootSessionId:'session',parentTurnId:'turn',rootRunId:'root',
  attemptId:'attempt',streamId:'stream',generation:'generation',eventSequence:7,revision:4,usageRevision:6 }
const identity = (index: number) => ({ tenantId:'tenant',runId:'child-'+index,parentSessionId:'session',rootSessionId:'session',
  parentConversationId:'turn',parentMessageId:'assistant',parentToolCallId:'tool-'+index,childSessionId:'session-'+index,modelId:'model',createdAt:1 })
const authority = (count: number): PublishedChildUsage => ({ source:'live-published',clientSource:1,sessionId:'session',snapshotId:'lease',fence,
  revision:'usage-fixed',scalar:{totalTokens:count,count,unknown:0} })
function identityPage(count: number, start = 0, size = 64) {
  const stop = Math.min(count,start+size), hasMore = stop<count
  return { protocolVersion:1,source:'live-published',snapshotId:'lease',fence,totalPublishedCount:count,
    includedCount:stop-start,residentComplete:start===0&&!hasMore,hasMore,nextCursor:hasMore?'identity:'+stop:null,
    refs:Array.from({length:stop-start},(_,offset)=>({identity:identity(start+offset),atSeq:5,firstOrdinal:start+offset+1})),
    usage:{source:'authoritative-scalar',revision:'usage-fixed',totalTokens:count,count,unknown:0} }
}
function snapshot(count: number): ChatRecoverySnapshot {
  const run = {schemaVersion:1 as const,runId:'root',sessionId:'session',turnId:'turn',userMessageId:'user',assistantMessageId:'assistant',
    status:'running' as const,version:1,seq:1,pending:[],createdAt:1,updatedAt:1}
  return {schemaVersion:1,source:'live',sessionId:'session',eventId:'stream:7',finished:false,run,runs:[run],history:[],todos:[],changes:[],
    projection:[{content:'preview'}],projectionIndices:[0],subagentRecovery:identityPage(count),
    subagentProjectionArchive:{protocolVersion:1,snapshotId:'lease',totalCount:count,originalProjectionCount:count+1,endpoint:'/chat/snapshot/projection'}}
}
type Input = {path:string;query?:Record<string,unknown>}
function bridge(count: number, mutate: (value: ReturnType<typeof identityPage>) => unknown = value => value): Input[] {
  const requests:Input[]=[]
  Object.defineProperty(globalThis,'window',{configurable:true,value:{aether:{engine:{request:async(input:Input)=>{
    requests.push(input);let data:unknown
    if(input.path==='/chat/snapshot/children')data=mutate(identityPage(count,Number(String(input.query?.cursor).split(':')[1])))
    else if(input.path==='/chat/snapshot/projection'){
      const start=input.query?.cursor?Number(String(input.query.cursor).split(':')[1]):0,stop=Math.min(count,start+64),hasMore=stop<count
      data={protocolVersion:1,snapshotId:'lease',fence,totalCount:count,originalProjectionCount:count+1,
        entries:Array.from({length:stop-start},(_,offset)=>({projectionIndex:start+offset+1,field:'subagentEvent',runId:'child-'+(start+offset),atSeq:5,sourceAtSeq:4})),
        hasMore,nextCursor:hasMore?'projection:'+stop:null}
    }else if(input.path.startsWith('/chat/snapshot/children/')) {
      const index=Number(input.path.split('/').at(-1)?.replace('child-',''))
      data={snapshotId:'lease',fence,item:{identity:identity(index),atSeq:5}}
    }else throw Error('Unexpected route '+input.path)
    return {ok:true,code:200,data}
  }}}}})
  return requests
}
const ready=():number=>{publishEngineSource({mode:'embedded',baseUrl:'',instanceId:crypto.randomUUID(),phase:'ready'});return getEngineSource()}

for(const count of [0,80,4096])test(`${count} fixed references use bounded identity pages and no individual lookup`,async()=>{
  const requests=bridge(count),source=ready(),progress:number[]=[]
  const result=await preparePublishedSnapshot(snapshot(count),source,()=>{}, {progress:(_,state)=>progress.push(state.loadedReferences)})
  expect(requests.filter(input=>input.path==='/chat/snapshot/children').length).toBe(Math.max(0,Math.ceil(count/64)-1))
  expect(requests.filter(input=>input.path==='/chat/snapshot/projection').length).toBe(Math.max(1,Math.ceil(count/64)))
  expect(requests.some(input=>input.path.startsWith('/chat/snapshot/children/'))).toBe(false)
  expect(result.projection.length).toBe(count+1)
  expect(result.projection.at(-1)?.publishedChild?.atSeq).toBe(count?4:undefined)
  expect(progress[0]).toBe(0);expect(progress.at(-1)).toBe(count)
})
for(const [label,mutation,reason]of [
  ['foreign fence',(value:ReturnType<typeof identityPage>)=>({...value,fence:{...fence,generation:'other'}}),'invalid_identity_page'],
  ['changed scalar',(value:ReturnType<typeof identityPage>)=>({...value,usage:{...value.usage,totalTokens:999}}),'identity_usage_conflict'],
  ['repeated identity',(value:ReturnType<typeof identityPage>)=>({...value,refs:value.refs.map((ref,index)=>index===0?{...ref,identity:identity(0)}:ref)}),'identity_order_conflict'],
  ['changed total',(value:ReturnType<typeof identityPage>)=>({...value,totalPublishedCount:81}),'identity_count_conflict'],
  ['missing tail',(value:ReturnType<typeof identityPage>)=>({...value,refs:[],includedCount:0}),'identity_count_conflict'],
  ['repeated cursor',(value:ReturnType<typeof identityPage>)=>({...value,hasMore:true,residentComplete:false,nextCursor:'identity:64'}),'repeated_identity_cursor'],
]as const)test(`rejects ${label} on a later identity page`,async()=>{
  bridge(80,mutation);const source=ready()
  await expect(preparePublishedSnapshot(snapshot(80),source,()=>{})).rejects.toThrow(reason)
})
test('does not accept an identity-page usage revision from a later lease',()=>{
  const page=identityPage(1)
  expect(()=>parsePublishedIdentityPage({...page,usage:{...page.usage,revision:'later'}},authority(1))).toThrow('identity_usage_conflict')
})

test('rejects a distinct run ID that reverses the server order at an equal ordinal',async()=>{
  bridge(80,value=>({...value,refs:value.refs.map((ref,index)=>index===0?{...ref,firstOrdinal:64,identity:identity(100)}:ref)}))
  await expect(preparePublishedSnapshot(snapshot(80),ready(),()=>{})).rejects.toThrow('identity_order_conflict')
})

test('accepts the next run ID at an equal ordinal when its UTF-8 order advances',async()=>{
  bridge(80,value=>({...value,refs:value.refs.map((ref,index)=>index===0?{...ref,firstOrdinal:64}:ref)}))
  expect((await preparePublishedSnapshot(snapshot(80),ready(),()=>{})).projection.length).toBe(81)
})
test('cancellation during identity paging makes no further reads and never cancels execution',async()=>{
  const control=new AbortController(),requests=bridge(80,value=>{control.abort();return value}),source=ready()
  await expect(preparePublishedSnapshot(snapshot(80),source,()=>{}, {signal:control.signal})).rejects.toBeInstanceOf(PublishedRecoveryCancelledError)
  expect(requests.map(input=>input.path)).toEqual(['/chat/snapshot/projection','/chat/snapshot/projection','/chat/snapshot/children'])
})
