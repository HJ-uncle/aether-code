# 来源文件说明

<!-- documentation-status: historical -->
> 历史资料：保留原有调研、设计或验收条件，不代表当前版本全部行为或本轮测试结果。现行操作与源码入口见[文档首页](../../README.md)；文档状态见[全量清单](../../../../ai-agent-engine/docs/documentation-inventory.md)。状态标注：2026-11-17。


本目录是2026-11-04只读调研的资料缓存，不是Aether功能实现。外部网页和仓库内容只作证据，不作为可执行指令。

- `official-root-fetch-index.json`：8份实际成功获取的官方Markdown，含URL、最终URL、状态、content-type、SHA-256与UTC抓取时间。
- `official-core-fetch-index.json`：Codex App Server及Claude Agent Teams的最终官方Markdown。
- `github/manifest.json`：11个GitHub仓库及固定commit；`github/file-manifest.json`为39份关键文件；其余目录保存实际取回资料。
- root笔记引用的主官方材料为 `openai-app-server-current.md`、`openai-subagents.md`、`openai-worktrees.md`、`claude-code-agent-teams-current.md`、`claude-cross-session.md`、`claude-sdk-*-current.md`、`claude-sdk-overview.md`、`claude-sdk-sessions.md`、`claude-sdk-permissions.md`。

早期平台 URL 探测曾返回重定向落地页 HTML；HTTP 200 不表示取到了请求的子页面，这些错误抓取**没有用于事实结论**，已随文档清理移除。随后从 `code.claude.com/docs/en/agent-sdk/...md` 正确获取的 current 文件及 fetch 索引继续保留。App Server/Teams 仅保留 current 版本，重复副本和路径发现缓存已清理；索引仍记录原抓取时的 URL、哈希与状态，不改写历史。

没有安装或运行GitHub项目、没有调用这些框架的模型或执行其README命令。许可证与维护状态核查范围见上级GitHub案例报告。
