/** Published text detection after byte/hash validation; no app, downloads or save dialogs. */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { FinalResultItem } from '../src/shared/final-result'
import { decodeFinalResultAsset } from '../src/renderer/src/contrib/work/final-result-asset'
import { finalResultText } from '../src/renderer/src/contrib/work/final-result-text'

function fixture(path: string, bytes: Buffer, mimeType = 'application/octet-stream') {
  const item: FinalResultItem = { path, name: '任意显示名称', id: 'asset', assetId: 'asset', kind: 'file',
    mimeType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const response = { content: bytes.toString('base64'), encoding: 'base64', isBinary: true,
    totalSize: bytes.length, mimeType, truncated: false, tooLarge: false }
  return { item, response }
}

for (const name of ['test.mjs', 'test.cjs', 'test.mts', 'test.cts', 'test.tsx', 'test.jsx', 'test.py', 'test.sh',
  'test.ps1', 'test.css', 'test.scss', 'test.xml', 'test.yaml', 'test.yml', 'test.toml', 'test.ini', '.env',
  'Dockerfile', 'Makefile', 'LICENSE', 'build.lock', 'trace.log', 'settings.unknown']) {
  test(`legacy generic binary metadata still opens ${name} as text`, async () => {
    const text = '#!/usr/bin/env node\n// 中文测试与 emoji 🚀\nconst result = "完成";\n'
    const bytes = Buffer.from(text), { item, response } = fixture(name, bytes)
    const asset = await decodeFinalResultAsset(response, item)
    expect(asset.text).toBe(text)
    expect(Buffer.from(asset.bytes).equals(bytes)).toBe(true)
    expect(asset.base64).toBe(response.content)
  })
}

test('BOM, empty text and a multibyte character at the sample boundary remain readable', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('\ufeff中文'), Buffer.from('\ufeff中文\n', 'utf16le'),
    Buffer.from('\ufeff中文\n', 'utf16le').swap16(), Buffer.from('x'.repeat(8191) + '中🚀')]) {
    const { item, response } = fixture('readme', bytes)
    const asset = await decodeFinalResultAsset(response, item)
    expect(asset.text).toBe(bytes.length === 0 ? '' : bytes.length > 8192 ? 'x'.repeat(8191) + '中🚀'
      : bytes[0] === 0xef ? '中文' : '中文\n')
    expect(Buffer.from(asset.bytes).equals(bytes)).toBe(true)
  }
})

test('binary signatures, controls and invalid bytes cannot become source text', () => {
  const { item } = fixture('misleading.mjs', Buffer.alloc(0))
  for (const bytes of [Buffer.from('%PDF-1.7\n'), Buffer.from([0x50, 0x4b, 3, 4, 65]), Buffer.from([0xff]),
    Buffer.from('valid\x00data'), Buffer.from('valid\x1bdata'), Buffer.from('a'.repeat(8200) + '\x00'),
    Buffer.concat([Buffer.from('a'.repeat(8200)), Buffer.from([0xc3])])]) {
    expect(finalResultText(bytes, item)).toBeUndefined()
  }
})

test('known documents and media keep their preview even with printable bytes or a source display name', () => {
  for (const path of ['report.pdf', 'sheet.xlsx', 'doc.docx', 'deck.pptx', 'pack.zip', 'image.png', 'video.mp4', 'font.woff2']) {
    const { item } = fixture(path, Buffer.from('printable but not source'))
    expect(finalResultText(Buffer.from('printable but not source'), { ...item, name: 'source.mjs' } as FinalResultItem)).toBeUndefined()
  }
  const { item } = fixture('renamed.mjs', Buffer.from('text'), 'application/pdf')
  expect(finalResultText(Buffer.from('text'), item)).toBeUndefined()
})

test('hash, incomplete responses and byte size still fail before text detection', async () => {
  const { item, response } = fixture('client.mjs', Buffer.from('const x = 1;'))
  await expect(decodeFinalResultAsset(response, { ...item, sha256: '0'.repeat(64) })).rejects.toThrow('校验失败')
  await expect(decodeFinalResultAsset({ ...response, truncated: true }, item)).rejects.toThrow('不完整')
  await expect(decodeFinalResultAsset({ ...response, totalSize: item.size + 1 }, item)).rejects.toThrow('不完整')
})
