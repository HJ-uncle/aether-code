/**
 * 引用（mention）在「输入框 chip ⇄ 发送正文 ⇄ 气泡展示」三态之间的唯一约定
 *
 * 解决的问题：输入框里的引用标签一发送就被拍平成纯文本，之后再想知道「哪几个字是引用、
 * 引用的是什么」就只能靠猜——`@public` 后面紧跟用户打的 `312`，纯文本里根本分不清边界。
 *
 * 做法（学 wuzu PromptMentionInput 的 Flow 式原数据替换）：发送时把正文里每个引用的
 * 显示文字**原位替换成它的原数据**——源码引用换成「标签行 + 代码围栏原文」、终端引用换成
 * 「标签行 + 输出原文」、未保存文件引用携带编辑缓冲区；普通文件/目录保留 `@路径` 标签。模型拿到的是
 * 原数据本身，被要求「原封不动输出」时自然输出得出来。
 *
 * 替换会改掉区间长度，所以正文末尾挂一行 HTML 注释，里面是**替换后**的字符下标：气泡渲染
 * 和「回填输入框」都按下标把整段替换内容收成一枚标签，显示仍是标签样式。下标是引用的唯一
 * 身份——绝不做文本匹配，否则 `@public` 后面紧跟 `312` 必然串位。
 *
 * 为什么非得写进正文：对话记录由引擎落库，我们只负责读，给消息对象加字段重启一次就没了，
 * 能可靠往返的只有正文这段字符串。
 */

export type MentionSource = 'file' | 'dir' | 'code' | 'terminal' | 'agent'

/** 每种引用标签的配色与悬停提示：输入框 chip 与气泡 chip 共用这一份 */
export const MENTION_META: Record<MentionSource, { color: string; hint: string }> = {
  file: { color: '#3b82f6', hint: '文件' },
  dir: { color: '#d97706', hint: '目录' },
  code: { color: '#8b5cf6', hint: '源码位置' },
  terminal: { color: '#0ea5e9', hint: '终端输出' },
  agent: { color: '#10b981', hint: '协作 Agent' }
}

export interface Mention {
  displayText: string
  source: MentionSource
  path?: string
  startLine?: number
  endLine?: number
  startColumn?: number
  endColumn?: number
  /** 添加时的编辑缓冲区快照，不能让之后的保存/切换改变用户已经引用的内容。 */
  content?: string
  /** 草稿恢复时准确区分引用 chip 与用户手工输入的同名 @ 文本。 */
  textOffset?: number
}

/** 一枚引用的机器数据（藏在正文末尾的 HTML 注释里） */
export interface PromptRef {
  /** 引用类型 */
  t: MentionSource
  /** 相对路径（终端引用为落地的临时文件路径） */
  p: string
  /** 标签上显示的文字（不含 @，与输入框 chip 一致） */
  d: string
  /** 在正文里的起始字符下标（替换后） */
  s: number
  /** 在正文里的结束字符下标（不含） */
  e: number
  /** 行号范围 [起, 止]，仅源码引用 */
  r?: [number, number]
  /** 列号范围 [起, 止]，仅源码引用；用于精确回填选区。 */
  c?: [number, number]
}

/** 机器数据行前缀（HTML 注释，正文里对模型是噪声但无害） */
const REF_DATA_PREFIX = '<!--aether-refs:'
const REF_DATA_SUFFIX = '-->'
// Only our final single-line footer is metadata. Similar text inside a snapshot
// is user data and must survive display, draft recovery and retransmission.
const REF_DATA_RE = /\n<!--aether-refs:([^\r\n]*)-->[ \t]*(?:\r?\n)?$/

/**
 * 旧版发送协议在正文末尾追加的说明块。
 *
 * 新版改成原位替换后这条路径已不再产出，但历史消息里还在——展示和回填都要在此截断，
 * 否则用户会看到「以下为添加到对话时的编辑器内容快照…」这种内部说明。
 */
export const LEGACY_SNAPSHOT_MARKER = '\n\n以下为添加到对话时的编辑器内容快照，可能包含未保存修改：'

