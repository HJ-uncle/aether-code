import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // .e2e-tmp 是 E2E 测试的临时夹具目录（每次测试重建），不参与 lint
  { ignores: ['**/node_modules', '**/dist', '**/out', '.e2e-tmp/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // 关掉「只能导出组件」这条 fast refresh 提示：
      // 本仓库部分 .tsx 有意把「组件 + 供别处调用的普通函数」放同一文件
      // （如 EditorArea 旁挂标签操作命令、app-provider 旁挂设置读写），
      // 这是刻意的就近组织，不是缺陷。该规则只影响开发期热更新粒度，
      // 关掉它换来的是不必为过 HMR 提示而把函数拆散、改一堆 import。
      'react-refresh/only-export-components': 'off'
    }
  },
  eslintConfigPrettier
)
