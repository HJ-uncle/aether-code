# 客户端完整验收：2026-10-09

以本轮 Playwright 原始 JSON 为准；workers 固定为 1，retries 为 0。

**结果：758 项，758 通过，0 失败，0 显式跳过，0 未运行；117 个文件。**

## 编译与运行基线

本完整 758 项验收绑定冻结版本 `sha256:a8a89f73942f86f277f1b807f296a9cbc0e16248ca7efadea9c3e0c78625f9b9`。两端同步后重新执行客户端 `npm run build`，typecheck:node、typecheck:web、主进程、preload 和 renderer 编译全部通过；renderer 入口产物为 `index-CcoS5QaF.js`。

真实 TGZ：`D:\dev\ai-agent-engine\.tmp\runtime-artifacts\aether-engine-2.0.0-a8a89f73942f.tgz`，228308855 bytes，SHA256 `bc4c4e7bdf6af9529c92318f860894d6431a0c6b77f45e3dc9a99eed0722ffde`，package/ 根。已启用 `AETHER_TEST_ENGINE_TGZ`，真实导入、激活、恢复默认与完整解压不再跳过。

[最终基线 build 日志](D:/dev/aether-code/.e2e-tmp/client-final-build-20261009.log) · [758 项完整日志](D:/dev/aether-code/.e2e-tmp/client-final-full-20261009.log)

本轮正式真实模型 R1 开发暴露了上下文超限与项目范围提示问题，因此该 run 已停止并保留证据，未执行 R1 真实客户端联动。修复后的新版本将重新同步、编译，并进行变更关联验收及 R2 真实五会话客户端验收。此处 758 项通过证明上述 a8a89 编译基线，不能宣称它们全部在后续修复版本重新执行。

## 验收层次

| 类型 | 文件 | 用例 | 通过 | 失败 | 跳过 | 未运行 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 纯函数或文件契约 | 50 | 402 | 402 | 0 | 0 | 0 |
| 真实 Electron UI | 64 | 326 | 326 | 0 | 0 | 0 |
| 本机进程、API 或文件集成 | 3 | 30 | 30 | 0 | 0 | 0 |

类型按测试文件的实际 electron.launch、本机进程/API 启动入口分类。同一文件的纯函数辅助断言计入该文件，不能将全部自动化用例称为全部真实 UI 测试。

真实 Electron 用例运行编译后的 out，经过 Chromium、preload 与 IPC。真实引擎对话用例采用本地可控制的模型 Provider，因此能严格验证工具和协议副作用；外部模型质量、长期可用性由本轮正式五会话真实模型开发另外验证。部分远端 UI 用例的 HTTP 服务是受控夹具，不能据此宣称互联网跨机器链路已完成；真实 12499 引擎与两个保留项目的客户端联动结果另有记录。

## 功能分类

| 功能 | 文件 | 用例 | 通过 | 失败 | 跳过 | 未运行 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 账号与认证 | 5 | 30 | 30 | 0 | 0 | 0 |
| MCP、Skill、知识库与记忆 | 7 | 29 | 29 | 0 | 0 | 0 |
| 对话、历史、审批、恢复与安全 | 19 | 133 | 133 | 0 | 0 | 0 |
| 远端连接与项目、文件、上传同步 | 11 | 61 | 61 | 0 | 0 | 0 |
| 浏览器与网络调试 | 9 | 45 | 45 | 0 | 0 | 0 |
| 文件改动、差异与撤回 | 8 | 50 | 50 | 0 | 0 | 0 |
| 命令任务与进程状态 | 3 | 20 | 20 | 0 | 0 | 0 |
| 工作台、布局与综合功能 | 7 | 105 | 105 | 0 | 0 | 0 |
| 模型、输入配置与辅助操作 | 4 | 20 | 20 | 0 | 0 | 0 |
| 编辑器、Monaco 与 LSP | 23 | 114 | 114 | 0 | 0 | 0 |
| 引擎打包、安装与通信 | 6 | 52 | 52 | 0 | 0 | 0 |
| Git 与项目隔离 | 5 | 38 | 38 | 0 | 0 | 0 |
| 子 Agent 生命周期与状态 | 2 | 18 | 18 | 0 | 0 | 0 |
| 终端与粘贴、尺寸、Shell | 6 | 32 | 32 | 0 | 0 | 0 |
| 工具反馈与开发操作 | 2 | 11 | 11 | 0 | 0 | 0 |

