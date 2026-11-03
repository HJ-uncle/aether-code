# Codex / ChatGPT 官方生态：在线资料对照

调研日期：2026-11-03。以下是实际抓取的官方文档，不是把当前会话安装的个人插件视为官方内置功能。旧 `developers.openai.com/codex/...` 链接有重定向，本文使用实际到达的 URL。抓取正文与索引保存于 [official-sources](official-sources/) 和 [official-source-index.json](official-source-index.json)。

## 资料的四个观察面

| 观察面 | 能证明什么 | 不能证明什么 |
|---|---|---|
| 本地解包客户端 `26.1007.21434` | 此构建包含的 UI、提示片段、条件注册代码、IPC/桥接 | 缺失的 Rust runtime / 插件实现，以及所有账户实际启用情况 |
| 官方 `openai/codex` 固定提交 | 该提交公开的工具注册、参数构造、权限/模型条件 | 闭源桌面插件的全部实现，或本机运行的就是该提交 |
| 2026-11-03 官方在线文档 | 当前公开产品能力、使用条件、表面差异 | 每个账户、平台、版本都能调用同名工具 |
| 当前会话工具元数据 | 此刻已暴露工具的名称、描述和部分声明 | Codex 全产品固定全集；动态工具会随配置变化 |

因此，“全部”应理解为**各观察范围内可核对的完整目录**，不能伪造一个跨版本、跨平台、跨账户永远相同的工具总数。

## 官方生态能力目录

