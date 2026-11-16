import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import { pages } from '../pages.mjs'

export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const destination = path.join(project, 'dist')
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const decode = value => value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos);/gi, (_, entity) => entity.startsWith('#')
  ? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
  : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()])
const plain = value => decode(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
for (const [name, language] of Object.entries({ javascript, typescript, json, xml, css })) hljs.registerLanguage(name, language)
function headings(content) {
  return [...content.matchAll(/<h([23])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)].map(match => ({ level: Number(match[1]), id: match[2], title: plain(match[3]), at: match.index, end: match.index + match[0].length }))
}
function highlight(content) {
  return content.replace(/<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g, (original, language, source) => {
    const name = ({ js: 'javascript', ts: 'typescript', html: 'xml' })[language] ?? language
    if (!hljs.getLanguage(name)) return original
    return `<pre><code class="language-${language} hljs">${hljs.highlight(decode(source), { language: name, ignoreIllegals: true }).value}</code></pre>`
  }).replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-scroll" tabindex="0" role="region" aria-label="参考表格"><table>$1</table></div>')
}
export function build() {
  const template = fs.readFileSync(path.join(project, 'template.html'), 'utf8')
  const contents = new Map(pages.map(page => [page.id, fs.readFileSync(path.join(project, 'content', `${page.id}.html`), 'utf8')]))
  const searchIndex = pages.flatMap(page => {
    const content = contents.get(page.id)
    const sections = headings(content)
    return [{ title: page.label, section: '', href: page.file, text: `${page.summary} ${plain(content.slice(0, sections[0]?.at ?? content.length))}` }, ...sections.map((section, index) => ({ title: page.label, section: section.title,
      href: `${page.file}#${section.id}`, text: plain(content.slice(section.end, sections[index + 1]?.at ?? content.length)) }))]
  })
  const files = new Map()
  for (const [index, page] of pages.entries()) {
    const navigation = `<nav aria-label="文档导航">${[...new Set(pages.map(item => item.group))].map(group => `<section class="nav-group"><h2>${escape(group)}</h2>${pages.filter(item => item.group === group).map(item => `<a class="nav-link${item.id === page.id ? ' is-active' : ''}"${item.id === page.id ? ' aria-current="page"' : ''} href="${escape(item.file)}">${escape(item.label)}</a>`).join('')}</section>`).join('')}</nav>`
    const sections = headings(contents.get(page.id))
    const toc = sections.length ? `<nav aria-label="本页目录"><h2>本页内容</h2><ol>${sections.map(item => `<li class="toc-level-${item.level}"><a href="#${escape(item.id)}">${escape(item.title)}</a></li>`).join('')}</ol></nav>` : ''
    const pagination = [[pages[index - 1], 'previous', '上一页'], [pages[index + 1], 'next', '下一页']].flatMap(([item, kind, label]) => item ? [`<a class="page-link ${kind}" href="${escape(item.file)}"><span>${label}</span><strong>${escape(item.label)}</strong></a>`] : []).join('')
    const replacements = { title: escape(page.title), description: escape(page.summary), pageId: page.id, navigation, toc, pagination,
      content: highlight(contents.get(page.id)), searchIndex: JSON.stringify(searchIndex).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026') }
    const html = template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      if (!Object.hasOwn(replacements, name)) throw new Error(`Unknown template field: ${name}`)
      return replacements[name]
    })
    if (!page.file.endsWith('.html') || path.basename(page.file) !== page.file) throw new Error('Page filenames must be local HTML filenames')
    files.set(page.file, html)
  }
  for (const name of fs.readdirSync(path.join(project, 'assets'))) {
    const source = path.join(project, 'assets', name)
    if (fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) throw new Error(`Assets must be ordinary files: ${name}`)
    files.set(`assets/${name}`, fs.readFileSync(source))
  }
  fs.mkdirSync(destination, { recursive: true })
  // Only remove old files previously generated here; never recursively delete an output directory.
  const inventory = path.join(destination, '.generated-files.json')
  const previous = fs.existsSync(inventory) ? JSON.parse(fs.readFileSync(inventory, 'utf8')) : []
  for (const name of previous) {
    const target = path.resolve(destination, name)
    if (!target.startsWith(destination + path.sep) || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('Invalid generated file inventory')
    if (!files.has(name) && fs.existsSync(target)) {
      if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isFile()) throw new Error('Refusing to remove non-file output')
      fs.unlinkSync(target)
    }
  }
  for (const [name, value] of files) {
    const target = path.join(destination, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
  }
  fs.writeFileSync(inventory, JSON.stringify([...files.keys()], null, 2) + '\n')
  console.log(`Aether 插件 API 参考：${pages.length} 页，${searchIndex.length} 个搜索条目 → docs/plugin-api/dist/`)
  return { pages: pages.length, searchEntries: searchIndex.length }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build()