## 全部文件清单

| 文件 | 层次 | 用例 | 通过 | 失败 | 跳过 | 未运行 | 标题含远端/remote |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| account-boundary.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 1 |
| account-engine-integration.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 0 |
| account-http-trust.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| account-onboarding-contract.spec.ts | 纯函数或文件契约 | 2 | 2 | 0 | 0 | 0 | 0 |
| account-settings-ui.spec.ts | 真实 Electron UI | 15 | 15 | 0 | 0 | 0 | 0 |
| agent-resource-dialogue.spec.ts | 真实 Electron UI | 1 | 1 | 0 | 0 | 0 | 0 |
| anthropic-stream-ui.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 0 |
| approval-session-race.spec.ts | 纯函数或文件契约 | 22 | 22 | 0 | 0 | 0 | 0 |
| attachments-upload-ui.spec.ts | 真实 Electron UI | 7 | 7 | 0 | 0 | 0 | 1 |
| browser-agent-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| browser-local-ui.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| browser-native-validation.spec.ts | 纯函数或文件契约 | 6 | 6 | 0 | 0 | 0 | 0 |
| browser-navigation-ui.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| browser-network-collector.spec.ts | 纯函数或文件契约 | 11 | 11 | 0 | 0 | 0 | 0 |
| browser-network-ui.spec.ts | 真实 Electron UI | 5 | 5 | 0 | 0 | 0 | 0 |
| browser-occlusion.spec.ts | 纯函数或文件契约 | 7 | 7 | 0 | 0 | 0 | 0 |
| browser-surface-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| browser-ui.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| change-actions.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 0 |
| change-diff.spec.ts | 纯函数或文件契约 | 11 | 11 | 0 | 0 | 0 | 0 |
| change-net-ui.spec.ts | 真实 Electron UI | 7 | 7 | 0 | 0 | 0 | 0 |
| change-revert-contract.spec.ts | 纯函数或文件契约 | 17 | 17 | 0 | 0 | 0 | 0 |
| change-revert-ui.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| changes-panel-scroll-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| chat-artifact-link-ui.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 2 |
| chat-artifact-link.spec.ts | 纯函数或文件契约 | 14 | 14 | 0 | 0 | 0 | 0 |
| chat-file-path.spec.ts | 纯函数或文件契约 | 9 | 9 | 0 | 0 | 0 | 0 |
| chat-message-layout-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| chat-recovery-contract.spec.ts | 纯函数或文件契约 | 6 | 6 | 0 | 0 | 0 | 0 |
| chat-recovery-ui.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| command-job-contract.spec.ts | 纯函数或文件契约 | 11 | 11 | 0 | 0 | 0 | 0 |
| command-job-store.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 0 |
| command-job-ui.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| compact-panel-layout.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| composer-defaults-ui.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| diagnostics-state.spec.ts | 纯函数或文件契约 | 5 | 5 | 0 | 0 | 0 | 0 |
| edit-file-ui.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| editor-chat-context.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| editor-close-confirmation.spec.ts | 纯函数或文件契约 | 9 | 9 | 0 | 0 | 0 | 0 |
| editor-code-actions.spec.ts | 真实 Electron UI | 5 | 5 | 0 | 0 | 0 | 0 |
| editor-commands.spec.ts | 真实 Electron UI | 8 | 8 | 0 | 0 | 0 | 0 |
| editor-context-data.spec.ts | 纯函数或文件契约 | 12 | 12 | 0 | 0 | 0 | 0 |
| editor-diagnostic-policy.spec.ts | 纯函数或文件契约 | 2 | 2 | 0 | 0 | 0 | 0 |
| editor-display-settings.spec.ts | 纯函数或文件契约 | 4 | 4 | 0 | 0 | 0 | 0 |
| editor-document-races.spec.ts | 纯函数或文件契约 | 9 | 9 | 0 | 0 | 0 | 1 |
| editor-document-sync.spec.ts | 真实 Electron UI | 5 | 5 | 0 | 0 | 0 | 0 |
| editor-document-watch.spec.ts | 纯函数或文件契约 | 1 | 1 | 0 | 0 | 0 | 0 |
| editor-file-identity.spec.ts | 纯函数或文件契约 | 4 | 4 | 0 | 0 | 0 | 0 |
| editor-git-diff.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| editor-groups.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| editor-language-actions.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| editor-language-protocol.spec.ts | 纯函数或文件契约 | 7 | 7 | 0 | 0 | 0 | 0 |
| editor-project-language.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| editor-source-git-utils.spec.ts | 纯函数或文件契约 | 8 | 8 | 0 | 0 | 0 | 0 |
| editor-source-git.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| editor-source-preview.spec.ts | 真实 Electron UI | 5 | 5 | 0 | 0 | 0 | 0 |
| engine-host-contract.spec.ts | 真实 Electron UI | 10 | 10 | 0 | 0 | 0 | 6 |
| engine-import-ui.spec.ts | 真实 Electron UI | 9 | 9 | 0 | 0 | 0 | 1 |
| engine-runtime-store.spec.ts | 纯函数或文件契约 | 6 | 6 | 0 | 0 | 0 | 0 |
| engine-source-isolation.spec.ts | 纯函数或文件契约 | 9 | 9 | 0 | 0 | 0 | 4 |
| engine-storage-contract.spec.ts | 纯函数或文件契约 | 8 | 8 | 0 | 0 | 0 | 1 |
| engine-tgz-extract.spec.ts | 纯函数或文件契约 | 10 | 10 | 0 | 0 | 0 | 0 |
| file-change-preview.spec.ts | 纯函数或文件契约 | 4 | 4 | 0 | 0 | 0 | 0 |
| git-live-sync.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 1 |
| git-parsers.spec.ts | 纯函数或文件契约 | 14 | 14 | 0 | 0 | 0 | 0 |
| git-service-matrix.spec.ts | 真实 Electron UI | 8 | 8 | 0 | 0 | 0 | 1 |
| git-store-scope.spec.ts | 纯函数或文件契约 | 8 | 8 | 0 | 0 | 0 | 1 |
| git-workspace-scope-ui.spec.ts | 真实 Electron UI | 5 | 5 | 0 | 0 | 0 | 2 |
| history-replay.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| image-preview-interaction.spec.ts | 真实 Electron UI | 5 | 5 | 0 | 0 | 0 | 0 |
| knowledge-binding.spec.ts | 纯函数或文件契约 | 4 | 4 | 0 | 0 | 0 | 0 |
| knowledge-ui.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| lsp-diagnostics.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 0 |
| lsp-session-contract.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 1 |
| mcp-ui.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| memory-scope-state.spec.ts | 纯函数或文件契约 | 4 | 4 | 0 | 0 | 0 | 1 |
| memory-settings-crud.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| model-config-ui.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 0 |
| model-form-contract.spec.ts | 纯函数或文件契约 | 8 | 8 | 0 | 0 | 0 | 0 |
| monaco-localization.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| narrow-chat-layout.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 0 |
| pending-interactions.spec.ts | 纯函数或文件契约 | 12 | 12 | 0 | 0 | 0 | 0 |
| platform-feature-matrix.spec.ts | 真实 Electron UI | 11 | 11 | 0 | 0 | 0 | 0 |
| preview-resource-path.spec.ts | 纯函数或文件契约 | 5 | 5 | 0 | 0 | 0 | 0 |
| pure-functions.spec.ts | 纯函数或文件契约 | 38 | 38 | 0 | 0 | 0 | 0 |
| remote-auth-contract.spec.ts | 纯函数或文件契约 | 8 | 8 | 0 | 0 | 0 | 0 |
| remote-connection-contract.spec.ts | 本机进程、API 或文件集成 | 11 | 11 | 0 | 0 | 0 | 10 |
| remote-explorer-refresh-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 2 |
| remote-search-contract.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 0 |
| remote-terminal-contract.spec.ts | 本机进程、API 或文件集成 | 10 | 10 | 0 | 0 | 0 | 2 |
| remote-token-settings-ui.spec.ts | 真实 Electron UI | 9 | 9 | 0 | 0 | 0 | 2 |
| remote-workspace-list-contract.spec.ts | 纯函数或文件契约 | 1 | 1 | 0 | 0 | 0 | 1 |
| root-run-contract.spec.ts | 纯函数或文件契约 | 11 | 11 | 0 | 0 | 0 | 0 |
| root-run-ui.spec.ts | 真实 Electron UI | 9 | 9 | 0 | 0 | 0 | 1 |
| security-client.spec.ts | 纯函数或文件契约 | 11 | 11 | 0 | 0 | 0 | 0 |
| security-mode-lifecycle.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| security-state.spec.ts | 纯函数或文件契约 | 8 | 8 | 0 | 0 | 0 | 0 |
| settings-registry.spec.ts | 纯函数或文件契约 | 5 | 5 | 0 | 0 | 0 | 0 |
| skill-import-ui.spec.ts | 真实 Electron UI | 6 | 6 | 0 | 0 | 0 | 0 |
| smoke.spec.ts | 真实 Electron UI | 40 | 40 | 0 | 0 | 0 | 0 |
| streaming-model-contract.spec.ts | 纯函数或文件契约 | 5 | 5 | 0 | 0 | 0 | 0 |
| streaming-model-ui.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 0 |
| subagent-lifecycle.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 0 |
| subagent-state.spec.ts | 纯函数或文件契约 | 15 | 15 | 0 | 0 | 0 | 0 |
| terminal-actions-ui.spec.ts | 真实 Electron UI | 8 | 8 | 0 | 0 | 0 | 3 |
| terminal-clipboard.spec.ts | 真实 Electron UI | 5 | 5 | 0 | 0 | 0 | 1 |
| terminal-connection-ui.spec.ts | 真实 Electron UI | 3 | 3 | 0 | 0 | 0 | 1 |
| terminal-output.spec.ts | 纯函数或文件契约 | 10 | 10 | 0 | 0 | 0 | 0 |
| terminal-resize.spec.ts | 真实 Electron UI | 4 | 4 | 0 | 0 | 0 | 1 |
| terminal-shell-input.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| thinking-mode-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| thinking-scroll-ui.spec.ts | 真实 Electron UI | 1 | 1 | 0 | 0 | 0 | 0 |
| tool-ergonomics-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| tool-feedback.spec.ts | 本机进程、API 或文件集成 | 9 | 9 | 0 | 0 | 0 | 0 |
| utility-actions-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| workspace-live-sync-local.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 0 |
| workspace-live-sync.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 1 |

