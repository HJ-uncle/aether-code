import hljs from 'highlight.js'
import type { EngineFileChange } from '@shared/ipc'

/** Keep the inline preview readable without making a single file fill the conversation. */
export const FILE_CHANGE_PREVIEW_ROWS = 60

export function fileChangeInitiallyCollapsed(change: Pick<EngineFileChange, 'kind'>): boolean {
  return change.kind === 'delete'
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', mdx: 'markdown', yaml: 'yaml', yml: 'yaml',
  py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
  toml: 'ini', ini: 'ini', conf: 'ini', dockerfile: 'dockerfile'
}

export function fileChangeLanguage(path: string): string | undefined {
  const name = path.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  return LANGUAGE_BY_EXTENSION[name.split('.').at(-1) ?? '']
}

function escapeCode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Only highlight known languages; guessing a large plain-text diff is costly and misleading. */
export function highlightFileChangeLine(text: string, language: string | undefined): string {
  if (!language || text.length > 8_000 || !hljs.getLanguage(language)) return escapeCode(text)
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return escapeCode(text)
  }
}
