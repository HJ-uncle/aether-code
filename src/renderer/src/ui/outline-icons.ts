import type { IconName } from './icons'

export const OUTLINE_ICON_STROKE = 1.5

const circle = (x: number, y: number, r: number): string => `M${x + r} ${y}a${r} ${r} 0 1 1-${r * 2} 0a${r} ${r} 0 1 1 ${r * 2} 0Z`
const frame = 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z'
const file = 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6'
const folder = 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'
const cube = 'm12 3 9 5v8l-9 5-9-5V8l9-5Zm0 10L3 8m9 5 9-5m-9 5v8M7.5 5.5l9 5'
const user = `${circle(12, 7, 4)}M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2`
const search = `${circle(10.5, 10.5, 6.5)}M15.1 15.1l5.4 5.4`
const check = 'm5 12 4 4L19 6'
const trash = 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7'
const copy = 'M9 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2ZM17 8V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2'
const clock = `${circle(12, 12, 9)}M12 7v5l3 2`
const chevronDown = 'm6 9 6 6 6-6'
const chevronUp = 'm6 15 6-6 6 6'
const refresh = 'M20 7a8 8 0 0 0-14-1L3 9m0-5v5h5M4 17a8 8 0 0 0 14 1l3-3m0 5v-5h-5'
const rotate = 'M20 8a8 8 0 1 0 0 8M20 3v5h-5'
const download = 'M12 3v12m-5-5 5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'
const cloud = 'M7 18H6a5 5 0 0 1-1-9.9A7 7 0 0 1 18.7 8a5 5 0 0 1 .3 10h-2'
const branch = `${circle(6, 5, 2)}${circle(6, 19, 2)}${circle(18, 5, 2)}M6 7v10m12-10v2a5 5 0 0 1-5 5h-2a5 5 0 0 0-5 5`
const star = 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z'
const pin = 'M8 3h8m-7 0v6l-4 4v2h14v-2l-4-4V3M12 15v6'
const eye = `M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z${circle(12, 12, 3)}`

