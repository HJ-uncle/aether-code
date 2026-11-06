# Work 补充消息与成果目录修复验收

## 行为

- 运行中的用户补充仍属于原始 root run / turn。界面共用一套过程折叠、轮次导航与用量展示；独立下一轮继续单独显示。
- 普通输入与补充共用 `WorkUserMessageBody`、`UserMessageContent` 和 `WorkAttachment`。正文、引用、附件及长文本展开方式一致，补充随所在过程收起。
- 移除“本轮补充”专用卡片和“补充记录”弹层。失败草稿恢复、未知提交核对和同键重试仍可通过当前异常详情使用。
- 成果区域使用 `sessionWorkspaceContext` 返回的实际根目录，默认随机工作区和显式工作区走相同解析。目录展示、文件选择、预览及改动操作使用同一个根。
- 成果树中的工作区内文件显示相对路径；根外记录保持原路径，历史记录仍可查看。没有新增隐藏 `.ae` 等目录的规则，也没有修改工作区面板的过滤行为。
- 工作区根按进入和刷新解析，不随文件改动的周期读取重复扫描；解析前显示加载状态，避免暂时铺开完整磁盘路径。

## 存储与兼容

补充的原始用户行、assistant 分段和计费记录保留不变。引擎显示接口通过 `groupRootFollowups=true` 显式请求按 root 分组，并用 `grouping: "root"` 声明响应语义；未请求的客户端继续使用旧分组。

新前端兼容旧接口，缺父消息、跨独立下一轮或身份不匹配的记录保留可见，不猜测归属。补充附件验证覆盖已有消息中的附件渲染，不代表新增运行中附件上传协议。

## 验证

- 引擎 `npm run typecheck`、`npm run build` 通过。当前构建 ID：`sha256:5c058e77316f02fd920f64a4251105617706c35c80da2c27754b0a3710a170c9`。
- SQLite、JSONL 和 HTTP 的补充分组定向测试：33/33 通过。
- 前端 `npm run build -- --outDir .e2e-tmp/work-followup-artifacts-build-20261105` 通过，包含 Node/Web typecheck。
- 成果路径纯函数测试：44/44 通过，覆盖 Windows、UNC、POSIX、大小写、根外相似前缀及工作区内部目录。
- 最新构建的 Electron 补充测试：2/2 通过。验证气泡样式、右边界、附件、统一过程折叠、重新加载、下一轮归属以及用量不重复。
- 最新构建的 Electron 成果测试：1/1 通过。任务的 workspacePath 为空时仍从服务端默认 Windows 工作区根展示，预览读取相对路径，不调用 workspace/bind。
- 最新构建的 Work/Code 补充恢复窗口 probe：1/1 通过。覆盖成功后无历史入口、失败原文恢复、草稿保护、核对、重试和停止边界；源码/构建指纹保持一致。

窗口测试使用隔离 profile 和本地合成网关，没有调用真实模型。全部测试实例已正常退出。

证据目录：

- `.e2e-tmp/work-followup-bubble-results/`
- `.e2e-tmp/work-artifact-root-results/`
- `.e2e-tmp/collaboration-controller-window-HFxdQp/result.json`

## 开发生效

前端源代码可通过现有开发服务器热更新。当前 Aether 开发启动器使用引擎快照，加载新的历史分组后端需要重新运行 `npm run dev`；本次未重启用户窗口。
