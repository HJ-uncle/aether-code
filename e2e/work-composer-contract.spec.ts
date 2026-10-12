import { expect, test } from '@playwright/test'
import { normalizeWorkState } from '../src/renderer/src/contrib/work/work-state'
import { buildMentionMessage, mentionToken, type Mention } from '../src/renderer/src/contrib/chat/mention-context'

test.describe('Work composer request contract', () => {
  test('restores Agent, resource bindings and mention metadata without widening paths', () => {
    const mention: Mention = { source: 'agent', displayText: 'Review Agent', path: 'agent-review', textOffset: 0 }
    const state = normalizeWorkState({
      homeDraft: `${mentionToken(mention)} 检查变更`,
      homeMentions: [mention],
      homeAgentId: 'agent-review',
      homeResources: { skills: ['review'], mcpServers: ['git'], knowledgeBases: ['kb-1'] },
      tasks: []
    })
    expect(state.homeAgentId).toBe('agent-review')
    expect(state.homeMentions).toEqual([mention])
    expect(state.homeResources).toEqual({ skills: ['review'], mcpServers: ['git'], knowledgeBases: ['kb-1'] })
  })

  test('drops malformed persisted mentions before they reach the composer', () => {
    const valid: Mention = { source: 'file', displayText: 'index.ts', path: 'src/index.ts', textOffset: 0 }
    const state = normalizeWorkState({
      homeMentions: [
        valid,
        { source: 'file', displayText: 42, path: 'src/invalid.ts' },
        { source: 'unknown', displayText: 'unsafe', path: 'D:/outside' },
        { source: 'agent', displayText: 'Review Agent', path: 'agent-review', textOffset: -1 }
      ],
      tasks: [{
        id: 'work-restore', title: '恢复', createdAt: 1,
        mentions: [{ source: 'file', displayText: 'ok', path: 'ok.ts' }, { source: 'file', displayText: null }]
      }]
    })
    expect(state.homeMentions).toEqual([valid])
    expect(state.tasks[0]?.mentions).toEqual([{ source: 'file', displayText: 'ok', path: 'ok.ts' }])
  })

  test('serializes mention metadata into the engine prompt while preserving the visible token', () => {
    const mention: Mention = { source: 'file', displayText: 'index.ts', path: 'src/index.ts', content: 'export const ok = true' }
    const text = `请检查 ${mentionToken(mention)}`
    const message = buildMentionMessage(text, [{ ...mention, textOffset: 5 }])
    expect(message).toContain('<reference type="file" path="src/index.ts">')
    expect(message).toContain('export const ok = true')
    expect(message).toContain('aether-refs:')
  })
})
