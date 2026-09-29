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
  | 'chevron-down'
  | 'chevron-right'
  | 'collapse-all'
  | 'sort'
  | 'check'
  | 'warning'
  | 'info'
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
  | 'file-plus-outline'
  | 'file-remove-outline'
  | 'file-edit-outline'
  | 'file-question-outline'
  | 'source-merge'
  | 'source-pull'
  | 'source-branch'
  | 'sync'
  | 'cloud-upload-outline'
  | 'cloud-download-outline'
  | 'dots-horizontal'
  | 'dots-vertical'
  | 'sparkles'
  | 'filter-remove'
  | 'magnify'
  | 'check-all'
  | 'check-bold'
  | 'content-copy'
  | 'account-outline'
  | 'clock-outline'
  | 'package-variant-closed'
  | 'package-up'
  | 'upload-outline'
  | 'eye-outline'
  | 'delete-outline'
  | 'checkbox-multiple-marked-outline'
  | 'folder-outline'
  | 'tag-outline'
  | 'minus'
  | 'chevron-double-down'
  | 'chevron-double-up'
  | 'layout-sidebar'
  | 'layout-panel'
  | 'layout-panel-left'
  | 'swap-horizontal'
  | 'pin'
  | 'pencil'
  | 'star'
  | 'star-outline'

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
  explorer: (
    <path
      d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"
      fill="currentColor"
    />
  ),
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
  'file-plus-outline': (
    <path
      d="M13.81 22H6c-1.11 0-2-.9-2-2V4c0-1.11.89-2 2-2h8l6 6v5.09c-.33-.05-.66-.09-1-.09-.34 0-.67.04-1 .09V9h-5V4H6v16h7.09c.12.72.37 1.39.72 2M15 15v-3h2v3h3v2h-3v3h-2v-3h-3v-2h3z"
      fill="currentColor"
    />
  ),
  'file-remove-outline': (
    <path
      d="M13.81 22H6c-1.11 0-2-.9-2-2V4c0-1.11.89-2 2-2h8l6 6v5.09c-.33-.05-.66-.09-1-.09-.34 0-.67.04-1 .09V9h-5V4H6v16h7.09c.12.72.37 1.39.72 2m1.54-6l3.54 3.54 3.54-3.54 1.41 1.41-3.54 3.54 3.54 3.54-1.41 1.41-3.54-3.54-3.54 3.54-1.41-1.41 3.54-3.54-3.54-3.54L15.35 16z"
      fill="currentColor"
    />
  ),
  'file-edit-outline': (
    <path
      d="M6 2c-1.11 0-2 .89-2 2v16a2 2 0 0 0 2 2h4v-1.91L12.09 18H6V4h7v5h5v3.09c.33-.05.66-.09 1-.09s.67.04 1 .09V8l-6-6H6m14.15 10.13a.553.553 0 0 1 .39.16l1.22 1.22a.557.557 0 0 1 .16.4c0 .15-.06.29-.16.39l-1 1.01-1.62-1.62 1.01-1c.11-.1.24-.15.39-.15m.54 1.3L14 20.17V22h1.83l6.7-6.7-1.83-1.84z"
      fill="currentColor"
    />
  ),
  'file-question-outline': (
    <path
      d="M14 2H6c-1.11 0-2 .89-2 2v16c0 .53.21 1.04.59 1.41.37.38.88.59 1.41.59h8c.53 0 1.04-.21 1.41-.59.38-.37.59-.88.59-1.41V8l-6-6m-1 7V3.5L18.5 9H13m-1 6h2v2h-2v-2m.38-7c.63 0 1.24.25 1.68.7.45.44.7 1.04.7 1.67 0 .85-.45 1.28-1 1.63-.2.14-.38.26-.53.35-.16.12-.23.2-.23.35h-2c0-.34.14-.7.39-.96.29-.31.61-.5.9-.63.16-.07.29-.14.39-.19.24-.16.4-.37.4-.62 0-.23-.09-.44-.26-.6a.86.86 0 0 0-.61-.25.85.85 0 0 0-.61.25.86.86 0 0 0-.25.61h-2c0-.62.25-1.22.7-1.67.44-.45 1.05-.7 1.68-.7z"
      fill="currentColor"
    />
  ),
  'source-merge': (
    <path
      d="M7 3a3 3 0 0 1 3 3c0 1.29-.81 2.39-2 2.81v8.38c1.19.42 2 1.52 2 2.81a3 3 0 0 1-3 3 3 3 0 0 1-3-3c0-1.29.81-2.39 2-2.81V8.81C4.81 8.39 4 7.29 4 6a3 3 0 0 1 3-3m0 2a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1m0 12a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1m11-8h1c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-1v1.79c.42.19.71.61.71 1.1A2 2 0 0 1 17 21a2 2 0 0 1-2-2c0-.49.29-.91.71-1.1V17H9a1 1 0 0 1-1-1v-2.18A2.982 2.982 0 0 1 6 10c0-.49.29-.91.71-1.1V7a1 1 0 0 1 2 0v1.79c.42.19.71.61.71 1.1 0 .49-.29.91-.71 1.1V12h6.92L17 11h-1V9h2z"
      fill="currentColor"
    />
  ),
  'source-pull': (
    <path
      d="M6 3a3 3 0 0 1 3 3c0 1.29-.81 2.39-2 2.81v8.38c1.19.42 2 1.52 2 2.81a3 3 0 0 1-3 3 3 3 0 0 1-3-3c0-1.29.81-2.39 2-2.81V8.81C4.81 8.39 4 7.29 4 6a3 3 0 0 1 2-3m0 2a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1m0 12a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1m15.71-1.71L18 18.59V9a1 1 0 0 0-2 0v9.59l-3.71-3.7-1.42 1.41L17 22.41l6.13-6.12-1.42-1.41z"
      fill="currentColor"
    />
  ),
  'source-branch': (
    <path
      d="M13 14c-3.36 0-4.46 1.35-4.82 2.24C9.25 16.7 10 17.76 10 19a3 3 0 0 1-3 3 3 3 0 0 1-3-3c0-1.31.83-2.42 2-2.83V7.83A2.99 2.99 0 0 1 4 5a3 3 0 0 1 3-3 3 3 0 0 1 3 3c0 1.31-.83 2.42-2 2.83v5.29c.88-.65 2.16-1.12 4-1.12 2.67 0 3.56-1.34 3.85-2.23A3.006 3.006 0 0 1 14 7a3 3 0 0 1 3-3 3 3 0 0 1 3 3c0 1.34-.88 2.5-2.09 2.86C17.65 11.29 15.68 14 13 14m-6 4a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1M7 4a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1m10 2a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1z"
      fill="currentColor"
    />
  ),
  sync: (
    <path
      d="M12 18a6 6 0 0 1-6-6c0-1.25.39-2.41 1.05-3.38L5 6.55V4h4v2.55L7.05 8.6A4.002 4.002 0 0 1 8 12a4 4 0 0 0 4 4 4 4 0 0 0 4-4c0-.9-.3-1.73-.82-2.4l1.42-1.42A5.997 5.997 0 0 1 18 12a6 6 0 0 1-6 6m0-16a6 6 0 0 1 6 6c0 1.25-.39 2.41-1.05 3.38L19 13.45V16h-4v-2.55l1.95-2.05A4.002 4.002 0 0 1 16 8a4 4 0 0 0-4-4 4 4 0 0 0-4 4c0 .9.3 1.73.82 2.4L7.4 11.82A5.997 5.997 0 0 1 6 8a6 6 0 0 1 6-6z"
      fill="currentColor"
    />
  ),
  'cloud-upload-outline': (
    <path
      d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96M19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95A5.469 5.469 0 0 1 12 6c2.62 0 4.88 1.86 5.39 4.43l-.3 2.37 2.48.2c1.66.13 3 1.51 3 3.18 0 1.65-1.35 3-3 3M8 13h2.55v3h2.9v-3H16l-4-4-4 4z"
      fill="currentColor"
    />
  ),
  'cloud-download-outline': (
    <path
      d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96M19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95A5.469 5.469 0 0 1 12 6c2.62 0 4.88 1.86 5.39 4.43l-.3 2.37 2.48.2c1.66.13 3 1.51 3 3.18 0 1.65-1.35 3-3 3m-6-6.17V8h-2v3.83L8 13.76l1.41 1.41L12 12.59l2.59 2.58L16 13.76l-3-1.92z"
      fill="currentColor"
    />
  ),
  'dots-horizontal': (
    <path
      d="M16 12a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2m-6 0a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2m-6 0a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2z"
      fill="currentColor"
    />
  ),
  'dots-vertical': (
    <path
      d="M12 16a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1-2-2 2 2 0 0 1 2-2m0-6a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2m0-6a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2z"
      fill="currentColor"
    />
  ),
  sparkles: (
    <path
      d="M10 19a1 1 0 0 1-.64.23 1 1 0 0 1-.13-.02A1 1 0 0 1 9 18.43L7.79 15.6l-2.83-1.21a1 1 0 0 1-.5-1.32A1 1 0 0 1 4.57 12.6l2.83-1.21L8.61 8.56a1 1 0 0 1 1.78 0l1.21 2.83 2.83 1.21a1 1 0 0 1 .11 1.83l-2.83 1.21L10.5 19a1 1 0 0 1-.5.13M15 12a1 1 0 0 1-.64.23 1 1 0 0 1-.13-.02A1 1 0 0 1 14 11.43L12.79 8.6l-2.83-1.21a1 1 0 0 1 0-1.78l2.83-1.21L14 3.57a1 1 0 0 1 1.78 0l1.21 2.83 2.83 1.21a1 1 0 0 1 .11 1.83l-2.83 1.21L15.5 12a1 1 0 0 1-.5.13M18 18a1 1 0 0 1-.64.23 1 1 0 0 1-.13-.02A1 1 0 0 1 17 17.43l-1.21-2.83-2.83-1.21a1 1 0 0 1 0-1.78l2.83-1.21L17 9.57a1 1 0 0 1 1.78 0l1.21 2.83 2.83 1.21a1 1 0 0 1 .11 1.83l-2.83 1.21L18.5 18a1 1 0 0 1-.5.13z"
      fill="currentColor"
    />
  ),
  'filter-remove': (
    <path
      d="M14.76 20.83L17.6 18l-2.84-2.84 1.41-1.41L19 16.57l2.83-2.83 1.41 1.41L20.43 18l2.83 2.83-1.41 1.41L19 19.4l-2.83 2.84-1.41-1.41M12 12v7.88c.04.3-.06.62-.29.83a.996.996 0 0 1-1.41 0L8.29 19.5c-.2-.21-.3-.49-.3-.71V12L4.21 4.62a1 1 0 0 1 .17-1.4c.19-.14.4-.22.62-.22h14c.22 0 .43.08.62.22a1 1 0 0 1 .17 1.4L12 12z"
      fill="currentColor"
    />
  ),
  magnify: (
    <path
      d="M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.516 6.516 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5z"
      fill="currentColor"
    />
  ),
  'check-all': (
    <path
      d="M0.41 13.41L6 19l1.41-1.41L1.83 12 0.41 13.41zm21.41-7.41L10 17.83l-3.59-3.59L5 15.66l5 5 13.24-13.24L21.82 6zM18 7l-8 8.01L8.83 14 7.41 12.59 17 3l1 1z"
      fill="currentColor"
    />
  ),
  'check-bold': (
    <path
      d="M9 20.42l-6.41-6.41 2.82-2.83L9 14.77l13.6-13.6L25.41 4 9 20.42z"
      fill="currentColor"
    />
  ),
  'content-copy': (
    <path
      d="M19 21H8V7h11m0-2H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m-3-4H4a2 2 0 0 0-2 2v14h2V4h12V3z"
      fill="currentColor"
    />
  ),
  'account-outline': (
    <path
      d="M12 4a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4m0 2a2 2 0 0 0-2 2 2 2 0 0 0 2 2 2 2 0 0 0 2-2 2 2 0 0 0-2-2m0 7c2.67 0 8 1.33 8 4v3H4v-3c0-2.67 5.33-4 8-4m0 1.9c-2.97 0-6.1 1.46-6.1 2.1v1.1h12.2V17c0-.64-3.13-2.1-6.1-2.1z"
      fill="currentColor"
    />
  ),
  'clock-outline': (
    <path
      d="M12 20a8 8 0 0 0 8-8 8 8 0 0 0-8-8 8 8 0 0 0-8 8 8 8 0 0 0 8 8m0-18a10 10 0 0 1 10 10 10 10 0 0 1-10 10C6.47 22 2 17.5 2 12A10 10 0 0 1 12 2m.5 5v5.25l4.5 2.67-.75 1.23L11 13V7h1.5z"
      fill="currentColor"
    />
  ),
  'package-variant-closed': (
    <path
      d="M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18-.21 0-.41-.06-.57-.18l-7.9-4.44A.991.991 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18.21 0 .41.06.57.18l7.9 4.44c.32.17.53.5.53.88v9M12 4.15L6.04 7.5 12 10.85l5.96-3.35L12 4.15M5 15.91l6 3.38v-6.71L5 9.21v6.7M19 15.91v-6.7l-6 3.37v6.71l6-3.38z"
      fill="currentColor"
    />
  ),
  'package-up': (
    <path
      d="M13 8c0-2.21 1.79-4 4-4s4 1.79 4 4-1.79 4-4 4-4-1.79-4-4m6 0V5h-2v3H14l3-3 3 3h-3M3 18h7.35c-.22-.63-.35-1.3-.35-2H3v-2h8c0-1.3.54-2.5 1.35-3.35C11.17 9.95 10.05 9 8.5 9 5.79 9 3 12.54 3 16v2h.35z"
      fill="currentColor"
    />
  ),
  'upload-outline': (
    <path
      d="M9 10v6h6v-6h4l-7-7-7 7h4m-6 4h2v2h10v-2h2v4H5v-4z"
      fill="currentColor"
    />
  ),
  'eye-outline': (
    <path
      d="M12 9a3 3 0 0 1 3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3m0-4.5c5 0 9.27 3.11 11 7.5-1.73 4.39-6 7.5-11 7.5S2.73 16.39 1 12c1.73-4.39 6-7.5 11-7.5M3.18 12a9.821 9.821 0 0 0 17.64 0 9.821 9.821 0 0 0-17.64 0z"
      fill="currentColor"
    />
  ),
  'delete-outline': (
    <path
      d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12M8 9h8v10H8V9m7.5-5-1-1h-5l-1 1H5v2h14V4h-3.5z"
      fill="currentColor"
    />
  ),
  'checkbox-multiple-marked-outline': (
    <path
      d="M20 16v-6h2v6a2 2 0 0 1-2 2H8v-2h12M5 16V4h2v12H5m-2 0h2v2a2 2 0 0 1-2-2m10 0v-2h2v2h-2m-5-2v-2h2v2H8m-1-2v-2h2v2H7m10-2V8h2v2h-2m-5-2V6h2v2h-2m-5-2V4h2v2H8M7 6V4h2v2H7m1-2V2h2v2H8m9 0V2h2v2h-2M4 2h2v2H4V2m16 0h2v2h-2V2z"
      fill="currentColor"
    />
  ),
  'folder-outline': (
    <path
      d="M20 18H4V8h16m0-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z"
      fill="currentColor"
    />
  ),
  'tag-outline': (
    <path
      d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.11 0-2 .89-2 2v7c0 .55.22 1.05.59 1.41l8.99 9C11.95 21.78 12.45 22 13 22s1.05-.22 1.41-.59l7-7c.38-.37.59-.87.59-1.41s-.21-1.04-.59-1.42M13 20.01L4 11V4h7v-.01l9 9L13 20.01z"
      fill="currentColor"
    />
  ),
  minus: <path d="M5 11h14v2H5z" fill="currentColor" />,
  'chevron-double-down': (
    <path
      d="M16.59 5.59L18 7l-6 6-6-6 1.41-1.41L12 10.17l4.59-4.58m0 6L18 13l-6 6-6-6 1.41-1.41L12 16.17l4.59-4.58z"
      fill="currentColor"
    />
  ),
  /* 消息导航「回到顶部」 */
  'chevron-double-up': (
    <path
      d="M7.41 18.41L6 17l6-6 6 6-1.41 1.41L12 13.83l-4.59 4.58m0-6L6 11l6-6 6 6-1.41 1.41L12 7.83l-4.59 4.58z"
      fill="currentColor"
    />
  ),
  /* mdi:dock-left —— 侧边栏开关 */
  'layout-sidebar': (
    <path
      d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m0 2v12h5V6H4z"
      fill="currentColor"
    />
  ),
  /* mdi:dock-right —— 对话面板开关（对话在右侧时用） */
  'layout-panel': (
    <path
      d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 2v12h-5V6h5z"
      fill="currentColor"
    />
  ),
  /* mdi:dock-left —— 对话面板开关（换位到左侧时用，填充侧翻到左边） */
  'layout-panel-left': (
    <path
      d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2M4 6h5v12H4V6z"
      fill="currentColor"
    />
  ),
  /* mdi:swap-horizontal —— 对话面板与主区换位 */
  'swap-horizontal': (
    <path
      d="M21 6l-4-4v3H8v2h9v4l4-4M3 18l4 4v-3h9v-2H7v-4l-4 4z"
      fill="currentColor"
    />
  ),
  /* mdi:pin —— 会话「置顶」 */
  pin: (
    <path
      d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"
      fill="currentColor"
    />
  ),
  /* mdi:pencil-outline —— 会话「重命名」 */
  pencil: (
    <path
      d="M14.06 9l.94.94L5.92 19H5v-.92L14.06 9m3.6-6c-.25 0-.51.1-.7.29l-1.83 1.83l3.75 3.75l1.83-1.83c.39-.39.39-1.04 0-1.41l-2.34-2.34c-.2-.2-.46-.29-.71-.29m-3.6 3.19L3 17.25V21h3.75L17.81 9.94l-3.75-3.75z"
      fill="currentColor"
    />
  ),
  /* mdi:star —— 已收藏（实心） */
  star: (
    <path
      d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2L9.19 8.63L2 9.24l5.46 4.73L5.82 21L12 17.27z"
      fill="currentColor"
    />
  ),
  /* mdi:star-outline —— 未收藏 / 收藏过滤按钮 */
  'star-outline': (
    <path
      d="M12 15.39l-3.76 2.27l.99-4.28l-3.32-2.88l4.38-.37L12 6.09l1.71 4.04l4.38.37l-3.32 2.88l.99 4.28L12 15.39M12 2L9.19 8.63L2 9.24l5.46 4.73L5.82 21L12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2z"
      fill="currentColor"
    />
  ),
  'chevron-up': <path d="M7 14l5-5 5 5H7z" fill="currentColor" />,
  'chevron-down': <path d="M7 10l5 5 5-5H7z" fill="currentColor" />,
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
  warning: (
    <path
      d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z"
      fill="currentColor"
    />
  ),
  info: (
    <path
      d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"
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