“标题含远端/remote”仅辅助定位，不能表示这些文件中的全部用例都是远端操作。

## 历史失败与修复

初轮 755 项：731 通过、8 失败、3 显式跳过、13 serial 未运行，原始日志、JSON 和 trace 均保留。

- 产品缺陷：123456 token 被转换成 123.456K，保存校验只接受整数 K，导致改名或编辑开关也被阻止。现支持最多三位小数 K，精确回转整数 token，统一表单与保存校验；保护原密钥和隐藏能力。新增 token 精度、非法输入、最大安全整数及真实表单编辑回归。
- 浏览器原生截图：desktopCapturer await 跨越 React/native 布局更新，旧 bounds 的采样点落到新网络面板。现仅采样 bounds 稳定帧并等待实际像素绘制，原六采样点和最大色差 4 的断言保留。
- 子 Agent 夹具：辅助记忆检索先到，其请求只有 user 消息、无工具；旧选择器误选它。现选择实际带 system 的 Agent 请求；此 code profile 专项夹具显式关闭记忆，其他记忆功能及默认会话记忆保持实测。中间失败仍保留。
- 根运行初轮 beforeAll 曾启动异常，原始证据保留。最终同步版本重点复跑未复现；新增公开 engine snapshot 诊断以便后续失败准确定位，不能把原因无证据归到某次修复。
- 诊断 reporter 将 serial 因前例失败而未执行误归环境 skip；现显式 skip 与未运行分开报告。