/** Complete Work symbol family. Brand marks and file-type artwork keep their original identity. */
export const OUTLINE_ICON_PATHS: Readonly<Record<Exclude<IconName, 'vscode'>, string>> = {
  dashboard: `${frame}M3 9h18M9 9v11`,
  puzzle: 'M9 3H5a2 2 0 0 0-2 2v4h1a3 3 0 0 1 0 6H3v4a2 2 0 0 0 2 2h4v-1a3 3 0 0 1 6 0v1h4a2 2 0 0 0 2-2v-4h-1a3 3 0 0 1 0-6h1V5a2 2 0 0 0-2-2h-4v1a3 3 0 0 1-6 0V3Z',
  globe: `${circle(12, 12, 9)}M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z`,
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  'list-play': 'M3 6h18M3 12h7M3 18h7m5-8 7 5-7 5V10Z',
  library: 'M4 3v18m5-18v18m4-17 5-1 4 17-5 1-4-17Z',
  users: `${circle(9, 7, 3)}M2 21v-3a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v3M16 4a3 3 0 0 1 0 6m3 4a5 5 0 0 1 3 4v3`,
  refresh,
  'folder-plus': `${folder}M12 10v7m-3.5-3.5h7`,
  'file-check': `${file}M8 15l3 3 5-6`,
  archive: 'M3 3h18v5H3V3Zm2 5v13h14V8M10 12h4',
  'book-open': 'M12 5v16M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3V4Z',
  extensions: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm14.5 0v7M14 17.5h7',
  plug: 'M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5',
  'agent-research': 'M10 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6.5L17 7.5V10M12.5 3v4.5H17M7.5 11h3.5M7.5 14.5h1M19 15.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1.2 2.8 3.2 3.2',
  'agent-executor': 'M6.5 3.5h11A2.5 2.5 0 0 1 20 6v12a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18V6a2.5 2.5 0 0 1 2.5-2.5ZM7 9l1.5 1.5L11 8m2.5 1.5H17M7 15l1.5 1.5L11 14m2.5 1.5H17',
  'agent-general': 'M12.5 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3.5 20v-1.5A4.5 4.5 0 0 1 8 14h3a4.5 4.5 0 0 1 4.5 4.5V20h-12ZM18 3l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1L18 3Z',
  'account-outline': user,
  chat: 'M5 3h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8l-5 3V5a2 2 0 0 1 2-2ZM7 8h10M7 12h6',
  'chat-outline': 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z',
  'open-in-new': 'M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
  palette: `M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.3h2a4 4 0 0 0 4-4C22 6 17 3 12 3ZM7 9h.01M11 6h.01M16 7h.01M7 14h.01`,
  graph: `${circle(6, 5, 2)}${circle(18, 5, 2)}${circle(6, 19, 2)}${circle(18, 19, 2)}M8 5h8M6 7v10m12-10v10M8 19h8M8 7l8 10`,
  settings: `M10 3h4l.5 2.4 2.1 1.2 2.3-.8 2 3.4-1.8 1.6v2.4l1.8 1.6-2 3.4-2.3-.8-2.1 1.2L14 21h-4l-.5-2.4-2.1-1.2-2.3.8-2-3.4 1.8-1.6v-2.4L3.1 9.2l2-3.4 2.3.8 2.1-1.2L10 3Z${circle(12, 12, 3)}`,
  output: `${frame}M7 9l3 3-3 3m6 0h4`,
  terminal: `${frame}M7 9l3 3-3 3m6 0h4`,
  play: 'm8 4 12 8-12 8V4Z',
  stop: 'M6 6h12v12H6V6Z',
  restart: rotate,
  undo: 'M8 4 3 9l5 5M3 9h11a7 7 0 0 1 7 7v4',
  redo: 'M16 4 21 9l-5 5M21 9H10a7 7 0 0 0-7 7v4',
  send: 'M12 20V4m-6 6 6-6 6 6',
  close: 'm6 6 12 12M6 18 18 6',
  trash,
  plus: 'M12 5v14M5 12h14',
  model: `${circle(12, 12, 3)}M7 3h10v4h4v10h-4v4H7v-4H3V7h4V3Z`,
  explorer: folder,
  shield: 'M12 3 4 6v6c0 4 3 7 8 10 5-3 8-6 8-10V6l-8-3Zm-3 9 2 2 4-4',
  'lock-open': 'M8 11V7a4 4 0 0 1 7.8-1.2M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm5 4v2',
  git: branch,
  search,
  chevron: chevronDown,
  copy,
  'chevron-up': chevronUp,
  'chevron-down': chevronDown,
  'chevron-right': 'm9 6 6 6-6 6',
  'chevron-left': 'm15 6-6 6 6 6',
  'collapse-all': 'M7 3h14v14M3 7h14v14H3V7Zm4 7h6',
  sort: 'M4 6h16M4 12h11M4 18h6',
  check,
  warning: 'M10.3 4a2 2 0 0 1 3.4 0l8 14a2 2 0 0 1-1.7 3H4a2 2 0 0 1-1.7-3l8-14ZM12 9v4m0 4h.01',
  info: `${circle(12, 12, 9)}M12 11v6m0-10h.01`,
  circle: circle(12, 12, 8),
  'circle-dot': `${circle(12, 12, 8)}${circle(12, 12, 2)}`,
  file,
  paperclip: 'm21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5',
  image: `${frame}${circle(8, 8, 1.5)}M3 17l5-5 4 4 4-5 5 6`,
  brain: 'M12 4a3 3 0 0 0-5-1 4 4 0 0 0-3 6 4 4 0 0 0 0 7 4 4 0 0 0 5 5 3 3 0 0 0 3-2V4Zm0 0a3 3 0 0 1 5-1 4 4 0 0 1 3 6 4 4 0 0 1 0 7 4 4 0 0 1-5 5 3 3 0 0 1-3-2M7 3v4m-3 2h3l2 3m-5 4h3v3m10-16v4m3 2h-3l-2 3m5 4h-3v3',
  keyboard: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm2 4h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  minimize: 'M5 12h14',
  maximize: 'M5 5h14v14H5V5Z',
  restore: 'M8 5V3h13v13h-2M3 8h13v13H3V8Z',
  locate: `${circle(12, 12, 7)}${circle(12, 12, 2)}M12 2v3m0 14v3M2 12h3m14 0h3`,
  'file-plus-outline': `${file}M12 12v6m-3-3h6`,
  'file-remove-outline': `${file}M9 12l6 6m-6 0 6-6`,
  'file-edit-outline': `${file}M8 16l5-5 3 3-5 5H8v-3Z`,
  'file-question-outline': `${file}M9 13a3 3 0 0 1 6 0c0 2-3 2-3 3m0 2h.01`,
  'source-merge': `${circle(6, 5, 2)}${circle(6, 19, 2)}${circle(18, 5, 2)}M6 7v10m12-10v1a5 5 0 0 1-5 5H6`,
  'source-pull': `${circle(6, 5, 2)}${circle(6, 19, 2)}${circle(18, 19, 2)}M6 7v10m8-14-3 3 3 3m-3-3h4a3 3 0 0 1 3 3v8`,
  'source-branch': branch,
  sync: refresh,
  'rotate-clockwise': rotate,
  download,
  'cloud-upload-outline': `${cloud}M12 21V11m-4 4 4-4 4 4`,
  'cloud-download-outline': `${cloud}M12 11v10m-4-4 4 4 4-4`,
  'dots-horizontal': `${circle(5, 12, .75)}${circle(12, 12, .75)}${circle(19, 12, .75)}`,
  'dots-vertical': `${circle(12, 5, .75)}${circle(12, 12, .75)}${circle(12, 19, .75)}`,
  sparkles: 'm9 4 2.2 5.8L17 12l-5.8 2.2L9 20l-2.2-5.8L1 12l5.8-2.2L9 4ZM19 2v6m-3-3h6m-3 11v6m-3-3h6',
  'filter-remove': 'M3 3h18l-7 8v3M10 19l-2-1v-7L3 3M16 16l6 6m-6 0 6-6',
  magnify: search,
  'check-all': 'm2 12 4 4L16 6m-5 10 3 3L22 9',
  'check-bold': check,
  'content-copy': copy,
  'clock-outline': clock,
  'package-variant-closed': cube,
  'package-up': `${cube}M17 19v-6m-3 3 3-3 3 3`,
  'upload-outline': 'M12 16V3m-5 5 5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  'eye-outline': eye,
  'delete-outline': trash,
  'checkbox-multiple-marked-outline': 'M7 3h14v14M3 7h14v14H3V7Zm3 7 3 3 5-6',
  'folder-outline': folder,
  'tag-outline': `M3 3h8l10 10-8 8L3 11V3Z${circle(7, 7, 1)}`,
  minus: 'M5 12h14',
  'chevron-double-down': 'm6 6 6 6 6-6M6 12l6 6 6-6',
  'chevron-double-up': 'm6 18 6-6 6 6M6 12l6-6 6 6',
  'layout-sidebar': `${frame}M9 4v16`,
  'layout-panel': `${frame}M15 4v16`,
  'layout-panel-left': `${frame}M9 4v16`,
  'swap-horizontal': 'M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4',
  pin,
  'pin-outline': pin,
  pencil: 'm4 16 13-13 4 4L8 20l-5 1 1-5Zm10-10 4 4',
  star,
  'star-outline': star,
  'fit-screen': 'M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6',
  engine: 'M6 6h12v12H6V6Zm3 3h6v6H9V9ZM9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3',
  'alert-circle': `${circle(12, 12, 9)}M12 7v6m0 4h.01`,
}
