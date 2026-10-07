# Code 模式的工具隔离

Aether 的普通 HTTP 请求和 SSE 请求由主进程统一携带 `X-Aether-Tool-Profile: code`。嵌入引擎与远程引擎使用相同协议；不带此标识的通用客户端继续使用 `general` 配置。

引擎在工具注册时选择可执行集合。被排除的工具既不会出现在模型 schema、工具查询接口和 `get_current_context` 中，也无法通过手写工具名称调用。子代理从父注册表取得权限交集，编辑消息、重新生成和 Flow 节点同样传递当前请求的 profile。

## 默认范围

| 类别 | Code 模式 |
| --- | --- |
| 文件 | 保留 `read_file`、`write_file`、`edit_file`、`list_files`、`delete_file`、`create_dir` |
| 搜索、命令与诊断 | 保留 `glob_search`、`grep_search`、`execute_cmd`、`command_output`、`cancel_command`、`code_diagnose`、`codegraph` |
| 编程协作 | 保留 `subagent`、`todo_*`、`ask_user`、`get_current_context` |
| 技能与扩展 | 保留 `list_skills`、`get_skill`、`run_skill_script`，以及已配置的技能/MCP 工具 |
| 联网 | 保留 `web_fetch`、`http_request` |
| 通用服务管理 | 隔离 `cron_*`、`agent_*`、`task_*` |
| 长期记忆 | 隔离记忆工具、上下文中的近期记忆、自动召回/提取，以及客户端内联长期记忆注入；每个会话可选择关闭、全局或仅本会话 |
| 通用辅助工具 | 隔离 `install_package`、`list_packages`、`calculate`、`get_time` |

不含扩展时，共 25 个编程相关内置工具。`task_*` 管理的是引擎通用租户任务队列，与 IDE 终端、`todo_*` 清单及子代理运行状态不同；隔离它不会移除后几项功能。

`allowedTools` 可进一步缩小 Code 集合，不能重新开启被隔离的工具；空数组表示不开放工具。旧配置名 `run_command`、`glob`、`grep`、`smart_read` 映射为实际工具名。OSM 的 off/balanced/methodology/max 只保持各自的方法论行为，不改变 Code 工具边界。

工具 profile 按请求创建，不修改全局环境或其它客户端。现有安全审批、子代理只读能力与操作系统权限继续生效。工具 profile 不是操作系统沙箱；已保留的命令、脚本和联网工具仍按各自原有权限执行。

## 会话记忆范围

聊天输入框的「对话偏好 → 长期记忆」按当前会话保存设置：

- `关闭记忆`（`off`）不读取、不写入长期记忆；
- `全局记忆`（`global`）在同一租户的其他会话中也可召回；
- `仅本会话`（`session`）只读取和写入当前会话，切换会话或引擎连接后不会复用旧快照。

范围设置由引擎按租户和会话持久化，远端连接由远端引擎负责保存。客户端在设置尚未确认时会按 `off` 发送，避免旧设置意外扩大可见范围；引擎禁用长期记忆时，界面会保留设置但有效范围为 `off`。

## 验证

2026-09-29：两仓 typecheck/build 通过；引擎 7 文件、98 条相关测试通过；IDE 15 条状态测试和 3 条真实 Electron 生命周期测试，共 18/18 通过。

验证覆盖实际注册与拒绝执行、通用模式兼容、白名单缩窄、MCP/技能注册、HTTP 请求标识及子代理继承。Electron 验收通过真实 preload/主进程请求 `/tools`，并检查实际发给本地模型服务的父子工具 schema，以及子代理执行、取消和历史回放。

引擎测试首次并行运行遇到 Windows 临时模块 EBUSY，串行完整复跑后 98/98 通过。Electron 首轮命中已有子代理详情 UI 改版导致的旧选择器；测试按现有“执行详情”按钮和工具行展开方式更新后完整复跑通过，没有为测试修改产品 UI。
