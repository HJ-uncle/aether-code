# 客户端完整验收：2026-10-09

以本轮 Playwright 原始 JSON 为准；workers 固定为 1，retries 为 0。

**结果：764 项，762 通过，2 失败，0 显式跳过，0 未运行；118 个文件。**

## 验收层次

| 类型 | 文件 | 用例 | 通过 | 失败 | 跳过 | 未运行 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 纯函数或文件契约 | 51 | 405 | 405 | 0 | 0 | 0 |
| 真实 Electron UI | 64 | 326 | 324 | 2 | 0 | 0 |
| 本机进程、API 或文件集成 | 3 | 33 | 33 | 0 | 0 | 0 |

类型按测试文件的实际 electron.launch、本机进程/API 启动入口分类。同一文件的纯函数辅助断言计入该文件，不能将全部自动化用例称为全部真实 UI 测试。

真实 Electron 用例运行编译后的 out，经过 Chromium、preload 与 IPC。真实引擎对话用例采用本地可控制的模型 Provider，因此能严格验证工具和协议副作用；外部模型质量、长期可用性由本轮正式五会话真实模型开发另外验证。部分远端 UI 用例的 HTTP 服务是受控夹具，不能据此宣称互联网跨机器链路已完成；真实 12499 引擎与两个保留项目的客户端联动结果另有记录。

## 功能分类

| 功能 | 文件 | 用例 | 通过 | 失败 | 跳过 | 未运行 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 账号与认证 | 5 | 30 | 30 | 0 | 0 | 0 |
| MCP、Skill、知识库与记忆 | 7 | 29 | 29 | 0 | 0 | 0 |
| 对话、历史、审批、恢复与安全 | 19 | 133 | 133 | 0 | 0 | 0 |
| 远端连接与项目、文件、上传同步 | 11 | 64 | 64 | 0 | 0 | 0 |
| 浏览器与网络调试 | 9 | 45 | 45 | 0 | 0 | 0 |
| 文件改动、差异与撤回 | 8 | 50 | 50 | 0 | 0 | 0 |
| 命令任务与进程状态 | 3 | 20 | 20 | 0 | 0 | 0 |
| 工作台、布局与综合功能 | 8 | 108 | 108 | 0 | 0 | 0 |
| 模型、输入配置与辅助操作 | 4 | 20 | 20 | 0 | 0 | 0 |
| 编辑器、Monaco 与 LSP | 23 | 114 | 114 | 0 | 0 | 0 |
| 引擎打包、安装与通信 | 6 | 52 | 51 | 1 | 0 | 0 |
| Git 与项目隔离 | 5 | 38 | 38 | 0 | 0 | 0 |
| 子 Agent 生命周期与状态 | 2 | 18 | 18 | 0 | 0 | 0 |
| 终端与粘贴、尺寸、Shell | 6 | 32 | 31 | 1 | 0 | 0 |
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
| engine-import-ui.spec.ts | 真实 Electron UI | 9 | 8 | 1 | 0 | 0 | 1 |
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
| pty-lifecycle-contract.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 0 |
| pure-functions.spec.ts | 纯函数或文件契约 | 38 | 38 | 0 | 0 | 0 | 0 |
| remote-auth-contract.spec.ts | 纯函数或文件契约 | 8 | 8 | 0 | 0 | 0 | 0 |
| remote-connection-contract.spec.ts | 本机进程、API 或文件集成 | 11 | 11 | 0 | 0 | 0 | 10 |
| remote-explorer-refresh-ui.spec.ts | 真实 Electron UI | 2 | 2 | 0 | 0 | 0 | 2 |
| remote-search-contract.spec.ts | 纯函数或文件契约 | 3 | 3 | 0 | 0 | 0 | 0 |
| remote-terminal-contract.spec.ts | 本机进程、API 或文件集成 | 13 | 13 | 0 | 0 | 0 | 2 |
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
| terminal-resize.spec.ts | 真实 Electron UI | 4 | 3 | 1 | 0 | 0 | 1 |
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

[最终 Playwright JSON](D:/dev/aether-code/.e2e-tmp/client-strict-final-full-20261009.json)

[逐条机器清单](D:/dev/aether-code/docs/test-reports/2026-10-09-client-strict-intermediate-full.json)

构建、Runtime identity 和正式五会话模型/项目/资源指标以总报告及 runtime/longrun 原始证据为准。
