/** Pure in-memory xterm coverage: retained output, soft wraps, Unicode and interpreted escape sequences. No Electron or PTY. */
import { expect, test } from '@playwright/test'
import { Terminal } from '@xterm/xterm'
import { readTerminalOutput } from '../src/renderer/src/contrib/terminal/terminal-output'

async function output(text: string, cols = 10, rows = 5, scrollback = 100): Promise<string> {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  try {
    await new Promise<void>(resolve => term.write(text, resolve))
    return readTerminalOutput(term.buffer.active)
  } finally {
    term.dispose()
  }
}

test('empty terminal and unused trailing viewport rows do not add blank output', async () => {
  expect(await output('')).toBe('')
  expect(await output('hello\r\n\r\n')).toBe('hello')
  expect(await output('hello\r\n   \r\n')).toBe('hello')
})

test('hard line breaks, indentation and internal empty rows are retained', async () => {
  expect(await output('\r\nfirst\r\n\r\n  last')).toBe('\nfirst\n\n  last')
})

test('soft wraps join physical rows without newlines or losing printed boundary spaces', async () => {
  expect(await output('foo  bar next', 5)).toBe('foo  bar next')
  expect(await output('12345 67\r\nnext', 5)).toBe('12345 67\nnext')
  expect(await output('abcd      ef', 5)).toBe('abcd      ef')
})

test('cursor-created spacing at a soft wrap remains significant', async () => {
  // Cursor-forward is clamped at the last column before printing wraps.
  expect(await output('ab\x1b[3Ccd', 5)).toBe('ab  cd')
  expect(await output('ab\tcd', 8)).toBe('ab     cd')
})

test('wide glyph wrapping omits the extra null cell but preserves adjacent spaces', async () => {
  expect(await output('abcd中文', 5)).toBe('abcd中文')
  expect(await output('ab  中文', 5)).toBe('ab  中文')
  expect(await output('ab \x1b[1C中文', 5)).toBe('ab  中文')
})

test('Unicode surrogate pairs, CJK and combining characters remain intact', async () => {
  expect(await output('中🙂文 e\u0301🙂abc', 5)).toBe('中🙂文 e\u0301🙂abc')
})

test('copies rendered content after color and overwrite sequences, without raw ANSI', async () => {
  expect(await output('\x1b[31merror\x1b[0m\r\nprogress 1\r\x1b[2Kdone', 20)).toBe('error\ndone')
})

test('retains scrollback beyond the viewport and tolerates a wrapped first retained row', async () => {
  expect(await output('one\r\ntwo\r\nthree\r\nfour', 10, 2)).toBe('one\ntwo\nthree\nfour')
  expect(await output('abcdefghijklmnopqrstuvwxyz', 5, 2, 1)).toBe('pqrstuvwxyz')
})

test('uses the active alternate screen without mixing normal screen history', async () => {
  expect(await output('normal\x1b[?1049h\x1b[Halternate', 20)).toBe('alternate')
})

test('keeps explicitly printed spaces at the end of a nonblank logical line', async () => {
  expect(await output('hello  \r\n')).toBe('hello  ')
})
