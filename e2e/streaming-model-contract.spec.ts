/** D5 actual model, cumulative live usage and ordered historical body/tool replay. */
import { expect, test } from '@playwright/test'
import type { ChatMessage } from '../src/renderer/src/core/engine/useChat'
import type { RootRun } from '../src/shared/root-run'
import { reducePayload } from '../src/renderer/src/core/engine/chat-payload'
import { replayMessages } from '../src/renderer/src/core/engine/chat-history'
import { applyRootRun } from '../src/renderer/src/core/engine/root-run-state'
import { sumUsage } from '../src/renderer/src/contrib/chat/usage'

const empty:ChatMessage={id:'assistant',role:'assistant',content:'',thinking:'',tools:[],items:[],status:'streaming',createdAt:1,modelId:'requested'}
test('model-only frame preserves accumulated counters and repeated cumulative usage never double charges',()=>{
  let message=reducePayload(empty,{usage:{modelId:'primary',promptTokens:20,completionTokens:5,totalTokens:25,currentPromptTokens:20,contextWindow:32000}})
  message=reducePayload(message,{usage:{modelId:'fallback'}})
  expect(message).toMatchObject({modelId:'fallback',usage:{totalTokens:25,currentPromptTokens:20}})
  for(let i=0;i<2;i++)message=reducePayload(message,{usage:{modelId:'fallback',promptTokens:50,completionTokens:9,totalTokens:59,currentPromptTokens:30,contextWindow:64000}})
  expect(sumUsage([message]).total).toBe(59)
  expect(message.usage).toMatchObject({currentPromptTokens:30,contextWindow:64000})
})
test('requested root model cannot overwrite actual usage model, authoritative actualModelId remains visible',()=>{
  const run:RootRun={schemaVersion:1,runId:'run',sessionId:'session',turnId:'turn',userMessageId:'user',assistantMessageId:'assistant',seq:1,version:1,status:'running',modelId:'requested',createdAt:1,updatedAt:2,pending:[]}
  const message=reducePayload(empty,{usage:{modelId:'fallback'}})
  expect(applyRootRun([message],run)[0].modelId).toBe('fallback')
  expect(applyRootRun([message],{...run,actualModelId:'server-actual'})[0].modelId).toBe('server-actual')
})
test('body before tool remains body in live timeline, final body appends exactly once',()=>{
  let message=reducePayload(empty,{content:'before'})
  message=reducePayload(message,{toolStart:{toolCallId:'read',name:'read_file',args:{path:'x'}}})
  message=reducePayload(message,{toolResult:{toolCallId:'read',success:true,output:'data'}})
  message=reducePayload(message,{content:'after'})
  expect(message.items.map(item=>item.kind)).toEqual(['content','tool','content'])
  expect(message.content).toBe('beforeafter');expect(message.thinking).toBe('')
})
test('history parallel-tool rows do not repeat body or usage; latest actual model/context win',()=>{
  const messages=replayMessages([
    {id:'a',role:'assistant',content:'before',conversationId:'turn',modelId:'primary',toolCall:{id:'read',name:'read_file'},usage:{promptTokens:20,completionTokens:5,totalTokens:25,currentPromptTokens:20,contextWindow:32000}},
    {id:'b',role:'assistant',content:'',conversationId:'turn',modelId:'primary',toolCall:{id:'other',name:'read_file'}},
    {role:'tool',toolCallId:'read',content:'data',metadata:{success:true}},
    {id:'c',role:'assistant',content:'after',conversationId:'turn',modelId:'fallback',usage:{promptTokens:30,completionTokens:4,totalTokens:34,currentPromptTokens:30,contextWindow:64000}}
  ])
  expect(messages).toHaveLength(1)
  expect(messages[0].items.map(item=>item.kind)).toEqual(['content','tool','tool','content'])
  expect(messages[0].content).toBe('before\n\nafter')
  expect(messages[0].modelId).toBe('fallback')
  expect(messages[0].usage).toMatchObject({totalTokens:59,currentPromptTokens:30,contextWindow:64000})
  expect(sumUsage(messages).total).toBe(59)
})
test('provider failure preserves emitted body and actual model while reporting failure',()=>{
  let message=reducePayload(empty,{usage:{modelId:'primary-actual'}})
  message=reducePayload(message,{content:'partial response'})
  message=reducePayload(message,{error:'upstream disconnected'} as Parameters<typeof reducePayload>[1])
  expect(message).toMatchObject({status:'error',content:'partial response',modelId:'primary-actual',error:'upstream disconnected'})
})