## 原始证据

[最终 Playwright JSON](D:/dev/aether-code/.e2e-tmp/client-final-full-20261009.json)

[逐条机器清单](D:/dev/aether-code/docs/test-reports/2026-10-09-client-full-acceptance.json)

构建、Runtime identity 和正式五会话模型/项目/资源指标以总报告及 runtime/longrun 原始证据为准。

## 最新修复版本关联验收

最终引擎/SDK/客户端资源同步版本为 `sha256:533c76315ca92ded4a0daa4bf4a0402a4b5108fafb4387b921e091ec77c18843`，两端生产文件及 staging 哈希比对无差异。客户端再次执行 `npm run build`，两段 typecheck 与三进程编译均通过。

针对上下文预算、压缩及项目范围提示变化，执行 42 项 / 11 文件关联验收：**42 通过，0 失败，0 跳过，0 未运行，workers 1，retries 0，2.3 分钟**。此处是最新修复版本的关联验证，前面的 758 项完整测试仍绑定 a8a89 基线。

覆盖 `root-run-ui`、`subagent-lifecycle`、`agent-resource-dialogue`、`memory-settings-crud`、`history-replay`、`browser-agent-ui`、`browser-surface-ui`、`browser-navigation-ui`、`tool-ergonomics-ui`、`tool-feedback`、`command-job-ui`：真实审批与恢复、子任务成功/错误/取消隔离、Skill+MCP+知识库对话、记忆CRUD、历史重启、浏览器Agent及原生绘制、微压缩后诊断回放与命令任务状态。