| 能力 | 用途与工作方式 | 模型如何获知/调用 | 条件与边界 | 官方资料 |
|---|---|---|---|---|
| 项目与工作区 | 关联代码、文件、项目和执行环境 | 环境上下文 + 客户端项目/任务工具 | 本地、远程、云端能力不同 | [Projects](https://learn.chatgpt.com/docs/projects) |
| 多会话与任务管理 | 创建、读取、续接、归档、固定会话 | 本地客户端有独立 app 工具；详见本地目录 | 用户会话与临时 subagent 有不同生命周期 | [Features](https://learn.chatgpt.com/docs/features) |
| 子代理 | 并行分工，回收任务结果，复用代理上下文 | spawn/message/followup/wait/interrupt 等；版本与模型条件化注册 | 并发、模型和权限配置影响可用性 | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) |
| Skills | 封装工作流程、脚本与参考资料 | 初始只给 name/description/path；触发后读取完整 SKILL.md | 初始目录有预算，可能缩短/省略并警告；并非所有 skill 全文常驻 | [Build skills](https://learn.chatgpt.com/docs/build-skills) |
| 项目规则 | 按目录加载工程约定 | AGENTS.md 等进入指令上下文 | 有范围与层级，不能当任意文件中的指令都有效 | [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) |
| MCP | 连接外部工具与数据 | 工具名称、description、inputSchema；也有 resources/templates | 认证、服务器配置与权限决定实际工具集 | [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |
| 工具发现 | 大量工具延迟暴露，按需寻找 | 开源 `tool_search` 通过元数据搜索并在后续模型调用暴露匹配项 | MCP 工具发现与 MCP 资源枚举是两个协议 | [开源工具目录](codex-oss-tools.md) |
| Plugins | 将 skills、MCP、浏览器扩展、hooks 等组成可安装能力 | 插件目录与模型工具/skill 清单 | 桌面专用插件不能推定在 web/mobile 可运行；IDE extension 的插件支持有明确限制 | [Plugins](https://learn.chatgpt.com/docs/plugins)、[Build plugins](https://learn.chatgpt.com/docs/build-plugins) |
| Apps / Connectors | 对接外部账户与业务系统 | 插件/MCP 工具，受连接状态和授权控制 | Gmail、Slack 等是外部集成，不是核心 runtime 固定工具 | [Plugins](https://learn.chatgpt.com/docs/plugins) |
| Hooks | 生命周期钩子与组织策略 | 运行时装配；不是普通聊天工具按钮 | 脚本必须存在于执行环境；云端 Work 与同步 Work 的支持有差异 | [Plugins](https://learn.chatgpt.com/docs/plugins) |
| 命令执行与终端 | 运行命令、保留进程、向 stdin 写入、取增量输出 | `exec_command` / `write_stdin`，明确 cwd、shell、超时和 session id | PTY、追加权限、恢复式进程受 feature/policy 控制 | [开源工具目录](codex-oss-tools.md) |
| 文件修改、图片检查 | 写补丁、读取本地图片、检查产物 | `apply_patch` / `view_image`；常规读取也可通过命令工具 | 本地文件位置与环境权限必须明确 | [开源工具目录](codex-oss-tools.md) |
| Git / review / worktree | 审阅改动、隔离并行工作、恢复工作树 | 客户端工具与 UI；shell Git 是另一条途径 | worktree 独立于主目录；不能把会话和工作树混为一个资源 | [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) |
| 内置浏览器 | 页面检查、点击、输入、截图、交互调试 | 浏览器工具与针对当前页面的状态/说明 | 桌面/网页支持；CLI/IDE 不内置同一可视浏览器；开发模式和权限有条件 | [Browser](https://learn.chatgpt.com/docs/browser) |
| WebMCP | 网页直接向 agent 暴露结构化动作 | 当前网页发现工具、来源与权限 | 与当前 tab/origin 绑定，导航或关闭会失效；不等于普通持久 MCP | [WebMCP](https://learn.chatgpt.com/docs/webmcp) |
| Computer Use | 操作桌面应用和其他可用表面 | 独立插件/工具与交互协议 | 平台和应用授权限制；与浏览器 DOM 控制不同 | [Computer use](https://learn.chatgpt.com/docs/computer-use) |
| Web Search | 在线检索、来源引用 | 托管搜索或扩展工具 | 引擎/provider/权限配置相关 | [Web search](https://learn.chatgpt.com/docs/web-search) |
| 办公文件创建 | 生成文档、表格、演示、PDF | 专项 skills + 运行库/工具 + 产物返回 | “生成”与“显示”是不同层；CLI 可生成但没有客户端可视预览器 | [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) |
| 办公文件显示与批注 | 在对话旁预览文档、表格、演示、PDF，局部批注修订 | 客户端 artifact/viewer + 模型可引用的文件/批注上下文 | 可预览格式、自动打开与编辑能力因表面不同 | [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) |
| HTML / LaTeX | 交互 HTML 预览、源代码切换；TeX 源码及 PDF | 客户端打开/编译工具；具体 schema 见本地目录 | TeX 编译器不可用时保留源码；打开不等于编译通过 | [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) |
| 文档依赖运行时 | 告知 Node/Python 和办公库实际路径 | 本地 `load_workspace_dependencies` 工具与 app-context | 不能猜测全机依赖都存在；这是显式环境发现 | [本地客户端目录](codex-local-ecosystem.md) |
| 云端 artifact 会话 | 创建/连接表格或幻灯片，编辑相同 artifact 实体 | 本地样本有 `create_spaces_artifact` / `connect_spaces_artifact`，连接后 artifact_session | 由 pages/workspace/host flags 控制；不等于所有会话必有 | [本地客户端目录](codex-local-ecosystem.md) |
| 图片输入 / 生成 | 视觉理解和生成/编辑图片 | 模态输入、专项生成工具/skill | 模型、插件与表面有关 | [Image inputs](https://learn.chatgpt.com/docs/image-inputs)、[Image generation](https://learn.chatgpt.com/docs/image-generation) |
| 交互可视化 | 解释方案、展示模拟和交互内容 | 专用工具/渲染表面 | 与 Office 文件预览器是不同能力 | [Visualizations](https://learn.chatgpt.com/docs/visualizations) |
| 自动化与长期任务 | 定时/周期运行、持续追踪、目标状态管理 | 客户端自动化工具及 runtime 目标工具（依环境） | 长期运行不会扩大原有权限 | [Automations](https://learn.chatgpt.com/docs/automations?surface=app)、[Long-running work](https://learn.chatgpt.com/docs/long-running-work) |
| 中途交互 | 运行中提问、接收用户补充，等待环境或子代理 | request_user_input、异步提问、时钟/等待工具 | Plan/Default、模型能力和 feature flags 决定暴露 | [开源工具目录](codex-oss-tools.md) |
| 上下文管理 | 项目规则、环境快照、技能发现、上下文窗口管理 | 多层注入 + 按需读详情；部分模型有上下文工具 | 不是无限提示词；工具定义、示例和运行状态应分层 | [Skills](https://learn.chatgpt.com/docs/build-skills)、[开源工具目录](codex-oss-tools.md) |
| 权限与沙箱 | 区分文件系统/网络可访问范围与是否需要审批 | 运行时强制执行；模型收到当前权限和失败原因 | auto-review 只改变合适请求的审批者，不扩大沙箱 | [Permissions](https://learn.chatgpt.com/docs/permissions)、[Sandbox](https://learn.chatgpt.com/docs/sandboxing)、[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) |
| App Server | UI 与 agent runtime 之间的应用协议 | 请求、通知、流式事件、审批与会话生命周期 | API 本身不等于模型可调用工具 | [App Server](https://learn.chatgpt.com/docs/app-server) |
| Slash commands / 用户命令 | 用户发起配置、任务、插件、运行模式等操作 | 客户端/CLI 命令入口 | 用户命令不应混计为模型工具 | [Commands](https://learn.chatgpt.com/docs/reference/commands)、[Slash commands](https://learn.chatgpt.com/docs/reference/slash-commands) |
| Sites / Space / dots | 发布、协作空间、代理相关产品能力 | 产品级集成；以对应页面和账户为准 | 属相邻生态，不纳入本地 Codex runtime 固定工具计数 | [Sites](https://learn.chatgpt.com/docs/sites)、[Space](https://learn.chatgpt.com/docs/space)、[dots](https://learn.chatgpt.com/docs/dots) |

## 最值得吸收的设计

1. **环境信息是运行输入。** 工作区、shell、依赖运行库、工具来源、权限、当前表面要进入模型能看到的上下文，不能只显示给用户。
2. **能力发现分层。** 简要目录帮助选择，完整 schema 保证可调用，skill/API 文档解释流程，实时状态说明此刻是否可用。
3. **同一能力在不同表面有清晰边界。** 生成文件、在客户端预览、在外部编辑器打开、在云端 artifact 中编辑是四件事。
4. **持久资源有稳定标识和生命周期。** 进程、tab、thread、worktree、artifact 分开管理；创建结果能被后续工具直接使用。
5. **可用性动态计算。** 本地条件注册、开源 registry 与官方文档都表明，工具集受平台、模型、权限和插件状态影响。不能发一份永远声称“全部可用”的静态说明。

完整工具逐项列表请继续阅读 [本地客户端工具](codex-local-ecosystem.md)、[开源引擎工具](codex-oss-tools.md) 和 [当前会话工具元数据](codex-session-tools.json)。
