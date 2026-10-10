/** Timeout wire contract: distinguish absent/default, zero/unlimited and explicit milliseconds. */
import { expect, test } from '@playwright/test'
import { mcpDraft, mcpPayload, parseMcpTimeout } from '../src/renderer/src/contrib/settings/mcp-config'

function draft(timeoutMs:string) { return { ...mcpDraft(), id:'timeout-server',name:'Timeout server',command:'node',timeoutMs } }
test('default is omitted while zero and positive server deadlines survive edit/readback',()=>{
 expect(mcpPayload(draft(''))).not.toHaveProperty('timeoutMs')
 for(const timeoutMs of [0,15000,2147483647]){
  const payload=mcpPayload(draft(String(timeoutMs)))
  expect(payload).toHaveProperty('timeoutMs',timeoutMs)
  expect(mcpDraft({...payload,enabled:true}).timeoutMs).toBe(String(timeoutMs))
 }
 expect(parseMcpTimeout(' 0 ')).toBe(0)
})
test('invalid timeouts are rejected instead of falling back to a hidden default',()=>{
 for(const value of ['-1','1.5','NaN','Infinity','2147483648','1e3'])expect(()=>parseMcpTimeout(value)).toThrow(/请求超时/)
})
