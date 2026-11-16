/** Only a suggested filename crosses the bridge. The native save dialog chooses the destination. */
export function decodePluginDownload(input: unknown): { fileName: string; bytes: Buffer } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('插件保存参数无效。')
  const { fileName, content, encoding = 'utf8' } = input as Record<string, unknown>
  if (typeof fileName !== 'string' || !fileName || Buffer.byteLength(fileName) > 240 ||
      /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(fileName) || /[. ]$/.test(fileName) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(fileName)) throw new Error('请提供不含路径的有效文件名。')
  if (typeof content !== 'string' || !['utf8', 'base64'].includes(String(encoding))) throw new Error('插件文件编码无效。')
  let bytes: Buffer
  if (encoding === 'base64') {
    if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('插件文件 Base64 内容无效。')
    bytes = Buffer.from(content, 'base64')
    if (bytes.toString('base64') !== content) throw new Error('插件文件 Base64 内容无效。')
  } else bytes = Buffer.from(content, 'utf8')
  return { fileName, bytes }
}
