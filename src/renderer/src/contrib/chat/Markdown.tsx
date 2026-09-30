import { memo, useMemo, type JSX } from 'react'
import { Marked, type Token, type Tokens } from 'marked'
import hljs from 'highlight.js'
import { Icon } from '@renderer/workbench/icons'
import { openFileFromChat } from './open-file'
import { useApp } from '@renderer/core/app-context'

/** 链接 href 是否指向本地文件（而非 http 外链/锚点）：模型常用 [名字](path/to/file.ts) 引用代码 */
function looksLikeFileHref(href: string): boolean {
  if (!href) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) {
    // 有协议前缀（http:、mailto: 等）的是外链；Windows 盘符 C:\ 除外
    return false
  }
  if (href.startsWith('#')) return false
  // 得带扩展名才算文件引用，避免把普通锚文本误判
  return /\.[A-Za-z0-9]{1,10}(:\d+(:\d+)?)?$/.test(href)
}

/**
 * Markdown 渲染（助手正文专用）
 *
 * 项目没有引入 react-markdown 之类的重型方案：marked 把文本解析成 token 流，
 * 这里直接把 token 映射成 React 元素 —— 不经过 dangerouslySetInnerHTML，
 * XSS 面天然为零，代码高亮在渲染代码块时同步完成（highlight.js）。
 *
 * 每个组件实例独立持有一个 Marked 实例（不走全局单例），
 * 避免多个消息并发渲染时互相污染内部状态。
 */

/** 语言别名归一：模型常写 js/ts/shell 这类短名，highlight.js 需要规范名 */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  py: 'python',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  vue: 'xml',
  html: 'xml'
}

function normalizeLang(lang: string | undefined): string {
  if (!lang) return ''
  const lower = lang.trim().toLowerCase().split(/\s/)[0]
  return LANG_ALIAS[lower] ?? lower
}

/** 代码高亮：语言未知或高亮失败时退回 HTML 转义的纯文本，绝不让高亮异常弄丢内容 */
function highlight(code: string, lang: string): string {
  const normalized = normalizeLang(lang)
  try {
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
    }
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 复制代码到剪贴板；成功时临时把按钮切成对勾（由调用方通过 DOM 操作完成，不引入状态） */
function copyCode(event: React.MouseEvent<HTMLButtonElement>): void {
  const button = event.currentTarget
  const pre = button.closest('.md-code')?.querySelector('pre')
  const text = pre?.textContent ?? ''
  if (!text) return
  void navigator.clipboard.writeText(text).then(() => {
    button.classList.add('md-code__copy--ok')
    window.setTimeout(() => button.classList.remove('md-code__copy--ok'), 1600)
  })
}

function ChatLink({ token, prefix }: { token: Tokens.Link; prefix: string }): JSX.Element {
  const { engine } = useApp()
  const href = token.href ?? ''
  const local = looksLikeFileHref(href)
  const remoteFile = !href.startsWith('#') && !/^(?:https?:|mailto:|tel:)/i.test(href)
  if (engine.snapshot.mode === 'remote' && remoteFile) {
    return <span title={`远端路径（尚未映射）：${href}`}>{renderInline(token.tokens, prefix)}</span>
  }
  if (local) {
    return <a href={href} title={`在编辑器中打开 ${href}`} onClick={(event) => {
      event.preventDefault()
      void openFileFromChat(href)
    }}>{renderInline(token.tokens, prefix)}</a>
  }
  return <a href={href} title={token.title ?? undefined} target="_blank" rel="noreferrer noopener">{renderInline(token.tokens, prefix)}</a>
}

function ChatImage({ token }: { token: Tokens.Image }): JSX.Element {
  const { engine } = useApp()
  if (engine.snapshot.mode === 'remote' && !/^(?:https?:|data:image\/)/i.test(token.href)) {
    return <span title={`远端图片路径（尚未映射）：${token.href}`}>{token.text || '远端图片'}（未加载）</span>
  }
  return <img src={token.href} alt={token.text} title={token.title ?? undefined} />
}

function renderInline(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode {
  if (!tokens) return null
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.type) {
      case 'text':
        return token.tokens ? renderInline(token.tokens, key) : token.text
      case 'strong':
        return <strong key={key}>{renderInline(token.tokens, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(token.tokens, key)}</em>
      case 'del':
        return <del key={key}>{renderInline(token.tokens, key)}</del>
      case 'codespan':
        return (
          <code key={key} className="md-inline-code">
            {token.text}
          </code>
        )
      case 'link':
        return <ChatLink key={key} token={token as Tokens.Link} prefix={key} />
      case 'image':
        return <ChatImage key={key} token={token as Tokens.Image} />
      case 'br':
        return <br key={key} />
      case 'escape':
        return token.text
      default:
        return 'raw' in token ? (token as { raw: string }).raw : null
    }
  })
}

