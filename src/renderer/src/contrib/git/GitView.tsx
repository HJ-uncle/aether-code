import type { JSX } from 'react'
import { GitChangesPanel } from './GitChangesPanel'

/**
 * 版本控制视图（侧边栏入口，对齐 wuzu-client 的 code 模式 git 面板）
 *
 * 本文件只是注册入口：真正的面板实现已按 wuzu GitChangesPanel.vue 移植到
 * ./GitChangesPanel.tsx（分支栏/同步按钮/提交栏/改动分组/历史图线/stash 等
 * 子组件同目录）。这里保留 `GitView` 这个导出名，是因为 contrib/index.ts
 * 的视图注册与旧引用都指向它 —— 改实现、不改入口，注册处无需变动。
 *
 * 数据全部来自 core/git/git-store.ts 单例（useGitStore），克隆流程在面板内
 * 部经 configureGitCloneFlow() 接好宿主回调（目录选择/确认/打开工作区）。
 */
export function GitView(): JSX.Element {
  return <GitChangesPanel />
}
