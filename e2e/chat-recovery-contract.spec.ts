/** D4 snapshot replacement, consumed cursors, SSE IDs and durable nontext state. */
import { expect, test } from '@playwright/test'
import { parseSseBlock } from '../src/main/engine/sse'
import { acceptEventId, restoreChatSnapshot, type ChatRecoverySnapshot } from '../src/renderer/src/core/engine/chat-recovery'
import { reducePayload } from '../src/renderer/src/core/engine/chat-payload'
import { applyToolResult } from '../src/renderer/src/core/engine/chat-history'
import type { RootRun } from '../src/shared/root-run'

const run: RootRun = {schemaVersion:1,runId:'run',sessionId:'session',turnId:'turn',userMessageId:'user',assistantMessageId:'assistant',seq:1,version:1,status:'running',createdAt:1,updatedAt:2,pending:[]}
function snapshot(patch:Partial<ChatRecoverySnapshot>={}):ChatRecoverySnapshot {
  return {schemaVersion:1,source:'live',sessionId:'session',eventId:'stream:8',finished:false,run,runs:[run],history:[
    {id:'user',role:'user',content:'task',conversationId:'turn'},
    {id:'assistant',role:'assistant',content:'already persisted partial',conversationId:'turn'}
  ],projection:[],todos:[],changes:[],...patch}
}
test('SSE parser keeps id for JSON and terminal frames, CRLF/multiline/comments are valid',()=>{
  expect(parseSseBlock(': ping\r\nid: stream:7\r\ndata: {"content":\r\ndata: "hello"}')).toEqual({type:'payload',eventId:'stream:7',payload:{content:'hello'}})
  expect(parseSseBlock('event: done\nid: stream:8\ndata: [DONE]')).toEqual({type:'done',eventId:'stream:8'})
  expect(parseSseBlock(': ping')).toBeNull()
})
test('duplicate and older consumed IDs do not append text or args a second time',()=>{
  for(const incoming of ['stream:8','stream:7'])expect(acceptEventId('stream:8',incoming)).toBe(false)
  expect(acceptEventId('stream:8','stream:9')).toBe(true)
  let message=restoreChatSnapshot(snapshot({projection:[{thinking:'reason'},{content:'before'},{toolStart:{toolCallId:'tool',name:'write_file'}},{toolArgs:{toolCallId:'tool',args:'{"path":'}}]})).messages[1]
  let cursor='stream:8'
  for(const event of [{id:'stream:8',payload:{content:'before'}},{id:'stream:9',payload:{toolArgs:{toolCallId:'tool',args:'"x"}'}}},{id:'stream:9',payload:{toolArgs:{toolCallId:'tool',args:'"x"}'}}}]){
    if(!acceptEventId(cursor,event.id))continue
    cursor=event.id;message=reducePayload(message,event.payload)
  }
  expect(message.content).toBe('before');expect(message.thinking).toBe('reason');expect(message.tools[0].args).toBe('{"path":"x"}')
  expect(message.tools).toHaveLength(1)
})
test('atomic projection replaces current partial turn and root terminal applies after tools',()=>{
  const succeeded={...run,status:'succeeded' as const,version:3}
  const result=restoreChatSnapshot(snapshot({run:succeeded,runs:[succeeded],finished:true,projection:[
    {run:succeeded},{content:'complete'},{toolCall:{toolCallId:'tool',name:'read_file',args:{path:'x'}}},
    {toolResult:{toolCallId:'tool',success:true,output:'file result',durationMs:5}}
  ]}))
  expect(result.messages).toHaveLength(2)
  expect(result.messages[1]).toMatchObject({content:'complete',status:'done'})
  expect(result.messages[1].tools).toHaveLength(1)
  expect(result.messages[1].tools[0]).toMatchObject({state:'done',result:'file result',durationMs:5})
})
test('persisted snapshot restores attachments, todos, pending and current file change status',()=>{
  const change={id:'change',path:'x',kind:'write' as const,oldContent:null,newContent:'content',truncated:false,status:'pending' as const,createdAt:2}
  const waiting={...run,status:'waiting' as const,pending:[{requestId:'request',toolCallId:'ask',toolName:'ask_user',kind:'ask' as const,args:{question:'choose'},status:'pending' as const}]}
  const result=restoreChatSnapshot(snapshot({source:'persisted',eventId:null,finished:true,run:waiting,runs:[waiting],history:[
    {id:'user',role:'user',content:'task',conversationId:'turn',metadata:{attachments:[{name:'uploads/note.txt',type:'text/plain'}]}},
    {id:'assistant',role:'assistant',conversationId:'turn',toolCall:{id:'write',name:'write_file'}},
    {role:'tool',toolCallId:'write',content:'written',metadata:{success:true,change}}
  ],todos:[{id:'todo',title:'remember',status:'pending',priority:'medium'}],changes:[{...change,status:'kept'}]}))
  expect(result.messages[0].attachments?.[0]).toMatchObject({name:'note.txt',path:'uploads/note.txt'})
  expect(result.messages[1].pending).toMatchObject({requestId:'request',runId:'run'})
  expect(result.messages[1].tools[0].change?.status).toBe('kept')
  expect(result.todos[0].title).toBe('remember')
})
test('projected stable user survives snapshot/history first append race',()=>{
  const result=restoreChatSnapshot(snapshot({history:[],projection:[{userMessage:{id:'user',role:'user',content:'task',conversationId:'turn'}},{content:'live'}]}))
  expect(result.messages.map(message=>message.id)).toEqual(['user','assistant'])
})
test('same provider toolCallId in two root runs cannot overwrite the older owner',()=>{
  const first=restoreChatSnapshot(snapshot({projection:[{toolStart:{toolCallId:'reused',name:'read_file'}}]})).messages[1]
  const second={...first,id:'next',runId:'next-run',tools:first.tools.map(tool=>({...tool}))}
  const result=applyToolResult([first,second],{toolCallId:'reused',success:true,output:'new output'},'next-run')
  expect(result[0]).toBe(first);expect(result[1].tools[0].result).toBe('new output')
})
