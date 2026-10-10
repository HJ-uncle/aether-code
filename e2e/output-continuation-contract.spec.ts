/** Persisted provider length continuations keep all output, tools, usage and run ownership. No Electron. */
import { expect, test } from '@playwright/test'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { applyRootRun } from '../src/renderer/src/core/engine/root-run-state'
test('three length fragments reconstruct byte-exact JSON and preserve final model and cumulative usage',()=>{
 const fragments=['{"items":[{"id":1,"na','me":"中文"},','{"id":2}]}']
 const rows=fragments.map((content,index)=>({id:'segment-'+index,role:'assistant',content,conversationId:'turn',modelId:index===2?'actual-fallback':'requested-model',createdAt:100+index,metadata:{runId:'run',turnId:'turn',outputContinuation:index<2},usage:{promptTokens:10+index,completionTokens:5+index,currentPromptTokens:50+index,contextWindow:100000}}))
 const messages=replayMessages([{id:'user',role:'user',content:'generate JSON',conversationId:'turn'},...rows])
 expect(messages).toHaveLength(2)
 expect(messages[1].content).toBe(fragments.join(''))
 expect(JSON.parse(messages[1].content)).toEqual({items:[{id:1,name:'中文'},{id:2}]})
 expect(messages[1].items).toEqual([{kind:'content',text:fragments.join('')}])
 expect(messages[1]).toMatchObject({modelId:'actual-fallback',runId:'run',conversationId:'turn',startedAt:100,endedAt:102,usage:{promptTokens:33,completionTokens:18,currentPromptTokens:52,contextWindow:100000}})
 const bound=applyRootRun(messages,{schemaVersion:1,runId:'run',sessionId:'session',turnId:'turn',userMessageId:'user',assistantMessageId:'final-id',version:2,seq:1,status:'succeeded',modelId:'requested-model',actualModelId:'actual-fallback',createdAt:100,updatedAt:103,finishedAt:103,pending:[]})
 expect(bound[1]).toMatchObject({id:'final-id',content:fragments.join(''),status:'done',modelId:'actual-fallback'})
})
test('normal ReAct paragraphs stay separate while continuation after a tool is exact and chronologically complete',()=>{
 const messages=replayMessages([
  {id:'explain',role:'assistant',conversationId:'turn',reasoningContent:'Inspect files',content:'Read now',toolCall:{id:'tool-1',name:'read_file',args:{path:'file.ts'}}},
  {role:'tool',toolCallId:'tool-1',content:'FILE_EVIDENCE',metadata:{success:true,durationMs:17}},
  {id:'partial',role:'assistant',conversationId:'turn',content:'const value = "',modelId:'model-A',metadata:{outputContinuation:true}},
  {id:'finish',role:'assistant',conversationId:'turn',content:'done";',modelId:'model-B'}
 ])
 expect(messages).toHaveLength(1)
 expect(messages[0].content).toBe('Read now\n\nconst value = "done";')
 expect(messages[0].tools[0]).toMatchObject({id:'tool-1',name:'read_file',result:'FILE_EVIDENCE',state:'done',durationMs:17})
 expect(messages[0].items).toEqual([{kind:'thinking',text:'Inspect files'},{kind:'content',text:'Read now'},{kind:'tool',id:'tool-1'},{kind:'content',text:'const value = "done";'}])
 expect(messages[0].modelId).toBe('model-B')
})
test('metadata-only turn identities prevent a truncated segment leaking into another turn',()=>{
 const messages=replayMessages([
  {id:'partial-A',role:'assistant',content:'TURN_A_PARTIAL',metadata:{turnId:'turn-A',runId:'run-A',outputContinuation:true}},
  {id:'partial-B',role:'assistant',content:'TURN_B_PARTIAL',metadata:{turnId:'turn-B',runId:'run-B',outputContinuation:true}},
  {id:'final-B',role:'assistant',content:'_END',metadata:{turnId:'turn-B',runId:'run-B'}}
 ])
 expect(messages.map(message=>({content:message.content,turn:message.conversationId,run:message.runId}))).toEqual([{content:'TURN_A_PARTIAL',turn:'turn-A',run:'run-A'},{content:'TURN_B_PARTIAL_END',turn:'turn-B',run:'run-B'}])
})
