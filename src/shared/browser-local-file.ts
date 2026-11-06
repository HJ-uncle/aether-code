/** Only the user address bar routes native paths; ordinary web/AI URL validation stays strict. */
export function localBrowserInput(input: string): string | null {
  let value = input.trim()
  if (value.length >= 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim()
  }
  return /^(?:file:|[a-z]:[\\/]|\/|\\\\)/i.test(value) ? value : null
}