[最新版本 build 日志](D:/dev/aether-code/.e2e-tmp/client-r2-final-build-20261009.log) · [关联验收日志](D:/dev/aether-code/.e2e-tmp/client-r2-related-20261009.log) · [42 项原始 JSON](D:/dev/aether-code/.e2e-tmp/client-r2-related-20261009.json)

## R2 真实客户端过程联动

正式远端引擎 `http://127.0.0.1:12499`，5 个真实开发会话绑定两个保留项目，配置及快照的实际模型均为 3×`qwen3.8-flash` 与 2×`deepseek-v4.1-flash`。使用独立用户 profile 启动真正编译后的 Electron，正序及逆序各切换一遍，共 10 次。**过程联动通过，exit 0，rendererErrors 0，reload 恢复成功。**

检查历史用户消息、模型实际归属、服务端会话目录与本机 package.json 字节一致、资源树展示、子 Agent 的 rootSessionId 与界面每个 runId 归属。首轮选取时五会话界面实际恢复 12/8/3/12/2 张子任务卡；command-jobs API 为 17/9/4/19/2 个且所有 sessionId 正确。本轮正式模型任务没有显示后台 CommandJobCard，不能据此声称已验证正式模型后台卡展示；后台卡交互另外由最新关联 command-job-ui 覆盖。

首次过程 helper 因仅等待 `.subagent-group__head` 在第 3 会话失败，证据保留。真实界面只有连续多个子调用组成组，单次调用直接显示完整卡；S3 历史/投影中的父 toolCallId、子任务都完整。修正 helper 接受真实单卡或组头入口，仍要求实际卡非空、全部 runId 属于当前会话，未修改产品/引擎或降低模型、项目、历史断言。复跑全部 10 次通过。

