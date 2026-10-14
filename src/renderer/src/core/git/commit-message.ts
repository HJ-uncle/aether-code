export function cleanAiCommitMessage(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // 只去掉包裹整段结果的围栏；正文里的 Markdown 反引号属于有效内容，不能全局删除。
  if (text.startsWith('```')) {
    const openingLineEnd = text.indexOf('\n')
    text = openingLineEnd >= 0 ? text.slice(openingLineEnd + 1) : text.slice(3)
    text = text.replace(/\s*```$/i, '').trim()
  }
  if (!text) return ''

  const lines = text.split(/\r?\n/).map((line) => line.trimEnd())
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  if (lines.length === 0) return ''

  // 常见的模型包装标签不属于提交正文。
  lines[0] = lines[0].replace(/^(?:提交信息|commit message|message|标题)\s*[:：]\s*/i, '').trim()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  let value = lines.join('\n').trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      value = value.slice(1, -1).trim()
  }
  return value
}
