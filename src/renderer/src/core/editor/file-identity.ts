/** Compare local file identities without changing the spelling shown to users. */
export function fileIdentity(filePath: string): string {
  const path = filePath.replace(/\\/g, '/')
  // LSP/Monaco lowercases Windows drive letters while explorer paths preserve
  // their original spelling. Windows UNC paths have the same casing semantics.
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}
