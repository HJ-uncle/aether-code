import type { WorkArtifact } from './work-state'

function cleanPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Prefer a rooted exact match; basename/suffix matches must be unambiguous. */
export function findWorkArtifact(artifacts: WorkArtifact[], path: string, root?: string | null): WorkArtifact | null {
  const target = cleanPath(path)
  const rooted = /^(?:[A-Za-z]:\/|\/)/.test(target) ? target : root ? `${cleanPath(root)}/${target}` : target
  const equal = (left: string, right: string): boolean => /^[A-Za-z]:\//.test(left) ? left.toLowerCase() === right.toLowerCase() : left === right
  const exact = artifacts.filter((item) => equal(cleanPath(item.path), rooted) || equal(cleanPath(item.path), target))
  if (exact.length) return exact.sort((a, b) => b.createdAt - a.createdAt)[0]
  if (/^(?:[A-Za-z]:\/|\/)/.test(target)) return null
  const matches = artifacts.filter((item) => cleanPath(item.path).endsWith('/' + target))
  const paths = new Set(matches.map((item) => cleanPath(item.path)))
  return paths.size === 1 ? matches.sort((a, b) => b.createdAt - a.createdAt)[0] : null
}

/** A longer fence keeps code containing Markdown fences inside its code block. */
export function workSourceMarkdown(content: string, filename: string): string {
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  const language = filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? 'text'
  return `${fence}${language}\n${content}\n${fence}`
}
