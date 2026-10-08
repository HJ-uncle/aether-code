export interface ChatFileContext {
  sessionId: string
  workspaceRoot?: string | null
}

export type ChatLinkTarget =
  | { kind: 'artifact'; sessionId: string; path: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'file'; path: string }
  | { kind: 'external' }

const ARTIFACT_ENDPOINT = '/api/v1/workspace/file/download'

/** Recognize the engine protocol before extensions: its query may end in .html. */
export function classifyChatLink(href: string, sessionId?: string, engineBaseUrl?: string): ChatLinkTarget {
  const external: ChatLinkTarget = { kind: 'external' }
  let url: URL | undefined
  const relativeApi = href.startsWith('/api/')
  if (relativeApi || /^https?:\/\//i.test(href)) {
    try { url = new URL(href, 'https://artifact.invalid') } catch { return external }
    if (!relativeApi) {
      try { if (!engineBaseUrl || url.origin !== new URL(engineBaseUrl).origin) return external } catch { return external }
    }
    if (url.pathname !== ARTIFACT_ENDPOINT) return external
    const invalid = (message: string): ChatLinkTarget => ({ kind: 'invalid', message })
    if (url.username || url.password || url.hash || /%(?![a-f\d]{2})/i.test(url.search) ||
        url.searchParams.getAll('path').length !== 1 || url.searchParams.getAll('sessionId').length !== 1) {
      return invalid('文件链接参数无效，无法打开。')
    }
    const owner = url.searchParams.get('sessionId')!
    if (!sessionId || owner !== sessionId) return invalid('文件链接不属于这条消息所在的会话，已阻止打开。')
    const path = url.searchParams.get('path')!.replace(/\\/g, '/')
    if (!path || path.startsWith('/') || /[\u0000-\u001f\u007f:*?"<>|]/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..')) {
      return invalid('文件链接指向工作区外或无效路径，已阻止打开。')
    }
    return { kind: 'artifact', sessionId: owner, path }
  }
  if (!href || href.startsWith('#') || href.startsWith('//') ||
      (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href))) return external
  return /\.[A-Za-z0-9]{1,10}(:\d+(:\d+)?)?$/.test(href) ? { kind: 'file', path: href } : external
}

/** The artifact path is already URL-decoded; literal percent/hash are filenames. */
export function resolveArtifactPath(path: string, root: string | null | undefined): string {
  if (!root || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(root)) {
    throw new Error('这条消息没有可用的工作区目录，请先打开所属项目。')
  }
  return `${root.replace(/[/\\]+$/, '')}/${path}`
}
