/**
 * 文件类型图标映射（照抄 wuzu-client 的 languageMap.ts EXT_TO_ICON）
 *
 * 扩展名 → mdi 图标 body + seti 色板 hex（VSCode 文件图标在明暗主题下颜色
 * 一致，这里同样固定 hex 直涂）。直接读 `@iconify-json/mdi` 的 icons.json
 * （键为 kebab-case），零运行时依赖、离线可用。
 */

interface FileIcon {
  /** SVG inner body（viewBox 24×24，fill=currentColor） */
  body: string
  color: string
}

interface MdiPackage {
  icons: Record<string, { body: string }>
  aliases?: Record<string, { parent: string }>
}

import mdiJson from '@iconify-json/mdi/icons.json'
const mdi = mdiJson as unknown as MdiPackage

/** 按名字取图标 body（先查 icons 再查 aliases） */
function svg(name: string, color: string): FileIcon {
  const def = mdi.icons[name] ?? mdi.aliases?.[name]
  // 定义缺失时退回 file-outline；两者都缺则给空方块（理论不可达，上面已校验）
  const body = def ? ('parent' in def ? (mdi.icons[(def as { parent: string }).parent]?.body ?? '') : def.body) : ''
  return { body, color }
}

const EXT_TO_ICON: Record<string, FileIcon> = {
  ts: svg('language-typescript', '#519aba'),
  tsx: svg('language-typescript', '#3578b6'),
  mts: svg('language-typescript', '#519aba'),
  cts: svg('language-typescript', '#519aba'),
  js: svg('language-javascript', '#cbcb41'),
  jsx: svg('language-javascript', '#519aba'),
  mjs: svg('language-javascript', '#cbcb41'),
  cjs: svg('language-javascript', '#cbcb41'),
  vue: svg('vuejs', '#41b883'),
  json: svg('code-json', '#cbcb41'),
  jsonc: svg('code-json', '#cbcb41'),
  md: svg('language-markdown', '#519aba'),
  markdown: svg('language-markdown', '#519aba'),
  css: svg('language-css3', '#519aba'),
  scss: svg('sass', '#f55385'),
  less: svg('language-css3', '#2c5d92'),
  html: svg('language-html5', '#e37933'),
  htm: svg('language-html5', '#e37933'),
  py: svg('language-python', '#3578b6'),
  rb: svg('language-ruby', '#701516'),
  go: svg('language-go', '#519aba'),
  rs: svg('language-rust', '#dea584'),
  java: svg('language-java', '#cc3e44'),
  kt: svg('language-kotlin', '#7f52ff'),
  swift: svg('language-swift', '#f05138'),
  c: svg('language-c', '#519aba'),
  h: svg('language-c', '#519aba'),
  cpp: svg('language-cpp', '#519aba'),
  cc: svg('language-cpp', '#519aba'),
  hpp: svg('language-cpp', '#519aba'),
  cs: svg('language-csharp', '#519aba'),
  php: svg('language-php', '#a074c4'),
  sh: svg('console', '#89e051'),
  bash: svg('console', '#89e051'),
  zsh: svg('console', '#89e051'),
  ps1: svg('powershell', '#0a639c'),
  bat: svg('console', '#89e051'),
  cmd: svg('console', '#89e051'),
  sql: svg('database', '#dad8d8'),
  yaml: svg('file-cog-outline', '#cc3e44'),
  yml: svg('file-cog-outline', '#cc3e44'),
  toml: svg('file-cog-outline', '#9c4221'),
  ini: svg('file-cog-outline', '#9c4221'),
  xml: svg('file-xml-box', '#e37933'),
  svg: svg('file-image-outline', '#a074c4'),
  png: svg('file-image-outline', '#a074c4'),
  jpg: svg('file-image-outline', '#a074c4'),
  jpeg: svg('file-image-outline', '#a074c4'),
  gif: svg('file-image-outline', '#a074c4'),
  webp: svg('file-image-outline', '#a074c4'),
  ico: svg('file-image-outline', '#a074c4'),
  pdf: svg('file-pdf-box', '#cc3e44'),
  zip: svg('folder-zip-outline', '#cc3e44')
}

/** 特定文件名优先于扩展名 */
const FILENAME_TO_ICON: Record<string, FileIcon> = {
  '.gitignore': svg('file-cog-outline', '#e37933'),
  '.dockerignore': svg('file-cog-outline', '#e37933'),
  '.npmrc': svg('file-cog-outline', '#cbcb41'),
  '.prettierrc': svg('code-json', '#cbcb41'),
  '.env': svg('file-cog-outline', '#6a6a6a'),
  '.env.local': svg('file-cog-outline', '#6a6a6a'),
  dockerfile: svg('file-cog-outline', '#519aba'),
  license: svg('file-outline', '#6a6a6a')
}

const DEFAULT_ICON = svg('file-outline', '#8a8a8a')

/** 按文件名取图标配置（纯函数，无副作用） */
export function resolveFileIcon(name: string): FileIcon {
  const lower = name.toLowerCase()
  const byName = FILENAME_TO_ICON[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  return EXT_TO_ICON[ext] ?? DEFAULT_ICON
}

export type { FileIcon }