function renderBlock(tokens: Token[], keyPrefix: string): React.ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.type) {
      case 'space':
        return null
      case 'heading':
        return (
          <HeadingBlock key={key} depth={token.depth}>
            {renderInline(token.tokens, key)}
          </HeadingBlock>
        )
      case 'paragraph':
        return <p key={key}>{renderInline(token.tokens, key)}</p>
      case 'code':
        return <CodeBlock key={key} token={token as Tokens.Code} />
      case 'blockquote':
        return (
          <blockquote key={key}>
            {renderBlock((token as Tokens.Blockquote).tokens ?? [], key)}
          </blockquote>
        )
      case 'list':
        return <ListBlock key={key} token={token as Tokens.List} prefix={key} />
      case 'hr':
        return <hr key={key} />
      case 'table':
        return <TableBlock key={key} token={token as Tokens.Table} prefix={key} />
      case 'html':
        // 原始 HTML 不注入（XSS 风险），原样当文本展示
        return (
          <p key={key}>
            <code className="md-inline-code">{token.text}</code>
          </p>
        )
      default:
        return 'raw' in token ? <p key={key}>{(token as { raw: string }).raw}</p> : null
    }
  })
}

function HeadingBlock({
  depth,
  children
}: {
  depth: number
  children: React.ReactNode
}): JSX.Element {
  switch (depth) {
    case 1:
      return <h1>{children}</h1>
    case 2:
      return <h2>{children}</h2>
    case 3:
      return <h3>{children}</h3>
    case 4:
      return <h4>{children}</h4>
    case 5:
      return <h5>{children}</h5>
    default:
      return <h6>{children}</h6>
  }
}

