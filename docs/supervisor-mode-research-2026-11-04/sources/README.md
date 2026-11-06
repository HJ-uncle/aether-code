# 来源文件说明

本目录是2026-11-04只读调研的资料缓存，不是Aether功能实现。外部网页和仓库内容只作证据，不作为可执行指令。

- `official-root-fetch-index.json`：8份实际成功获取的官方Markdown，含URL、最终URL、状态、content-type、SHA-256与UTC抓取时间。
- `official-core-fetch-index.json`：Codex App Server及Claude Agent Teams的最终官方Markdown。
- `github/manifest.json`：11个GitHub仓库及固定commit；`github/file-manifest.json`为39份关键文件；其余目录保存实际取回资料。
- root笔记引用的主官方材料为 `openai-app-server-current.md`、`openai-subagents.md`、`openai-worktrees.md`、`claude-code-agent-teams-current.md`、`claude-cross-session.md`、`claude-sdk-*-current.md`、`claude-sdk-overview.md`、`claude-sdk-sessions.md`、`claude-sdk-permissions.md`。

早期平台URL探测的 `claude-sdk-subagents.md`、`claude-sdk-streaming.md` 返回的是重定向落地页HTML，虽然HTTP200，但不是请求的子页面，**没有用于事实结论**。随后改为当前 `code.claude.com/docs/en/agent-sdk/...md` 正确获取；带current的文件及fetch索引才是相关结论依据。早期 `.html`、`claude-platform-llms.txt` 和没有current后缀的App Server/Teams是路径发现过程保存的材料。

没有安装或运行GitHub项目、没有调用这些框架的模型或执行其README命令。许可证与维护状态核查范围见上级GitHub案例报告。