/** `<reference …>…</reference>` 结构化块（捕获类型 / 路径 / 行号区间 / 块内原文） */
const REF_BLOCK_RE =
  /<reference type="(file|code|terminal)" path="([^"]*)"(?: lines="(\d+)-(\d+)")?(?: columns="(\d+)-(\d+)")?>\n(`{3,})([^\r\n]*)\n([\s\S]*?)\n\7\n<\/reference>/g

/** 常见后缀 → 代码围栏语言标识（拿不到就留空，围栏照样成立） */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', md: 'md', css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', ps1: 'powershell', bat: 'bat',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', sql: 'sql', xml: 'xml'
}

export function mentionToken(mention: Mention): string {
  if (!mention.path) return mention.displayText
  if (mention.source === 'code' && mention.startLine) {
    const range = mention.endLine && mention.endLine !== mention.startLine
      ? `${mention.startLine}-${mention.endLine}` : `${mention.startLine}`
    return `@${mention.path}:${range}`
  }
  return `@${mention.path}`
}

export function formatPathDisplay(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  return parts.length <= 2 ? normalized : parts.slice(-2).join('/')
}

/** 引用 chip 的悬停提示：给出类型、真实路径与行号区间 */
export function mentionTitle(mention: Pick<Mention, 'source' | 'path' | 'startLine' | 'endLine' | 'content'>): string {
  const hint = MENTION_META[mention.source].hint
  const head = mention.path ? `${hint}：${mention.path}` : hint
  const lines = mention.startLine
    ? `\n第 ${mention.startLine}${mention.endLine && mention.endLine !== mention.startLine ? `-${mention.endLine}` : ''} 行`
    : ''
  return `${head}${lines}${mention.content !== undefined ? '\n包含添加时的内容快照' : ''}`
}

export function sameMention(a: Mention, b: Mention): boolean {
  return a.source === b.source && a.path === b.path && a.startLine === b.startLine &&
    a.endLine === b.endLine && a.startColumn === b.startColumn && a.endColumn === b.endColumn &&
    a.content === b.content && a.displayText === b.displayText
}

export function isStoredMention(value: unknown): value is Mention {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.displayText === 'string' &&
    ['file', 'dir', 'code', 'terminal', 'agent'].includes(String(record.source)) &&
    ['path', 'content'].every((key) => record[key] === undefined || typeof record[key] === 'string') &&
    ['startLine', 'endLine', 'startColumn', 'endColumn', 'textOffset'].every((key) =>
      record[key] === undefined || (typeof record[key] === 'number' && Number.isInteger(record[key]) && Number(record[key]) >= 0))
}

// ==================== 发送：原位替换 + 机器数据 ====================

