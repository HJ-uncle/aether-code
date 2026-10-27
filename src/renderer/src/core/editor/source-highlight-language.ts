const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  yaml: 'yaml', yml: 'yaml', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
  toml: 'ini', ini: 'ini', conf: 'ini', env: 'ini', dockerfile: 'dockerfile'
}

export function sourceLanguage(name: string): string | undefined {
  const basename = name.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (basename === 'dockerfile' || basename.startsWith('dockerfile.')) return 'dockerfile'
  if (basename === 'makefile') return 'makefile'
  return LANGUAGE_BY_EXTENSION[basename.split('.').at(-1) ?? '']
}
