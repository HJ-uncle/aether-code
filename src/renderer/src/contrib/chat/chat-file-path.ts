export interface ResolvedChatPath {
  filePath: string
  line?: number
  column?: number
}

/** Resolve chat file references without consulting the renderer or filesystem. */
export function resolveChatPath(rawPath: string, workspaceRoot: string | null): ResolvedChatPath | null {
  let text = rawPath.trim().replace(/^[`'"<]+|[`'">]+$/g, '')
  if (!text) return null
  // A bare drive or drive-relative path needs Windows' per-drive working directory;
  // joining it to the workspace would silently select an unrelated local path.
  if (/^[A-Za-z]:(?![\\/])/.test(text)) return null

  let line: number | undefined
  let column: number | undefined
  const lineMatch = /:(\d+)(?::(\d+))?$/.exec(text)
  if (lineMatch) {
    const before = text.slice(0, lineMatch.index)
    if (before) {
      line = Number(lineMatch[1])
      column = lineMatch[2] ? Number(lineMatch[2]) : undefined
      text = before
    }
  }

  if (!isAbsolutePath(text)) {
    if (!workspaceRoot || !isAbsolutePath(workspaceRoot)) return null
    // Keep separators and literal %, # and Unicode intact. The main process resolves
    // dot segments and checks authorization; this layer must not treat paths as URLs.
    text = `${workspaceRoot.replace(/[/\\]+$/, '')}/${text.replace(/^[/\\]+|[/\\]+$/g, '')}`
  }
  return { filePath: text, line, column }
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('/')
}