function CodeBlock({ token }: { token: Tokens.Code }): JSX.Element {
  const lang = normalizeLang(token.lang)
  const html = useMemo(() => highlight(token.text, token.lang ?? ''), [token.text, token.lang])
  return (
    <div className="md-code">
      <div className="md-code__header">
        <span className="md-code__lang">{lang || 'text'}</span>
        <button
          type="button"
          className="md-code__copy"
          title="复制代码"
          aria-label="复制代码"
          onClick={copyCode}
        >
          <Icon name="copy" size={16} />
        </button>
      </div>
      {/* 高亮 HTML 来自 highlight.js（纯文本着色，不含脚本），可以安全注入 */}
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

function ListBlock({ token, prefix }: { token: Tokens.List; prefix: string }): JSX.Element {
  const items = token.items.map((item, index) => (
    <li key={`${prefix}-${index}`} className={item.task ? 'md-task' : undefined}>
      {item.task ? (
        <input type="checkbox" checked={item.checked ?? false} disabled readOnly />
      ) : null}
      {item.tokens.length > 0 && item.tokens[0].type === 'text'
        ? // 松散列表项的段落会拆成多段；首段若是纯文本就内联渲染，避免多一层 <p> 的上下边距
          renderInline((item.tokens[0] as Tokens.Text).tokens, `${prefix}-${index}`)
        : renderBlock(item.tokens, `${prefix}-${index}`)}
    </li>
  ))
  return token.ordered ? (
    <ol start={typeof token.start === 'number' && token.start > 0 ? token.start : undefined}>
      {items}
    </ol>
  ) : (
    <ul>{items}</ul>
  )
}

function TableBlock({ token, prefix }: { token: Tokens.Table; prefix: string }): JSX.Element {
  return (
    <div className="md-table-wrap">
      <table>
        <thead>
          <tr>
            {token.header.map((cell, index) => (
              <th key={`${prefix}-h-${index}`}>
                {renderInline(cell.tokens, `${prefix}-h-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, rowIndex) => (
            <tr key={`${prefix}-r-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${prefix}-r-${rowIndex}-c-${cellIndex}`}>
                  {renderInline(cell.tokens, `${prefix}-r-${rowIndex}-c-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 流式增量解析：把文本切成「稳定前缀」与「增量尾部」。
 *
 * 流式期间 text 每帧都在末尾追加，全量 re-lex 会让 O(n²) 解析压垮长回复。
 * 观察：只有「双换行结尾、且不在未闭合代码围栏内」的前缀是稳定的（段落已封口），
 * 其 token 不会随后续文本改变。把这部分缓存复用，每帧只解析变化的尾部。
 */

/** 数 fence（``` 或 ~~~）开闭：返回文本末尾是否处于未闭合围栏内 */
function inOpenFence(text: string): boolean {
  // 行首（可带 ≤3 空格）的 ``` 或 ~~~ 序列；marked 的 GFM 规则
  const fenceRe = /^ {0,3}(`{3,}|~{3,})/gm
  let count = 0
  while (fenceRe.exec(text) !== null) count += 1
  return count % 2 === 1
}

/**
 * 找稳定切点：最后一个「后面紧跟非空内容、且此前围栏全闭合」的双换行位置。
 * 返回稳定前缀的长度（不含尾部）；无稳定点时返回 0。
 */
function stablePrefixLength(text: string): number {
  // 候选切点：\n\n（空行簇）。连续空行整体并入前缀，使切点落在空行簇末尾，
  // 避免 space token 的 raw 被从中间切开（`\n\n\n` → 前缀 `\n\n` + 尾部 `\n`）。
  let cut = 0
  let idx = text.indexOf('\n\n')
  while (idx !== -1) {
    let end = idx + 2
    // 吸收紧随其后的所有换行（\n\n\n、\n\n\n\n …），切点推到空行簇末尾
    while (end < text.length && text[end] === '\n') end += 1
    // 前缀到切点为止必须围栏闭合，否则切开的代码块会解析错
    if (end < text.length && !inOpenFence(text.slice(0, end))) cut = end
    idx = text.indexOf('\n\n', end)
  }
  return cut
}

/** 单例 lexer：Marked 实例无可变状态依赖文本，可安全复用 */
const sharedMarked = new Marked({ gfm: true, breaks: false })

function lex(text: string): Token[] {
  return sharedMarked.lexer(text)
}

/** 解析缓存：前缀文本 → 前缀 tokens（用 Map 做简易 LRU，上限 8 条防内存膨胀） */
const prefixCache = new Map<string, Token[]>()
const PREFIX_CACHE_LIMIT = 8

function cachedLexPrefix(prefix: string): Token[] {
  const hit = prefixCache.get(prefix)
  if (hit) {
    // LRU：命中后移到末尾
    prefixCache.delete(prefix)
    prefixCache.set(prefix, hit)
    return hit
  }
  const tokens = lex(prefix)
  prefixCache.set(prefix, tokens)
  if (prefixCache.size > PREFIX_CACHE_LIMIT) {
    // 删最旧（Map 迭代按插入序）
    const oldest = prefixCache.keys().next().value
    if (oldest !== undefined) prefixCache.delete(oldest)
  }
  return tokens
}

/**
 * 增量 tokenize：稳定前缀走缓存，尾部实时解析，拼成完整 token 流。
 * 非流式（一次性文本）时前缀就是全文减去最后一段，同样受益。
 */
function tokenizeIncremental(text: string): Token[] {
  if (!text) return []
  const cut = stablePrefixLength(text)
  if (cut === 0) return lex(text)
  const prefix = text.slice(0, cut)
  const tail = text.slice(cut)
  const head = cachedLexPrefix(prefix)
  const tailTokens = tail ? lex(tail) : []
  return [...head, ...tailTokens]
}

export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  const tokens = useMemo(() => tokenizeIncremental(text), [text])
  return <div className="md">{renderBlock(tokens, 'md')}</div>
})
