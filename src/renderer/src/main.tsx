// Monaco 在模块求值时注册菜单和命令，译文必须先于 App、bootstrap 的编辑器依赖加载。
// 直接使用当前 Monaco 版本自带的语言包，避免消息索引与编辑器版本不匹配。
import 'monaco-editor/nls/lang/zh-cn'
import './assets/app.css'

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
