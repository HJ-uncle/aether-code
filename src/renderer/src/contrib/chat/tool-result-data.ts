export type ToolResultData = Record<string, unknown> | unknown[]

/** Decode only complete, bounded JSON. Logs, source text and partial streaming
 * results must retain their original formatting instead of being guessed at. */
export function parseToolResultData(text: string): ToolResultData | null {
  if (text.length > 64_000) return null
  let value: unknown = text.trim()
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth++) {
    if (!/^[{[\"]/.test(value.trim())) return null
    try { value = JSON.parse(value) } catch { return null }
  }
  return value && typeof value === 'object' ? value as ToolResultData : null
}

const LABELS: Record<string, string> = {
  path: '路径', filePath: '文件路径', file_path: '文件路径', file: '文件', files: '文件',
  name: '名称', title: '标题', description: '说明', summary: '摘要', message: '说明',
  status: '状态', success: '成功', error: '错误', result: '结果', data: '数据',
  output: '输出', content: '内容', text: '文本', url: '网址', type: '类型',
  count: '数量', total: '总数', size: '大小', bytes: '字节数', rows: '行', columns: '列',
  sheets: '工作表', pages: '页', slides: '幻灯片', warnings: '提示',
  command: '命令', cwd: '工作目录', exitCode: '退出码', stdout: '标准输出', stderr: '错误输出',
  durationMs: '耗时（毫秒）', mimeType: '文件类型'
}

export function toolResultFieldLabel(key: string): string { return Object.hasOwn(LABELS, key) ? LABELS[key] : key }
