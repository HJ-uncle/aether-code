# 浏览器会话与子代理步数限制修复（2026-10-12）

本次对应两个问题：手动打开的网页未被 AI 发现，以及子代理以“达到探索步数上限”提前结束。修改涉及本客户端和同级 `D:/dev/ai-agent-engine`，部署时需要更新两端。

## 原因与修改

### 手动网页、标签菜单和会话引用

- `browser_tabs` 按引擎及会话归属过滤。用户先开网页、后连接引擎时，网页没有归属；原实现没有在连接成功后补绑。
- 现在在同一引擎、同一账号连接成功后，补绑没有归属的用户网页，保留原 WebContents、导航和页面状态。已有归属的网页不会自动转移给另一会话。
- 标签右键菜单支持新建、复制、刷新、停止、复制地址、开发者工具、添加到当前会话、关闭当前／其他／右侧／全部；支持中键关闭、Shift+F10、方向键和焦点恢复。
- “添加到当前会话”同时授权当前会话操作该网页，并插入浏览器引用；引用包含精确 tabId、URL、标题及会话身份。页面标题等作为结构化数据传递，不当作文件路径或执行指令。保留草稿，不自动发送。
- 分享 IPC 必须携带预期会话及引擎身份；会话切换后的迟到请求被拒绝。跨会话错误明确提示用户添加现有网页，不再诱导重新打开。
- Work 浏览器绑定提升到常驻 WorkView，使用当前任务或持久化首页会话；Work 不再回退到 Code 会话。两种模式的草稿引用分别保存。

### 探索步数限制

- 原来的默认值已经不限步数，但 `subagent` 工具仍暴露 `maxSteps`，模型可以传入有限值；该值优先于 Code 的默认无限策略，引擎在最后一步强制总结并终止。
- 删除模型可见的 `maxSteps` 参数。兼容旧调用时忽略这个字段，子代理循环始终使用无限迭代策略，既有会话的旧工具参数也不能重新开启步数截断。
- 修复 Code 子代理直接调用时的 fallback 预算路径：不再读取 `SUBAGENT_TOKEN_LIMIT` 并意外截断。
- 同步清理主／子代理提示词及现行长测驱动脚本中的步数上限指令，更新工具文档。历史测试报告保留原样。
- 用户取消、显式配置的截止时间／请求预算、上下文容量、权限与故障保护仍按真实原因记录终态；没有将部分结果伪装为完成。

## 验证记录

使用隔离数据库、测试工作区、本地模型夹具及独立 Electron 实例，没有连接业务网站或真实模型账户。测试中的 180 万 Token 是模拟计量，不是实际消耗。

- 客户端 `npm run typecheck`、`npm run build` 通过。
- 引擎 `npm run typecheck`、`npm run build` 通过。构建 ID：`sha256:883e7884433b82357400a1f7798fffcfb40d4c3da6e4fa22a91267759dfaef72`。
- 引擎两批针对性回归：48 + 56 = 104 条通过。
- 长测驱动器 `node --test scripts/longrun/project-driver.test.mjs`：26 条通过。
- 新浏览器会话、身份校验及引用序列化：28 条通过。
- 已有浏览器、编辑器引用、Work 与子代理生命周期扩展回归：71 条通过（2.2 分钟）。客户端共 99 条，本次两仓库共 229 条针对性测试通过，0 失败、0 跳过。不是全产品全量用例。

新增长任务回归只替换模型响应，实际执行 ReAct、子代理调度、35 次文件读取、SQLite 任务状态持久化和 JSONL 历史回放。分别携带旧 `maxSteps: 25`／`maxSteps: 1`，均执行到第 36 次模型请求；正常分支完成，取消分支保存取消状态，累计模拟计量超过 180 万。并未声称它是连续 24 小时或 168 小时耐久测试。

首轮浏览器测试在复制地址后同步读取剪贴板，早于异步写入完成而失败；修正为等待复制成功提示和副作用后，28 条全部通过。测试保存并恢复剪贴板，失败断言不打印既有内容。

扩展回归覆盖实际模型工具 → 引擎 → IPC → 原生网页输入点击、截图、多标签隔离、关闭／断连／取消后的迟到操作抑制、网络和导航记录、视口绘制、Work 草稿及会话恢复，以及真实子代理取消和重启回放。Electron 健康监控未发现原生崩溃，测试实例正常退出。

复跑客户端（先 `npm run build`，保持单 worker）：

```powershell
npx playwright test e2e/browser-session-ui.spec.ts e2e/browser-native-validation.spec.ts e2e/editor-context-data.spec.ts --reporter=list
npx playwright test e2e/browser-agent-ui.spec.ts e2e/browser-multitab-ui.spec.ts e2e/browser-ui.spec.ts e2e/browser-local-ui.spec.ts e2e/browser-navigation-ui.spec.ts e2e/browser-network-ui.spec.ts e2e/browser-surface-ui.spec.ts e2e/editor-chat-context.spec.ts e2e/work-mode.spec.ts e2e/work-state.spec.ts e2e/subagent-lifecycle.spec.ts --reporter=list
```

复跑引擎（工作目录 `D:/dev/ai-agent-engine`）：

```powershell
npx vitest run src/tools/subagent/__tests__/subagent-unbounded.test.ts src/tools/subagent/__tests__/subagent-capabilities.test.ts src/tools/subagent/__tests__/subagent-project-overview.test.ts src/core/subagent/__tests__/subagent-runtime.test.ts src/tools/browser/__tests__/browser-failures.test.ts src/core/__tests__/code-agent-prompt.test.ts --maxWorkers=1 --minWorkers=1
npx vitest run src/core/agent-loop/__tests__/react.test.ts src/core/agent-loop/__tests__/react-output-continuation.test.ts src/core/agent-loop/__tests__/tool-progress.test.ts src/api/http/routes/__tests__/collaborator-chat.test.ts --maxWorkers=1 --minWorkers=1
node --test scripts/longrun/project-driver.test.mjs
```

## 使用与生效

- 更新客户端后，右键网页标签选择“添加到当前会话”即可引用已有网页。
- 子代理步数修复位于引擎；只更新客户端不能改变旧远端引擎行为。远端连接需要部署同版引擎，再重新连接。
- 此次完成的是上述功能及回归范围，不代表全产品所有功能或实际 7×24 连续运行已经通过耐久验收。
