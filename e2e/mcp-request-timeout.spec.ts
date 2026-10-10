/** Main-process timeout boundary: only explicit MCP test configuration changes the bridge deadline. */
import { expect, test } from '@playwright/test'
import { managementRequestSignal, managementRequestTimeout } from '../src/main/engine/request-timeout'
const request = { method: 'POST' as const, path: '/mcp/servers/fixture/test' }

test('MCP connect keeps legacy defaults, zero is unlimited and custom values include response grace',()=>{
 expect(managementRequestTimeout(request)).toBe(120000)
 expect(managementRequestTimeout({...request,timeoutMs:0})).toBeNull()
 expect(managementRequestTimeout({...request,timeoutMs:15000})).toBe(95000)
 expect(managementRequestTimeout({...request,timeoutMs:180000})).toBe(1085000)
 expect(managementRequestTimeout({...request,path:'/api/v1/mcp/servers/fixture/test',timeoutMs:0})).toBeNull()
 expect(managementRequestTimeout({...request,timeoutMs:2147483647})).toBeNull()
 for (const timeoutMs of [-1,1.5,NaN,Infinity,2147483648])expect(()=>managementRequestTimeout({...request,timeoutMs})).toThrow(/MCP 请求超时/)
})
test('other management requests cannot opt out of their existing timeout',()=>{
 for(const request of [{method:'GET' as const,path:'/mcp/servers/fixture/test'},{method:'POST' as const,path:'/mcp/servers'},{method:'PUT' as const,path:'/settings'}])expect(managementRequestTimeout({...request,timeoutMs:0})).toBe(120000)
})
test('unlimited and finite MCP requests still abort on connection teardown',()=>{
 for(const timeoutMs of [0,15000]){
  const controller = new AbortController()
  const signal = managementRequestSignal({...request,timeoutMs},controller.signal)
  expect(signal.aborted).toBe(false)
  const reason = new Error('connection switched or closed')
  controller.abort(reason)
  expect(signal.aborted).toBe(true)
  expect(signal.reason).toBe(reason)
 }
})
