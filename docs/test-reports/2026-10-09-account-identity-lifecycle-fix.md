# 账号切换资源清理修复与严格客户端验收（2026-10-09）

## 实际问题

`/auth/account/logout` 已成功撤销账号会话，客户端随后才删除旧终端和浏览器注册。删除请求携带已失效的旧账号凭据，返回 401，导致用户看到“登录已失效”并误以为退出没有成功。

## 最终行为

- 使用旧账号凭据，在服务端撤销前清理终端和浏览器注册。
- 身份切换后只进行尽力清理，清理失败不能反向让已完成的退出/登录失败。
- 终端 DELETE 必须同时收到 HTTP 成功、业务成功和 `success: true` 才能解除本地归属；并发关闭共享一次请求，失败保留旧目标与旧凭据供重试。
- 身份清理失败向界面发布诊断，重试不能携带新账号凭据删除旧账号资源。
- 浏览器注销失败保留旧注册供尽力重试；引擎仍有服务端租约过期机制。

修改涉及 `src/main/account/service.ts`、`src/main/ipc.ts`、`src/main/terminal/remote-terminal.ts`、`src/main/browser-bridge.ts` 和 `src/main/browser-ipc.ts`。

## 验收证据

- `npm run typecheck`、`npm run build`：通过。
- 账号、Git 工作区、远端终端专项：22/22 通过，原始 JSON 为 `.e2e-tmp/identity-regression-20261009.json`。
- 修复后第一轮完整客户端：764 项，762 通过，1 失败，1 serial 未运行，0 显式 skip，原始 JSON 为 `.e2e-tmp/client-identity-fixed-full-20261009.json`。
- 唯一失败为真实引擎包导入状态断言；不修改产品或放宽断言，单独重跑 9/9 通过。原轮只保留的 JSON 不能证明失败根因是 UI 竞态、原生验证或系统资源。
- 已补充导入失败附加诊断：IPC 进度、实际 UI 错误、目录和公开引擎快照；保留“已导入”状态断言。
- 补充严格包身份检查：导入目录 buildId、激活后快照 buildId、精确 activeId、恢复内置后的 ready 和 buildId。
- 最终全量运行 `.e2e-tmp/client-strict-final-full-20261009.{json,log}`；独立 trace 目录 `.e2e-tmp/client-strict-final-traces-20261009`；固定 workers=1、retries=0。

## 统一引擎身份

- Build ID：`sha256:8b7556358c696b626c3172d4b1e2dcd744b5053d173ded4c170764d711f93c75`
- 冻结包：`D:/dev/ai-agent-engine/release/agent-engine-2.0.0-win32-x64.tgz`
- SHA256：`E86EC132ED340B7ED3ECD2557747CE4D7DD6818261681388CD67408EC390C947`
- 客户端 stage：`D:/dev/aether-code/resources/engine/win32-x64`

本次客户端修复没有修改或重新创建冻结包。

## 压力运行的证据边界

R3 五会话（3 个 qwen3.8-flash、2 个 deepseek-v4.1-flash，两个保留项目按 3+2 分组）原运行存在未完成项。新的历史回放只能证明已保留数据在客户端可恢复；不能据此覆盖原压力运行失败、原活跃时间内未完成的终端/历史验收或证明 4–5 小时与 7×24 长期运行能力。

## 完整客户端最终基线结果

`.e2e-tmp/client-converged-final-full-20261009.json`：764/764通过，0失败、0显式skip、0未运行、0flaky；118文件，workers=1、retries=0，耗时13.3分钟。此轮为8b755冻结基线，新发现的归档API分页问题将使用新冻结构建独立复验。完整报告为`docs/test-reports/2026-10-09-client-converged-baseline-full.md`。
