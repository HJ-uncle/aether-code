import { useMemo, type JSX } from 'react'
import { Marked, type Token, type Tokens } from 'marked'
import hljs from 'highlight.js'
import { Icon } from '@renderer/workbench/icons'

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
        return (
          <a
            key={key}
            href={token.href}
            title={token.title ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInline(token.tokens, key)}
          </a>
        )
      case 'image':
        return <img key={key} src={token.href} alt={token.text} title={token.title ?? undefined} />
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
          <Icon name="copy" size={12} />
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

export function Markdown({ text }: { text: string }): JSX.Element {
  const tokens = useMemo(() => {
    const marked = new Marked({ gfm: true, breaks: false })
    return marked.lexer(text)
  }, [text])
  return <div className="md">{renderBlock(tokens, 'md')}</div>
}
