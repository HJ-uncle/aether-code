/** Pure parsers used by Git status/history tests and lightweight integrations. */

export interface ParsedStatusChange {
  path: string
  oldPath?: string
  indexStatus: string
  workTreeStatus: string
  staged: boolean
}

export interface ParsedStatus {
  isRepo: boolean
  branch: string
  ahead: number | null
  behind: number | null
  changes: ParsedStatusChange[]
}

/** Parse `git status --porcelain=v1 -z --branch` output without shell assumptions. */
export function parseGitStatus(raw: string): ParsedStatus {
  const tokens = raw.split('\0')
  let branch = ''
  let ahead: number | null = null
  let behind: number | null = null
  const changes: ParsedStatusChange[] = []
  let firstChange = true

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    if (token.startsWith('## ')) {
      const header = token.slice(3)
      const emptyHistory = /^No commits yet on (.+)$/.exec(header)
      if (emptyHistory) {
        branch = emptyHistory[1]
      } else if (/^HEAD \(no branch\)$/.test(header)) {
        branch = 'HEAD'
      } else {
        const name = header.split('...')[0].trim()
        branch = name
        const aheadMatch = /\[([^\]]+)\]/.exec(header)
        if (aheadMatch) {
          const a = /(?:^|,\s*)ahead (\d+)/.exec(aheadMatch[1])
          const b = /(?:^|,\s*)behind (\d+)/.exec(aheadMatch[1])
          if (a) ahead = Number(a[1])
          if (b) behind = Number(b[1])
        }
      }
      continue
    }

    // Porcelain v1 -z uses a two-character XY prefix followed by a space.
    // For an untracked entry, the prefix is `??`; for rename/copy, the next
    // NUL token is the old path and must be consumed as part of this record.
    const xy = token.slice(0, 2)
    if (xy.length < 2) continue
    let path = token.slice(3)
    if (path === '') path = token.slice(2).trimStart()
    if (!path) continue
    const indexStatus = xy[0]
    const workTreeStatus = xy[1]
    const item: ParsedStatusChange = {
      path,
      indexStatus,
      workTreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?'
    }
    if (indexStatus === 'R' || indexStatus === 'C' || workTreeStatus === 'R' || workTreeStatus === 'C') {
      const oldPath = tokens[i + 1]
      if (oldPath) {
        item.oldPath = oldPath
        i += 1
      }
    }
    changes.push(item)
    firstChange = false
  }

  return { isRepo: Boolean(branch || changes.length || firstChange === false), branch, ahead, behind, changes }
}

export interface ParsedLogEntry {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string
  subject: string
}

/** Parse `%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s` records. */
export function parseGitLog(raw: string): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const fields = line.split('\x1f')
    if (fields.length < 6) continue
    const [hash, shortHash, author, date, refs, ...subjectParts] = fields
    entries.push({ hash, shortHash, author, date, refs, subject: subjectParts.join('\x1f') })
  }
  return entries
}

export function isNotARepoError(message: string): boolean {
  return /not a git repository|not in a git directory/i.test(message)
}

export function isNoCommitsError(message: string): boolean {
  return /does not have any commits|bad (?:default )?revision HEAD|unknown revision HEAD/i.test(message)
}
