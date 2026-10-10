/** Pure request restoration contract: no endpoint/credentials, no invented defaults, durable local edits. */
import { expect, test } from '@playwright/test'
import { normalizeRootRunRequestConfig } from '../src/shared/root-run'
import { composerThinkingMode, requestedThinkingMode, resolveSessionRequestConfig, loadSessionRequestSelection, saveSessionRequestSelection } from '../src/renderer/src/contrib/chat/session-request-config'
class MemoryStorage {
  private values = new Map<string,string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key,value) }
}
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
test.beforeEach(() => Object.defineProperty(globalThis,'localStorage',{value:new MemoryStorage(),configurable:true}))
test.afterAll(() => { if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else Reflect.deleteProperty(globalThis,'localStorage') })
test('safe projection preserves false, empty model strings, empty resource arrays and every supported tier', () => {
  expect(normalizeRootRunRequestConfig({ thinkingMode:false, utilityModel:'', skills:[], memoryScope:'session', headers:{token:'SECRET'}, inlineSkills:[{content:'SECRET'}], metadata:{secret:'SECRET'}, modelBaseUrl:'SECRET' })).toEqual({thinkingMode:false,utilityModel:'',skills:[],memoryScope:'session'})
  expect(normalizeRootRunRequestConfig({skills:[{id:'invalid'}],memoryScope:'invalid',thinkingMode:'max'})).toEqual({})
  expect(normalizeRootRunRequestConfig(undefined)).toBeUndefined()
  expect(normalizeRootRunRequestConfig([])).toBeUndefined()
  for(const mode of [true,false,'low','medium','high'] as const) expect(normalizeRootRunRequestConfig({thinkingMode:mode})).toEqual({thinkingMode:mode})
})
test('authoritative omitted fields never fall back to global models, thinking or []', () => {
  const fallbackConfig={agentId:'global',subagentModel:'global-sub',utilityModel:'global-utility',skills:[],mcpServers:[],knowledgeBases:[],thinkingMode:false as const}
  expect(resolveSessionRequestConfig({serverConfig:{},runId:'run-A',fallbackConfig})).toEqual({})
  expect(resolveSessionRequestConfig({serverConfig:{skills:[],thinkingMode:true},runId:'run-A',fallbackConfig})).toEqual({skills:[],thinkingMode:true})
  expect(resolveSessionRequestConfig({fallbackConfig})).toEqual(fallbackConfig)
})
test('only choices anchored to the current run override an external request, field by field', () => {
  const serverConfig={thinkingMode:'medium' as const,skills:['remote-skill'],utilityModel:'remote-utility',memoryScope:'session' as const}
  const selection={anchorRunId:'run-A',config:{skills:[],thinkingMode:false as const}}
  expect(resolveSessionRequestConfig({serverConfig,runId:'run-A',selection,fallbackConfig:{}})).toEqual({...serverConfig,skills:[],thinkingMode:false})
  expect(resolveSessionRequestConfig({serverConfig,runId:'run-B',selection,fallbackConfig:{}})).toEqual(serverConfig)
})
test('reload keeps an explicit Auto override and empty arrays without crossing source or session', () => {
  const selection={anchorRunId:'run-A',config:{skills:[],mcpServers:['chosen']},omitThinkingMode:true}
  saveSessionRequestSelection('same','source-A',selection)
  saveSessionRequestSelection('same','source-B',{anchorRunId:'run-B',config:{skills:['B']}})
  expect(loadSessionRequestSelection('other','source-A')).toBeNull()
  expect(loadSessionRequestSelection('same','source-B')).toMatchObject({config:{skills:['B']}})
  const restored=loadSessionRequestSelection('same','source-A')
  expect(resolveSessionRequestConfig({serverConfig:{thinkingMode:'high'},runId:'run-A',selection:restored,fallbackConfig:{}})).toEqual({skills:[],mcpServers:['chosen']})
  expect(resolveSessionRequestConfig({serverConfig:{thinkingMode:'medium'},runId:'run-B',selection:restored,fallbackConfig:{}})).toEqual({thinkingMode:'medium'})
})
test('displaying remote medium and true never changes their exact requested wire value', () => {
  expect(composerThinkingMode('medium')).toBe('medium')
  expect(composerThinkingMode(true)).toBe('on')
  expect(composerThinkingMode('high')).toBe('max')
  expect(composerThinkingMode(undefined)).toBe('high')
  expect(requestedThinkingMode('high')).toBeUndefined()
  expect(requestedThinkingMode('max')).toBe('high')
})
test('unavailable local persistence cannot block a request or silently erase authoritative config', () => {
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(){throw new Error('denied')},setItem(){throw new Error('full')}}})
  expect(loadSessionRequestSelection('same','source-A')).toBeNull()
  expect(()=>saveSessionRequestSelection('same','source-A',{config:{skills:[]}})).not.toThrow()
  expect(resolveSessionRequestConfig({serverConfig:{thinkingMode:true,memoryScope:'off'},fallbackConfig:{thinkingMode:false}})).toEqual({thinkingMode:true,memoryScope:'off'})
})
