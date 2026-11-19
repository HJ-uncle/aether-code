# Aether 桌面文档

源码核对：2026-11-17。当前产品只有一个默认界面。历史文档中的 Work/Code 页面结构、旧编辑器和旧账号流程不能直接作为当前操作说明。

| 需要做什么 | 从这里开始 |
|---|---|
| 第一次使用、配置模型、工作区和任务 | [使用指南](user-guide.md) |
| 查找所有功能入口与源码 | [功能覆盖表](feature-map.md) |
| 新建/恢复账号、第三方登录、重新验证 | [账号与登录](accounts-and-login.md) |
| 理解进程、IPC、数据与远端连接 | [前端架构](frontend-architecture.md) |
| 理解引擎管理的连接、账号、取消与手动监控 | [引擎管理链路调研（2026-11-18）](engine-management-audit-2026-11-18.md) |
| 模型、记忆、Skills、MCP、管理工具包 | [工具配置](tool-profiles.md) |
| 文件/Office/PDF 预览与编辑边界 | [文件预览](editor-code-oss.md) |
| 浏览器标签、AI 操作和宿主关系 | [浏览器工作流](browser-workflow-reliability.md) |
| 项目辅助文件放在哪里 | [项目存储](project-storage.md) |
| 界面令牌、排版与图标 | [设计系统](../design-system/aether-code/MASTER.md)、[图标约定](work-icon-guidelines.md) |
| 开发插件 | [插件公开 HTML 站点](plugin-api/dist/index.html)、[站点维护](plugin-api/maintenance.html) |
| 引擎协议、持久运行、权限和部署 | [引擎文档](../../ai-agent-engine/docs/README.md) |
| 查找保留资料与文档状态 | [两仓库全量清单](../../ai-agent-engine/docs/documentation-inventory.md) |

插件 API 的唯一内容源在 plugin-api/content/*.html。先 npm run docs:build 生成静态站点；dist 由构建维护，不手改。其他 Markdown 中的插件章节只解释内部实现和实际宿主边界。

清理已被现行指南替代的重复报告、完成提案和退役草稿；仍有用的故障证据、未完成事项及其必要附件继续保留，注明原日期、原失败与条件。历史测试数字不代表当前版本结果，当前功能以使用指南、功能覆盖表和相应源码为准。运行提示词、SKILL.md 与 AGENTS.md 属于协作/执行约定，不因文档整理批量改写。

维护时运行：

```powershell
npm run docs:check
npm run docs:test
npm run build
```

build 包含 typecheck。更新受监控实现或 HTML 后，先交叉审阅，再运行 docs:review 记录已审阅快照。文档验证不替代真实第三方授权、模型调用、远端宿主或全部 Office 格式验收；相应报告必须说明实际运行范围。
