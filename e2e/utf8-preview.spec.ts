/** UTF-8 preview boundaries used by production child run normalization; no Electron required. */
import { expect, test } from '@playwright/test'
import { utf8BytePreview } from '../src/renderer/src/core/engine/utf8-preview'

const encoder = new TextEncoder()
function encodedPrefix(value: string, budget: number): string {
  let result = ''
  for (const character of value) {
    if (encoder.encode(result + character).byteLength > budget) break
    result += character
  }
  return result
}

test('preview preserves absent, empty, complete and default-budget values', () => {
  expect(utf8BytePreview(undefined)).toBeUndefined()
  expect(utf8BytePreview('', 0)).toBe('')
  expect(utf8BytePreview('完整内容 👍', 100)).toBe('完整内容 👍')
  expect(utf8BytePreview('a'.repeat(2049))).toBe('a'.repeat(2048))
  expect(utf8BytePreview('abc', -1)).toBe('')
})

test('every byte boundary matches platform UTF-8 encoding across multilingual and surrogate text', () => {
  const texts = [
    'ASCII\n\t\u0000', '中文测试', 'éǿΣ©', 'a👍b😀c', '👩‍💻🇨🇳e\u0301',
    '\ud800', '\udfff', '\ud800x\udfff', '\ud800\ud800\udfff\udfff',
    'mixed中文é👍\ud800尾部\udfff',
  ]
  for (const text of texts) {
    for (let budget = 0; budget <= encoder.encode(text).byteLength + 1; budget++) {
      const actual = utf8BytePreview(text, budget)!
      expect(actual, `${JSON.stringify(text)} / ${budget}`).toBe(encodedPrefix(text, budget))
      expect(encoder.encode(actual).byteLength).toBeLessThanOrEqual(budget)
    }
  }
})

test('deterministic mixed UTF-16 inputs retain the longest whole-code-point prefix', () => {
  let seed = 0x7a13c4
  const next = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const units = [0, 0x41, 0x7f, 0x80, 0x7ff, 0x800, 0x4e2d, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff]
  for (let sample = 0; sample < 200; sample++) {
    const text = Array.from({ length: 30 }, () => String.fromCharCode(units[next() % units.length])).join('')
    for (const budget of [0, 1, 2, 3, 4, 15, 31, 64, 128]) {
      expect(utf8BytePreview(text, budget)).toBe(encodedPrefix(text, budget))
    }
  }
})