[首次失败与截图](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/run-20261009T073642124Z-qUttIX/client-live-20261009T074940743Z/result.json) · [父调用结构证据](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/run-20261009T073642124Z-qUttIX/client-active-s3-structure.json) · [修正后过程结果与10张截图](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/run-20261009T073642124Z-qUttIX/client-live-20261009T075314052Z/result.json)

过程信号写入 `client-active-acceptance.json`；最终 `client-acceptance.json` 尚未签出，正式任务仍继续。终态恢复验收与项目真实 CRUD 验收应独立收口。

过程联动两次应用关闭期间，引擎 stderr 保留了 node-pty `console-list` helper 的 `AttachConsole failed` 异常。同步验收确认这是 helper 在客户端 close 后的 AttachConsole 竞态：应用 close 本身成功、rendererErrors 0，主引擎健康检查继续返回 200，未发现残留 PTY/子进程或引擎退出。该输出不能隐去，也不能由此宣称生产终端没有任何退出竞态；本轮冻结版本未再修改 PTY，后续应作为单独问题修复并回归。最终终态联动继续保留同一 stderr 原始证据。

## R2 终态与独立副本恢复

正式 R2 整体验收失败：完成 26/50 角色阶段，不能宣称长任务整体通过。原 orchestrator 结束时未保留客户端最终门窗口，服务先回收；原 run 没有回填客户端最终通过。独立终态恢复用同一 533c 打包引擎，先完整复制已关闭 run 的 DB/WAL/SHM/global/sessions 等状态并核对哈希；原状态前后不变。所有恢复证据属于新启动的副本服务，不扩大成原运行的健康、资源或并发时间证明。

**完整项目恢复失败**：首会话历史、实际模型和终态已恢复，但 `/workspace/directory` 返回 default 私有目录，原 ops-board 绑定在引擎重启后丢失。源 `WorkspaceManager` 的 bindings/bindingOwners 仅为进程内 Map，没有持久化。失败断言、截图和原状态保全证据保留；没有重新绑定后伪装为完整通过。此缺陷由后续引擎工作区持久化修复处理。

[完整恢复失败](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/replay-20261009T085028261Z-477zry/client-live-20261009T085122683Z/result.json)

另起完整状态副本，明确采用 **history-only** 验收范围：真实 Electron 正逆序切换 5 会话共10次，严格核对 533c 握手 buildId、3Qwen/2DeepSeek实际模型、finished 和真实根运行终态、子卡归属、最新用户消息与reload恢复；**通过，rendererErrors 0**。该结果没有证明项目绑定恢复通过。

长历史基于实际 archive 用户 ID 与 turn ID核验：S1 354条原始归档/17用户，界面最初6用户，实际点击“压缩归档中的更早对话”一次后恢复全部17用户；首阶段1与末阶段10的消息ID、turn及文本标记完全一致。S4 306条归档/16用户，初次已显示全部16用户，加载0次。两会话合并后的渲染消息未达到300条窗口门槛，**真实窗口分页0次**，不能把原始归档条数超过300当成已测窗口分页。所有界面用户ID与当前会话归档完全一致、无重复或跨会话，首末截图保留。

[终态history-only与首末截图](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/replay-20261009T085418544Z-nNVb6a/client-live-20261009T085503123Z/result.json) · [副本状态身份](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/replay-20261009T085418544Z-nNVb6a/state-copy-identity.json) · [原状态保全](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/replay-20261009T085418544Z-nNVb6a/original-preservation.json) · [PID及启动时间精确清理](D:/dev/ai-agent-engine/test-projects/longrun-20261009/runs/replay-20261009T085418544Z-nNVb6a/cleanup-processes.json)

两次副本恢复进程均精确回收，remaining/errors 0，原状态SHA门 true。history-only信号为 `client-history-acceptance.json`，没有写入原R2或将原full恢复失败改为通过。
