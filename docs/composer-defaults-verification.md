# 对话偏好默认值验证

日期：2026-10-08

## 默认行为

| 偏好 | 默认值 | 生效位置 |
|---|---|---|
| 长期记忆 | 仅本会话（session） | 引擎 code profile 的未设置会话 |
| 思考档位 | High | 客户端原有默认值保持不变；按模型能力决定推理行为 |
| 安全模式 | 标准模式（standard） | 引擎没有明确默认安全配置、会话没有明确覆盖值时 |

已保存的记忆范围、用户明确选择的思考档位与会话安全模式不被覆盖。服务端显式 `DEFAULT_SECURITY_MODE` 配置继续优先；非法配置保持回退 safe。服务端显式禁用长期记忆时仍遵守禁用设置。

修复首次发送和重试中的记忆设置竞态：读取尚未完成时省略 `memoryScope`，由服务端读取该会话已保存或默认范围，避免隐式提交 off 并将其永久写入数据库。未确认记忆状态时显示“状态未知”，不把未知状态误显示为“关闭记忆”。

## 已完成验证

- 客户端 `npm run typecheck`、`npm run build`：通过。
- 引擎 `npm run typecheck`、`npm run build`：通过。
- 引擎默认值相关 5 份测试：79 条通过。
- 客户端相关回归：34 passed / 0 failed / 0 skipped（32.3 秒）。
- 引擎全量串行回归首轮：1246 passed / 5 failed / 1 skipped，共 120 份测试、1252 条用例。三条失败来自依赖旧默认 safe 的边界测试，已明确指定 safe；另两条来自并行修改中的会话压缩模块。
- 对全部失败文件复跑：19 passed / 0 failed。压缩相关代码由并行任务完成，本次未修改。未再次运行全量；以上是首轮与复跑分别记录的结果。

客户端命令：

```powershell
npx playwright test e2e/composer-defaults-ui.spec.ts e2e/memory-scope-state.spec.ts e2e/security-client.spec.ts e2e/security-state.spec.ts e2e/security-mode-lifecycle.spec.ts e2e/thinking-mode-ui.spec.ts
```

新增 6 条真实 Electron + 真实引擎测试分别覆盖 embedded/remote：初始默认值、接口与显示一致、明确选择的 off/global 与 safe/full-access 保留、刷新与切换会话、新会话默认值，以及明确 Low 跨会话保留。其余回归覆盖记忆与安全异步状态、引擎重启和思考参数到模型服务的透传。

所有新测试使用 `.e2e-tmp` 下独立数据库和设置目录。远端验证使用本机独立引擎进程，没有部署或改动用户远端服务器；远端实际生效需要更新并重启服务端引擎。

客户端日志：`.e2e-tmp/composer-defaults-build.log`、`.e2e-tmp/composer-defaults-verification.log`。

引擎日志（同级 `ai-agent-engine`）：`.e2e-tmp/composer-defaults-engine-full.log`、`.e2e-tmp/composer-defaults-engine-rerun.log`、`.e2e-tmp/composer-defaults-engine-build-final.log`。
