# 插件管理前端与真实宿主验证

日期：2026-11-12。范围：`D:\dev\aether-code`，配套引擎 `D:\dev\ai-agent-engine`。

## 已落实的行为

- 新建插件从引擎 `GET /plugins/project/templates` 与 `GET /plugins/project/templates/:id` 读取官方工程，默认 `json-tool`，不在渲染层自行生成运行协议或入口源码。模板包含清单、源码、README、业务案例及运行协议；切换失败保留原草稿。
- 概览可选择引擎提供的模板；测试参数从 `examples/cases.json` 中匹配工具的首个示例预填。新增源文件为空，并提示登记 `tools.entry`。
- 根 `aether-plugin.json` 在源文件页只读且不能删除，预览跟随当前清单；通过概览/工具清单编辑，保存后使用引擎返回的规范文件。
- 保存后的详情区提供独立 ZIP 导出图标，未保存或有未保存修改时禁用。接口为 `GET /plugins/project/exports/:id?revision=N`，返回 `{archive:{fileName,base64,sha256,revision}}`。带有安装依赖、无法完整便携导出的插件会显示引擎错误。
- 模板与导出 API 使用独立路径，原有 `templates`、`imports`、`project` 等有效插件 ID 仍可访问；未增加保留 ID 限制。
- 新增只读工具 `plugin_get_template` 的中文标签；`plugin_test` 的批量 `cases` 批准卡完整显示各用例的名称、工具、参数和预期业务结果。原有单工具参数布局保留。
- 修正源码输入区 CSS 优先级，恢复 380px 编辑高度与等宽字体。浅色、深色、窄窗口通过检查。

插件仍是 Node 工具进程及文件产物，API v1 不提供作者自定义 HTML/JavaScript 界面、常驻后台或系统计时提醒。后续已新增按 Schema 生成的主机原生操作页，详情及其独立验证见 [插件原生操作页与真实货币插件验证](plugin-native-application-verification-2026-11-12.md)；此前测试结论仍仅覆盖下述范围。

## 真实超时问题与测试边界

原有“真实引擎 UI”测试通过外部 Node 启动引擎，再以远端模式接入 Electron。它验证了真实 HTTP、插件进程和 UI，但绕过了 Electron 内嵌宿主的实际启动方式，无法证明嵌入式链路可靠。

新增 `e2e/plugins-embedded-host-ui.spec.ts` 使用真实 `EngineHost → startProcess → engine → plugin spawn`：引擎入口代理只隔离 cwd，仍导入实际构建产物，不替换启动器、路由或 stdin。修复前，同一用例复现 `插件运行超过 60000ms`。调查确认内嵌引擎使用 Electron 可执行文件，二次启动插件时原最小环境丢失 `ELECTRON_RUN_AS_NODE`，导致插件进程进入错误的运行模式。引擎并非没有执行 `child.stdin.end(input)`；前端也没有使用 `utilityProcess` 启动该插件。

修复前红测的目录已被后续绿测覆盖，旧 trace 已清理，本文不引用失效红测文件。引擎侧独立 before/after 实验由引擎报告保存。以下为本次前端实际绿测记录。

## 验证结果

| 验证 | 结果 | 覆盖 |
|---|---:|---|
| `npm run build` | 通过 | Node/Web 类型检查与正式 Electron 构建 |
| 插件、工具包、会话选择、权限卡纯函数 | 91/91 | 路由、标签、案例预填、批量批准内容及既有行为 |
| `plugins-ui.spec.ts` | 6/6 | 模板切换/失败保留、只读根清单、真实 ZIP 下载并解包核对、CRUD、三种导入、标签与主题布局；后端为合同夹具 |
| `plugins-real-engine-ui.spec.ts` | 1/1 | 从官方模板新建、真实 Node 插件执行、真实 ZIP 导出解包、清单一致性、目录/ZIP 导入、固定发布版本与 AI 草稿准备；不调用模型 |
| `plugins-embedded-host-ui.spec.ts` | 1/1 | 真实 Electron 嵌入式启动链路，完整 stdin、Unicode 非默认参数、最小环境与凭证隔离 |

嵌入式用例在引擎最终构建上首轮 8.4 秒通过；补齐显式证据落盘后单独复跑 3.7 秒通过。没有为取证重跑其它已通过的测试。

最终引擎：`2.0.0`，构建标识：`sha256:33a768bb9b6ebc072a0cfa3d4211a59e3987169340b3e164352d431de5daa088`。详细回执记录：`embedded/ready`、`adopted:false`、Electron `39.8.10`、插件 `rawBytes:72`、`ELECTRON_RUN_AS_NODE:"1"`、`secretLeaked:false`、真实参数 `真实宿主 🚀 非默认参数 42`、进程测试耗时 77ms。

## 当前证据文件

路径相对 Aether Code 仓库；`.e2e-tmp` 为忽略的本机测试产物，后续同配置重跑会覆盖。

- 真实内嵌宿主 JSON：`.e2e-tmp/plugins-embedded-host/results/plugins-embedded-host-ui-E-63730-真实启动链路向插件传入完整stdin，且不泄漏引擎环境/embedded-host-receipt.json`。
- 真实引擎 UI 截图目录：`.e2e-tmp/plugins/real-results/plugins-real-engine-ui-真实引擎完成插件编辑、子进程测试、版本固定、导入与AI草稿/`，含 `real-plugin-test-light.png`、`real-plugin-list-light.png`、`real-plugin-list-dark.png`、`real-plugin-list-narrow.png`、`real-plugin-ai-draft.png`。
- 源码只读与导出图标：`.e2e-tmp/plugins/mock-results/plugins-ui-插件管理与会话选择-引擎模板可切换，加载失败保留草稿，清单只读且导出对应已保存ZIP/plugins.png`。
- 浅色/深色/窄窗列表：`.e2e-tmp/plugins/mock-results/plugins-ui-插件管理与会话选择-插件列表保持单行信息并适配浅色、深色与窄窗/`，含 `plugins-light-1320.png`、`plugins-dark-1320.png`、`plugins-dark-860.png`。

绿测使用 `trace: retain-on-failure`，因此没有保留绿测 trace；截图和显式 JSON 回执均已实际落盘。

所有测试使用独立 profile、数据目录与 12541/12571/12581 端口。结束后只关闭自建应用及引擎进程；只读检查确认这些端口无监听，且不存在命令行带 `.e2e-tmp/plugins` 的 Electron/Node 测试进程。未操作用户当前 Aether 窗口或生产插件。
