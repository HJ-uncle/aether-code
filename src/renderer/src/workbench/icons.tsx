/**
 * 内联图标
 *
 * 刻意不引入图标库：P0 只需要几个图标，引入一个 1MB+ 的依赖不值得。
 * 后续若图标数量增长，替换为 vscode-icons / lucide 也只影响本文件。
 */
import type { JSX } from 'react'

export type IconName =
  | 'chat'
  | 'palette'
  | 'graph'
  | 'settings'
  | 'output'
  | 'play'
  | 'stop'
  | 'restart'
  | 'send'
  | 'close'
  | 'trash'
  | 'plus'
  | 'model'
  | 'explorer'
  | 'shield'
  | 'git'
  | 'terminal'
  | 'search'
  | 'chevron'
  | 'copy'
  | 'chevron-up'
  | 'chevron-right'
  | 'collapse-all'
  | 'sort'
  | 'check'
  | 'circle'
  | 'circle-dot'
  | 'file'
  | 'paperclip'
  | 'image'
  | 'brain'
  | 'keyboard'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'locate'

/** mdi:crosshairs-gps —— 资源管理器「定位当前文件」，与 wuzu-client 同图标 */
const MDI_LOCATE =
  'M12 8a4 4 0 0 1 4 4a4 4 0 0 1-4 4a4 4 0 0 1-4-4a4 4 0 0 1 4-4m-8.95 5H1v-2h2.05C3.5 6.83 6.83 3.5 11 3.05V1h2v2.05c4.17.45 7.5 3.78 7.95 7.95H23v2h-2.05c-.45 4.17-3.78 7.5-7.95 7.95V23h-2v-2.05C6.83 20.5 3.5 17.17 3.05 13M12 5a7 7 0 0 0-7 7a7 7 0 0 0 7 7a7 7 0 0 0 7-7a7 7 0 0 0-7-7'

