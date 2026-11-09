/** Batch labels describe a group; they must never become a single-file open target. */
export function batchFileSummary(args: Record<string, unknown>): string | null {
  if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 16) return null
  const paths: string[] = []
  for (const file of args.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return null
    const value = (file as Record<string, unknown>).path
    if (typeof value !== 'string' || !value.trim()) return null
    paths.push(value.trim())
  }
  const name = paths[0].replace(/\\/g, '/').split('/').filter(Boolean).at(-1)?.replace(/\s+/g, ' ') ?? '文件'
  const shortName = name.length > 72 ? `${name.slice(0, 71)}…` : name
  return paths.length === 1 ? `${shortName}（1 个文件）` : `${shortName} 等 ${paths.length} 个文件`
}
