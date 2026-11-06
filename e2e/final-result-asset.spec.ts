/** Pure immutable-delivery bytes: exact size/MIME/hash, complete responses,
 * malformed encodings and stable binary/text downloads. No engine or Electron. */
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { FinalResultItem } from '../src/shared/final-result'
import { decodeFinalResultAsset, MAX_FINAL_RESULT_ASSET_BYTES } from '../src/renderer/src/contrib/work/final-result-asset'

const file = (bytes: Buffer, patch: Partial<FinalResultItem> = {}): FinalResultItem => ({
  id: 'item', name: 'report.md', path: 'D:/workspace/report.md', mimeType: 'text/markdown', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), assetId: 'asset', kind: 'file', ...patch
})
const response = (bytes: Buffer, patch: Record<string, unknown> = {}) => ({
  path: 'D:/workspace/report.md', content: bytes.toString('base64'), isBinary: false, totalSize: bytes.length,
  mimeType: 'text/markdown', encoding: 'base64', tooLarge: false, truncated: false, ...patch
})

test('读取精确UTF-8字节，文本预览与下载保留同一内容', async () => {
  const bytes = Buffer.from('\ufeff# 中文\r\n100% done\r\n')
  const decoded = await decodeFinalResultAsset(response(bytes), file(bytes))
  expect(Buffer.from(decoded.bytes)).toEqual(bytes)
  expect(decoded.base64).toBe(bytes.toString('base64'))
  expect(decoded.text).toBe('# 中文\r\n100% done\r\n')
})

test('二进制不经过文本转换，哈希前缀和大小写可归一化', async () => {
  const bytes = Buffer.from([0, 255, 13, 10, 128, 0])
  const item = file(bytes, { mimeType: 'image/png', kind: 'image' })
  item.sha256 = `sha256:${item.sha256.toUpperCase()}`
  const decoded = await decodeFinalResultAsset(response(bytes, { mimeType: item.mimeType, isBinary: true }), item)
  expect(Buffer.from(decoded.bytes)).toEqual(bytes)
  expect(decoded.text).toBeUndefined()
})

test('相同路径的另一版本不能冒充已发布交付物', async () => {
  const original = Buffer.from('first'), changed = Buffer.from('other')
  await expect(decodeFinalResultAsset(response(changed), file(original))).rejects.toThrow('校验失败')
})

test('截断、缺失完整性标记、大小或MIME冲突均明确失败', async () => {
  const bytes = Buffer.from('report')
  for (const patch of [{ truncated: true }, { truncated: undefined }, { tooLarge: true }, { tooLarge: undefined },
    { totalSize: bytes.length + 1 }, { mimeType: 'text/plain' }, { content: undefined }, { isBinary: 'false' }]) {
    await expect(decodeFinalResultAsset(response(bytes, patch), file(bytes))).rejects.toThrow('不完整')
  }
})

test('不接受无效base64和伪造字节数', async () => {
  const bytes = Buffer.from('a')
  for (const content of ['%%%%', 'YQ=Z', 'Y===', 'YQ', 'YQ==\n', 'YQ====', 'AAAA']) {
    await expect(decodeFinalResultAsset(response(bytes, { content }), file(bytes))).rejects.toThrow()
  }
})

test('UTF-8兼容响应也校验精确字节，二进制不得伪装为UTF-8', async () => {
  const bytes = Buffer.from('最终文件')
  const decoded = await decodeFinalResultAsset(response(bytes, { encoding: 'utf8', content: bytes.toString() }), file(bytes))
  expect(Buffer.from(decoded.bytes)).toEqual(bytes)
  expect(decoded.base64).toBe(bytes.toString('base64'))
  await expect(decodeFinalResultAsset(response(bytes, { encoding: 'utf8', content: bytes.toString(), isBinary: true }), file(bytes))).rejects.toThrow('编码无效')
  const invalid = Buffer.from([0xff, 0xfe])
  await expect(decodeFinalResultAsset(response(invalid), file(invalid))).rejects.toThrow('文本编码无效')
})

test('零字节文件可下载，超过32 MiB及无效大小提前拒绝', async () => {
  const bytes = Buffer.alloc(0)
  expect((await decodeFinalResultAsset(response(bytes), file(bytes))).bytes.byteLength).toBe(0)
  await expect(decodeFinalResultAsset(response(bytes), file(bytes, { size: MAX_FINAL_RESULT_ASSET_BYTES + 1 }))).rejects.toThrow('32 MiB')
  for (const size of [-1, NaN, 1.5]) await expect(decodeFinalResultAsset(response(bytes), file(bytes, { size }))).rejects.toThrow('大小无效')
})
