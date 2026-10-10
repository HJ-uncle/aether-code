// Monaco 在模块求值时注册菜单和命令，译文必须先于 App、bootstrap 的编辑器依赖加载。
// 直接使用当前 Monaco 版本自带的语言包，避免消息索引与编辑器版本不匹配。
import 'monaco-editor/nls/lang/zh-cn'
// 打包内置 Inter：Windows/Linux 上没有 Apple SF 字体，用度量接近的开源替代，
// 保证跨平台 UI 文字与自绘数字的宽度/基线一致（中文仍回退系统字体）。
import '@fontsource-variable/inter/wght.css'
import './assets/app.css'

// 平台标记：CSS 无法直接探测操作系统，而字体基线校准（--ctx-baseline）在
// macOS(SF) 与其它平台(Inter) 上取值相反，故在渲染前把 platform 写到 <html> 上。
document.documentElement.dataset.platform = navigator.platform.toLowerCase().includes('mac')
  ? 'darwin'
  : 'other'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrapRenderer } from './bootstrap'

bootstrapRenderer()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
