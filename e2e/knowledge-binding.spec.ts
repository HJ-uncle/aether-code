import { expect, test } from '@playwright/test'
import {
  clearKnowledgeBinding,
  getKnowledgeBaseBindingIds,
  knowledgeBindingKey,
  loadKnowledgeBinding,
  saveKnowledgeBinding,
  isKnowledgeSourceCurrent,
  knowledgeDocumentByteLength,
  validateKnowledgeDocumentText,
  MAX_KNOWLEDGE_DOCUMENT_BYTES
} from '../src/renderer/src/core/engine/knowledge'

function installStorage(): void {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
}

test.beforeEach(() => installStorage())

test('knowledge bindings are deduplicated and isolated by source and session', () => {
  expect(knowledgeBindingKey('s1', 'embedded')).toBe('aether:knowledge-bases:embedded:s1')
  expect(knowledgeBindingKey('s1', 'remote:http://one')).toContain('remote:http://one')
  expect(saveKnowledgeBinding('s1', ['a', 'a', 'b'], 'embedded')).toEqual(['a', 'b'])
  expect(loadKnowledgeBinding('s1', 'embedded')).toEqual(['a', 'b'])
  expect(getKnowledgeBaseBindingIds('s1', 'remote:http://one')).toEqual([])
  expect(saveKnowledgeBinding('s1', ['remote'], 'remote:http://one')).toEqual(['remote'])
  expect(loadKnowledgeBinding('s1', 'embedded')).toEqual(['a', 'b'])
  expect(loadKnowledgeBinding('s1', 'remote:http://one')).toEqual(['remote'])
  expect(loadKnowledgeBinding('s2', 'embedded')).toEqual([])
})

test('clearing one session source does not alter another binding', () => {
  saveKnowledgeBinding('s1', ['a'], 'embedded')
  saveKnowledgeBinding('s1', ['b'], 'remote:http://one')
  clearKnowledgeBinding('s1', 'embedded')
  expect(loadKnowledgeBinding('s1', 'embedded')).toEqual([])
  expect(loadKnowledgeBinding('s1', 'remote:http://one')).toEqual(['b'])
})

test('knowledge document validation rejects empty and oversized text', () => {
  expect(knowledgeDocumentByteLength('中文')).toBeGreaterThan(0)
  expect(() => validateKnowledgeDocumentText('')).toThrow('不能为空')
  expect(() => validateKnowledgeDocumentText('x'.repeat(MAX_KNOWLEDGE_DOCUMENT_BYTES + 1))).toThrow('1 MiB')
})

test('late knowledge responses are invalid after an engine source switch', () => {
  expect(isKnowledgeSourceCurrent(7, 7)).toBe(true)
  expect(isKnowledgeSourceCurrent(7, 8)).toBe(false)
})