const PATHS: Record<IconName, JSX.Element> = {
  chat: <path d="M3 3h18v14H7l-4 4V3zm3 2v2h12V5H6zm0 4v2h9V9H6z" fill="currentColor" />,
  palette: (
    <path
      d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 2.5-2.5c0-.6-.24-1.2-.66-1.63-.4-.41-.63-.95-.63-1.52a2.5 2.5 0 0 1 2.5-2.5H19a4 4 0 0 0 4-4c0-3.3-5-5.85-11-5.85zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4-5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"
      fill="currentColor"
    />
  ),
  graph: (
    <path
      d="M7 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm10 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm10 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM9 5.4 15 4.6v1.8L9 7.2V5.4zm0 9.2v-1.6l6 .6v1.8l-6-.8zM7.9 8.7l1.7.6-2.6 7-1.7-.6 2.6-7zm8.2 0 2.6 7-1.7.6-2.6-7 1.7-.6z"
      fill="currentColor"
    />
  ),
  search: (
    <path
      d="M10 3a7 7 0 1 0 4.24 12.56l4.1 4.1 1.42-1.42-4.1-4.1A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"
      fill="currentColor"
    />
  ),
  settings: (
    <path
      d="M12 8a4 4 0 100 8 4 4 0 000-8zm0 2a2 2 0 110 4 2 2 0 010-4zm-1-8h2l.3 2.1 1.3.7 1.9-1 1.4 1.4-1 1.9.7 1.3L20 8.6v2l-2.1.3-.7 1.3 1 1.9-1.4 1.4-1.9-1-1.3.7L13.4 18h-2l-.3-2.1-1.3-.7-1.9 1-1.4-1.4 1-1.9-.7-1.3L4 11.4v-2l2.1-.3.7-1.3-1-1.9L7.2 4.5l1.9 1 1.3-.7L11 2z"
      fill="currentColor"
    />
  ),
  output: <path d="M3 4h18v14H3V4zm2 2v10h14V6H5zm2 2h2l3 3-3 3H7l3-3-3-3z" fill="currentColor" />,
  terminal: (
    <g fill="currentColor">
      <path d="M3 4h18v16H3V4zm2 2v12h14V6H5z" />
      <path d="M7 8.5 9.5 11 7 13.5 8 15l3-4-3-4-1 1.5zm5 5.5h5v1.5h-5V14z" />
    </g>
  ),
  play: <path d="M8 5l11 7-11 7V5z" fill="currentColor" />,
  stop: <path d="M6 6h12v12H6z" fill="currentColor" />,
  restart: <path d="M12 5V2L7 6l5 4V7a5 5 0 11-5 5H5a7 7 0 107-7z" fill="currentColor" />,
  send: (
    <path d="M3 3l18 9-18 9 4-9-4-9zm6.5 9L5.6 8.6 15 12l-9.4 3.4L9.5 12z" fill="currentColor" />
  ),
  close: (
    <path
      d="M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5z"
      fill="currentColor"
    />
  ),
  trash: (
    <path
      d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 8h12l-1 12H7L6 8zm3 2v8h2v-8H9zm4 0v8h2v-8h-2z"
      fill="currentColor"
    />
  ),
  plus: <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z" fill="currentColor" />,
  // 窗口控制（自绘标题栏）：最小化横线 / 最大化方框 / 还原双框
  minimize: <path d="M5 11h14v2H5z" fill="currentColor" />,
  maximize: <path d="M5 5h14v14H5V5zm2 2v10h10V7H7z" fill="currentColor" />,
  restore: (
    <g fill="currentColor">
      <path d="M8 4h12v12h-3v-2h1V6H9v1H7V4h1z" />
      <path d="M4 8h12v12H4V8zm2 2v8h8v-8H6z" />
    </g>
  ),
  model: (
    <path
      d="M12 2l9 5v10l-9 5-9-5V7l9-5zm0 2.3L5.5 7.9 12 11.5l6.5-3.6L12 4.3zM5 9.6v6.1l6 3.3v-6.1L5 9.6zm8 9.4l6-3.3V9.6l-6 3.3v6.1z"
      fill="currentColor"
    />
  ),
  explorer: <path d="M3 5h6l2 2h10v12H3V5zm2 2v2h6.2l-1-2H5zm0 4v8h14V9H5z" fill="currentColor" />,
  shield: (
    <path
      d="M12 2l8 3v6.2c0 4.7-3.3 9-8 10.8-4.7-1.8-8-6.1-8-10.8V5l8-3zm0 2.1L6 6.4v4.8c0 3.6 2.5 7 6 8.6 3.5-1.6 6-5 6-8.6V6.4l-6-2.3zM12 8a2 2 0 00-1 3.7V14h2v-2.3A2 2 0 0012 8z"
      fill="currentColor"
    />
  ),
  // 大脑：两瓣对称轮廓 + 中线，表达「推理 / 思考模式」
  brain: (
    <path
      d="M12 3.5c-1.2-1-2.9-1.2-4.2-.4C6.3 3.6 5.6 5 5.6 6.4c-1.3.6-2.1 1.9-2.1 3.3 0 .8.2 1.5.6 2.1-.5.6-.8 1.4-.8 2.2 0 1.9 1.5 3.4 3.4 3.5.3 1.4 1.5 2.4 3 2.4.7 0 1.4-.2 1.9-.7V3.5zm-.9 1.6v13.2c-.3.3-.7.4-1.1.4-.9 0-1.6-.6-1.8-1.4l-.3-1.4-1.4-.1c-.9-.1-1.6-.8-1.6-1.7 0-.5.2-1 .6-1.3l.8-.7-.6-.9c-.3-.4-.4-.8-.4-1.3 0-.8.5-1.5 1.3-1.8l1.1-.4-.1-1.2c0-.8.4-1.6 1.1-2 .6-.4 1.3-.5 1.9-.3zm1.8-2c1.3-.8 3-.6 4.2.4.6-.2 1.3-.1 1.9.3.7.4 1.1 1.2 1.1 2l-.1 1.2 1.1.4c.8.3 1.3 1 1.3 1.8 0 .5-.1.9-.4 1.3l-.6.9.8.7c.4.3.6.8.6 1.3 0 .9-.7 1.6-1.6 1.7l-1.4.1-.3 1.4c-.2.8-.9 1.4-1.8 1.4-.4 0-.8-.1-1.1-.4V5.5c0-.2 0-.3-.1-.4z"
      fill="currentColor"
    />
  ),
  // Octicons git-branch（16×16），平移 4px 使其在 24×24 视窗内居中
  git: (
    <g transform="translate(4 4)" fill="currentColor">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </g>
  ),
  chevron: <path d="M7 10l5 5 5-5H7z" fill="currentColor" />,
  // mdi:crosshairs-gps —— 资源管理器的「定位当前文件」
  locate: <path d={MDI_LOCATE} fill="currentColor" />,
  'chevron-up': <path d="M7 14l5-5 5 5H7z" fill="currentColor" />,
  'chevron-right': <path d="M10 7l5 5-5 5V7z" fill="currentColor" />,
  'collapse-all': (
    <path d="M4 4h8v8H4V4zm2 2v4h4V6H6zm6 6h8v8h-8v-8zm-6 2h4v4H6v-4z" fill="currentColor" />
  ),
  // 排序：上短下长的三条横杠，右下角一个方向箭头（表达"按序排列"而不指定升降）
  sort: (
    <path
      d="M4 6h10v1.8H4V6zm0 5h7v1.8H4V11zm0 5h4v1.8H4V16zm13.1-9.6L19.5 9h-1.6v6.4h-1.8V9h-1.6l2.4-2.6z"
      fill="currentColor"
    />
  ),
  check: (
    <path
      d="M9.55 17.05 4.5 12l1.41-1.41 3.64 3.63 8.54-8.53L19.5 7.1 9.55 17.05z"
      fill="currentColor"
    />
  ),
  circle: (
    <path
      d="M12 4a8 8 0 1 0 8 8 8 8 0 0 0-8-8zm0 1.5a6.5 6.5 0 1 1-6.5 6.5A6.5 6.5 0 0 1 12 5.5z"
      fill="currentColor"
    />
  ),
  'circle-dot': (
    <path
      d="M12 4a8 8 0 1 0 8 8 8 8 0 0 0-8-8zm0 1.5a6.5 6.5 0 1 1-6.5 6.5A6.5 6.5 0 0 1 12 5.5zm0 3.5a3 3 0 1 0 3 3 3 3 0 0 0-3-3z"
      fill="currentColor"
    />
  ),
  file: (
    <path d="M13 3H7v18h10V8l-4-5zm0 2.4L15.6 8H13V5.4zM9 18V8h2v6h4v4H9z" fill="currentColor" />
  ),
  paperclip: (
    <path
      d="M16.5 6.5v9a4.5 4.5 0 0 1-9 0V7a3 3 0 0 1 6 0v8.2a1.6 1.6 0 0 1-3.2 0V7.5H8.7v7.7a3.2 3.2 0 0 0 6.4 0V7a4.6 4.6 0 0 0-9.2 0v8.5a6.1 6.1 0 0 0 12.2 0v-9h-1.6z"
      fill="currentColor"
    />
  ),
  image: (
    <path
      d="M4 5h16v14H4V5zm2 2v10h12V7H6zm2 2.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm-1 6 3-3.5 2.2 2.5 2-2.2L16 16H7z"
      fill="currentColor"
    />
  ),
  copy: (
    <path
      d="M8 2a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V6.4a2 2 0 0 0-.6-1.4l-2.4-2.4A2 2 0 0 0 12.6 2H8zm0 2h4v3a1 1 0 0 0 1 1h3v5H8V4zM5 6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-1h-2v1H5V8h1V6H5z"
      fill="currentColor"
    />
  ),
  keyboard: (
    <path
      d="M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm1 2v8h16V8H4zm2 2h2v2H6v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2zM6 14h2v2H6v-2zm3 0h8v2H9v-2z"
      fill="currentColor"
    />
  )
}

export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  )
}