function langFor(path: string): string {
  const ext = path.replace(/\\/g, '/').split('.').pop()?.toLowerCase() ?? ''
  return LANG_BY_EXT[ext] ?? ''
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fenceFor(content: string): string {
  let longest = 0
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * 把一枚引用格式化成「替换进正文」的原数据文本。
 *
 * 用 <reference> 把原数据包成结构化块：用户的话和引用数据在模型眼里必须边界清晰，
 * 否则模型会把句子里的 `@xxx` 标签当成提问对象去解释语法。标签显示文字不放进替换内容
 * ——气泡与回填靠机器数据里的 d 还原，不靠它。
 *
 * 返回 undefined 表示目录/协作 Agent，保留标签；空字符串是有效快照。
 */
export function formatReferenceBlock(mention: Mention, content: string): string | undefined {
  if (mention.source !== 'file' && mention.source !== 'code' && mention.source !== 'terminal') return undefined
  const path = escapeAttr(mention.path ?? '')
  const type = mention.source
  const lines = mention.source === 'code' && mention.startLine
    ? ` lines="${mention.startLine}-${mention.endLine ?? mention.startLine}"` : ''
  const columns = mention.source === 'code' && mention.startColumn
    ? ` columns="${mention.startColumn}-${mention.endColumn ?? mention.startColumn}"` : ''
  const fence = fenceFor(content)
  const language = mention.source === 'code' ? langFor(mention.path ?? '') : ''
  return `<reference type="${type}" path="${path}"${lines}${columns}>\n${fence}${language}\n${content}\n${fence}\n</reference>`
}

/** 在正文里定位每枚引用的 token 区间；textOffset 对不上时从上一枚之后重新查找 */
function locateMentions(
  text: string,
  mentions: readonly Mention[]
): { mention: Mention; start: number; end: number }[] {
  const located: { mention: Mention; start: number; end: number }[] = []
  let cursor = 0
  for (const mention of mentions) {
    // 协作 Agent 不进正文协议：它的配置走单独通道，标签保持原样即可
    if (mention.source === 'agent') continue
    const token = mentionToken(mention)
    if (!token) continue
    const anchored = mention.textOffset
    const start = anchored !== undefined && anchored >= cursor &&
      text.slice(anchored, anchored + token.length) === token
      ? anchored
      : text.indexOf(token, cursor)
    if (start < cursor || start < 0) continue
    located.push({ mention, start, end: start + token.length })
    cursor = start + token.length
  }
  return located
}

/**
 * 组装最终发送文本：正文里的标签原位替换成原数据，末尾挂一行机器数据注释。
 *
 * 注释里的下标基于**替换后**的正文；没有任何引用时返回 trim 后的正文，不挂注释。
 *
 * 两处归一化都在这里做，调用方不必操心：
 *   - **空白**：token 与相邻文字之间保证有且只有一个空白。输入框里 chip 自带一个空格
 *     文本节点，但用户删掉那个空格后 DOM 就变得紧贴，正文里 `@a/b.ts在帮我改` 这种边界
 *     谁也认不出来。放在这里而不是序列化里，是为了让输入框 DOM 与文本镜像始终一一对应。
 *   - **首尾空白**：引用下标基于未 trim 的文本，直接 trim 会让下标整体错位，所以按
 *     trim 掉的头部长度平移一次。
 */
export function buildMentionMessage(text: string, mentions: readonly Mention[]): string {
  const lead = text.length - text.trimStart().length
  const body = text.trim()
  if (!mentions.length || !body) return body
  const shifted = mentions.map((mention) =>
    mention.textOffset === undefined ? mention : { ...mention, textOffset: mention.textOffset - lead }
  )
  const located = locateMentions(body, shifted)
  if (!located.length) return body

  const refs: PromptRef[] = []
  let out = ''
  let cursor = 0
  let afterRef = false
  for (const { mention, start, end } of located) {
    if (start < cursor) continue
    const prefix = body.slice(cursor, start)
    if (afterRef && prefix && !/^\s/.test(prefix)) out += ' '
    out += prefix
    if (out && !/\s$/.test(out)) out += ' '
    const refStart = out.length
    const block = (mention.content !== undefined ? formatReferenceBlock(mention, mention.content) : undefined)
      ?? body.slice(start, end)
    out += block
    refs.push({
      t: mention.source,
      p: mention.path ?? '',
      d: mention.displayText,
      s: refStart,
      e: refStart + block.length,
      ...(mention.source === 'code' && mention.startLine
        ? { r: [mention.startLine, mention.endLine ?? mention.startLine] as [number, number] }
        : {}),
      ...(mention.source === 'code' && mention.startColumn
        ? { c: [mention.startColumn, mention.endColumn ?? mention.startColumn] as [number, number] }
        : {})
    })
    cursor = end
    afterRef = true
  }
  const tail = body.slice(cursor)
  // 后一个字符不是空白就补一个（行尾 / 已有空白 / 换行都不补）
  if (afterRef && tail && !/^\s/.test(tail)) out += ' '
  out += tail
  if (!refs.length) return body
  // A path/display label can itself contain HTML comment terminators.
  const metadata = JSON.stringify(refs).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  return `${out}\n${REF_DATA_PREFIX}${metadata}${REF_DATA_SUFFIX}`
}

// ==================== 接收：正文 + 引用列表 ====================

/** 校验一条机器数据的形状（只看结构，下标是否落在正文内交给调用方） */
function isValidRefShape(value: unknown): value is PromptRef {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (!['file', 'dir', 'code', 'terminal', 'agent'].includes(String(r.t))) return false
  if (typeof r.p !== 'string' || typeof r.d !== 'string') return false
  if (typeof r.s !== 'number' || typeof r.e !== 'number') return false
  if (!Number.isInteger(r.s) || !Number.isInteger(r.e)) return false
  const pair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 &&
    value.every(item => Number.isSafeInteger(item) && item > 0)
  if (r.r !== undefined && (!pair(r.r) || r.r[1] < r.r[0])) return false
  // Monaco ranges may end at a smaller column when the selection spans lines
  // (for example `2:10` → `3:2`). Only same-line ranges have an ordering
  // constraint; cross-line ranges are valid and must survive replay.
  if (r.c !== undefined && (!pair(r.c) || (r.r?.[0] === r.r?.[1] && r.c[1] < r.c[0]))) return false
  return r.s >= 0 && r.s < r.e
}

/** 剥掉围栏行，取出 <reference> 块里的原文 */
function unfence(inner: string): string {
  const lines = inner.split('\n')
  const fence = /^(`{3,})[^`\r\n]*$/.exec(lines[0])?.[1]
  if (lines.length >= 2 && fence && lines[lines.length - 1] === fence) {
    return lines.slice(1, -1).join('\n')
  }
  return inner
}

/**
 * 兜底：机器数据注释缺失时，直接扫正文里的 <reference> 块重建引用下标。
 *
 * 引擎侧若对历史正文做过 trim 之类的规整，末尾那行注释可能已经不在、或下标整体偏移，
 * 此时若不兜底，「回填输入框」会把整块原数据当正文塞回去，把输入框挤满。
 */
export function recoverRefsFromReferenceBlocks(body: string): PromptRef[] {
  const out: PromptRef[] = []
  REF_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = REF_BLOCK_RE.exec(body)) !== null) {
    const type = match[1] as 'file' | 'code' | 'terminal'
    const path = match[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    const startLine = match[3] ? Number(match[3]) : undefined
    const endLine = match[4] ? Number(match[4]) : undefined
    const startColumn = match[5] ? Number(match[5]) : undefined
    const endColumn = match[6] ? Number(match[6]) : undefined
    const display = type === 'code'
      ? `@${formatPathDisplay(path)}${startLine ? `:${startLine}${endLine && endLine !== startLine ? `-${endLine}` : ''}` : ''}`
      : `@${formatPathDisplay(path)}`
    out.push({
      t: type,
      p: path,
      d: display.replace(/^@/, ''),
      s: match.index,
      e: match.index + match[0].length,
      ...(type === 'code' && startLine ? { r: [startLine, endLine ?? startLine] as [number, number] } : {}),
      ...(type === 'code' && startColumn ? { c: [startColumn, endColumn ?? startColumn] as [number, number] } : {})
    })
  }
  return out
}

/**
 * 从一条已发送的消息正文里还原出「正文 + 引用列表」。
 *
 * 摘除机器数据注释后**不做任何 trim / 空行压缩**——那会改动正文长度，让注释里的下标错位。
 * 旧协议（正文末尾追加说明块）在此截断，历史消息不会再把内部说明显示出来。
 */
export function parseMentionContent(content: string): { body: string; refs: PromptRef[] } {
  const full = content ?? ''
  let body = full
  let dataText: string | null = null

  const dataMatch = REF_DATA_RE.exec(full)
  if (dataMatch) {
    body = full.slice(0, dataMatch.index) + full.slice(dataMatch.index + dataMatch[0].length)
    dataText = dataMatch[1]
  }

  // 旧协议的说明块：截断即可（该格式从不产出下标数据，没有错位风险）
  const blocks = recoverRefsFromReferenceBlocks(body)
  const legacy = body.indexOf(LEGACY_SNAPSHOT_MARKER)
  if (dataText === null && legacy !== -1 && !blocks.some(ref => ref.s <= legacy && ref.e > legacy)) body = body.slice(0, legacy)

  if (dataText === null) return { body, refs: recoverRefsFromReferenceBlocks(body) }

  let parsed: unknown
  try {
    parsed = JSON.parse(dataText)
  } catch {
    return { body, refs: recoverRefsFromReferenceBlocks(body) }
  }
  if (!Array.isArray(parsed)) return { body, refs: recoverRefsFromReferenceBlocks(body) }

  const refs: PromptRef[] = []
  let searchFrom = 0
  for (const candidate of parsed.filter(isValidRefShape).sort((a, b) => a.s - b.s)) {
    if (candidate.s < searchFrom || candidate.e > body.length) continue
    const isBlock = blocks.some(ref => ref.s === candidate.s && ref.e === candidate.e && ref.t === candidate.t && ref.p === candidate.p)
    if (!isBlock && body.slice(candidate.s, candidate.e) !== mentionToken(refToMention(candidate))) continue
    refs.push({ ...candidate })
    searchFrom = candidate.e
  }
  // Recover each lost/shifted block, even when other metadata ranges remain valid.
  for (const block of blocks) {
    if (!refs.some(ref => ref.s < block.e && ref.e > block.s)) refs.push(block)
  }
  return { body, refs: refs.sort((a, b) => a.s - b.s) }
}

/** 引用区间在原数据块里的原文（回填时把快照一起带回去，不必重新读盘） */
function contentFromBody(body: string, ref: PromptRef): string | undefined {
  if (ref.t !== 'file' && ref.t !== 'code' && ref.t !== 'terminal') return undefined
  const slice = body.slice(ref.s, ref.e)
  const match = /^<reference [^>]*>\n([\s\S]*)\n<\/reference>$/.exec(slice)
  return match ? unfence(match[1]) : undefined
}

/** 机器数据 → 输入框引用（气泡 chip 与回填共用） */
export function refToMention(ref: PromptRef, content?: string): Mention {
  return {
    displayText: ref.d,
    source: ref.t,
    ...(ref.p ? { path: ref.p } : {}),
    ...(ref.r ? { startLine: ref.r[0], endLine: ref.r[1] } : {}),
    ...(ref.c ? { startColumn: ref.c[0], endColumn: ref.c[1] } : {}),
    ...(content !== undefined ? { content } : {})
  }
}

/**
 * 正文 + 引用列表 → 「带 @token 占位符的纯文本 + 引用列表」。
 *
 * 这是回填输入框和保存草稿共用的形态：MentionInput 的 setDraft 按 textOffset 把 token
 * 还原成 chip。区间里的原数据在文本里被换回 token，所以拿到的文本与用户当初输入的一致。
 */
export function sourceTextFromBody(
  body: string,
  refs: readonly PromptRef[]
): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = []
  let out = ''
  let cursor = 0
  for (const ref of refs) {
    if (ref.s < cursor) continue
    out += body.slice(cursor, ref.s)
    const mention = refToMention(ref, contentFromBody(body, ref))
    mentions.push({ ...mention, textOffset: out.length })
    out += mentionToken(mention)
    cursor = ref.e
  }
  out += body.slice(cursor)
  return { text: out, mentions }
}

/** 用户消息的可编辑形态（回填输入框 / 保存草稿） */
export function userMessageDraft(content: string): { text: string; mentions: Mention[] } {
  const { body, refs } = parseMentionContent(content)
  return sourceTextFromBody(body, refs)
}

/** 用户消息的展示形态：正文里引用是「显示文字」，正文外的东西都不该露出来 */
export function userMessageText(content: string): string {
  const draft = userMessageDraft(content)
  return draft.text.replace(/\s+$/, '')
}

/** 润色只能改提问文字，不能把已经添加的文件/代码快照变成失去元数据的字符串。 */
export function preserveMentions(text: string, mentions: readonly Mention[]): { text: string; mentions: Mention[] } {
  let result = text
  let cursor = 0
  const anchored = mentions.map((mention) => {
    const token = mentionToken(mention)
    let offset = result.indexOf(token, cursor)
    if (offset < 0) {
      result += result.endsWith('\n') ? '' : '\n'
      offset = result.length
      result += token
    }
    cursor = offset + token.length
    return { ...mention, textOffset: offset }
  })
  return { text: result, mentions: anchored }
}
