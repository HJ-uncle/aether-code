import assert from 'node:assert/strict'
import test from 'node:test'
import { highlightSource, tryHighlightSource } from './source-highlight.ts'
import { sourceLanguage } from './source-highlight-language.ts'

const text = lines => lines.map(line => line.map(token => token.text).join('')).join('\n')

test('source highlighting preserves exact text and multiline syntax state', () => {
  const content = "var answer = 42\n/* comment\ncontinued */\nconst template = `hello\n${answer}`\n"
  const lines = highlightSource(content, 'javascript')
  assert.equal(text(lines), content)
  assert(lines[1].some(token => token.className === 'hljs-comment'))
  assert(lines[2].some(token => token.className === 'hljs-comment'))
  assert(lines[0].some(token => token.className === 'hljs-keyword' && token.text === 'var'))
  assert(lines[0].some(token => token.className === 'hljs-number'))
})

test('language aliases are explicit and unsupported text remains plain', () => {
  assert.equal(sourceLanguage('app.js'), 'javascript')
  assert.equal(sourceLanguage('component.tsx'), 'typescript')
  assert.equal(sourceLanguage('index.html'), 'xml')
  assert.equal(sourceLanguage('settings.yml'), 'yaml')
  assert.equal(sourceLanguage('notes.txt'), undefined)
  const markup = '<script>alert(1)</script>'
  assert.equal(text(tryHighlightSource(markup, 'xml')), markup)
})
