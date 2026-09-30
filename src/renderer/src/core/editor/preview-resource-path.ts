import { fileIdentity } from './file-identity'

function fileUrl(path: string): URL {
  const normalized = path.replace(/\\/g, '/')
  const encoded = normalized.split('/').map(encodeURIComponent).join('/')
  return new URL(normalized.startsWith('//') ? `file:${encoded}` : `file://${normalized.startsWith('/') ? '' : '/'}${encoded}`)
}

/** Resolve only local project resources; a preview never expands the user's filesystem grant. */
export function resolvePreviewResource(filePath: string, reference: string, workspaceRoot: string): string | null {
  if (!workspaceRoot || !reference.trim() || /[\u0000-\u001f]/.test(reference)) return null
  try {
    const source = reference.replace(/\\/g, '/')
    const base = fileUrl(filePath)
    const resolved = /^[a-z]:\//i.test(source) ? fileUrl(source) : new URL(source, base)
    if (resolved.protocol !== 'file:') return null
    let path = decodeURIComponent(resolved.pathname)
    if (resolved.hostname) path = `//${resolved.hostname}${path}`
    else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
    // An encoded slash can introduce dot segments after URL's own normalization.
    const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : ''
    const segments: string[] = []
    for (const part of path.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') { if (!segments.length) return null; segments.pop() }
      else segments.push(part)
    }
    path = prefix + segments.join('/')
    const root = fileIdentity(workspaceRoot).replace(/\/+$/, '')
    const identity = fileIdentity(path)
    return identity.startsWith(root + '/') ? path : null
  } catch {
    return null
  }
}
