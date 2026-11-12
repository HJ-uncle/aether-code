# 插件原生操作页与真实货币插件验证

日期：2026-11-12。前端仓库：`D:\dev\aether-code`。

## 完成的交互

已发布且启用的插件在列表中点击后，直接打开原生操作页；独立编辑图标继续进入源码、测试和版本管理。草稿或停用插件仍进入编辑页。

操作页固定打开时的发布修订，使用 `GET /plugins/runtime/apps/:id?revision=N` 取得运行清单与示例，通过 `POST /plugins/runtime/apps/:id/invoke` 提交 `{revision,tool,args}`。结果的插件 ID、修订和 hash 必须匹配打开的快照。前端不指定工作目录或安全模式，也不因为打开操作页而向 Agent 添加工具包。

字段来自工具的 JSON Schema：字符串、数字、整数、枚举和布尔值使用原生控件，复杂对象/数组保留在高级 JSON 参数中。示例用于预填；必填、数值上下界、整数和 JSON 类型错误显示在对应字段旁，完整 Schema 校验由引擎负责。功能名称优先使用 `inputSchema.title`，回退工具名；请求仍使用工具名。

结果优先显示插件提供的可读结果及表达式，汇率来源等说明保持可见。有表格时可用插件提供的 `unit` 作为标题，其余元数据折叠；表格中每个数值均有 `xxText` 可读值时隐藏对应原始数值列，避免重复。原始回执保留全部字段。更改输入、切换功能和执行失败会清除旧结果；离开页面后不接收旧请求回写。插件配置变化后要求重新打开。安全策略禁止执行时仍可查看表单，但运行按钮禁用。

这里提供的是主机按 Schema 生成的原生操作页，不加载插件任意 HTML/JavaScript，也不提供常驻后台或系统计时提醒。文件产物在此页为内容预览，不自动写入工作区。

## 验证边界

所有 Electron 用例串行运行，使用隔离 profile、数据目录和测试端口，未操作用户当前 Aether 窗口。真实引擎 UI 用例通过 Node 启动独立实际引擎，再由真实 Electron 前端以远端模式接入；它不等同于 Electron 内嵌引擎宿主验证。此前内嵌宿主的独立证据见 `plugin-manager-frontend-verification-2026-11-12.md`。

| 检查 | 结果 | 实际覆盖 |
|---|---:|---|
| `npm run build` | 通过 | Node/Web 类型检查和 Electron 正式构建 |
| `plugin-form.spec.ts` | 5/5 | 原生字段、原始类型、数值边界、中文功能名、表格和运行路由白名单 |
| `plugins-ui.spec.ts` | 8/8 | 合同夹具下的 CRUD、导入、模板、ZIP、@、中文功能名、表单、固定版本、错误和旧请求隔离 |
| `plugins-real-engine-ui.spec.ts` | 1/1 | 真实引擎 CRUD、插件子进程、ZIP、目录导入、发布版本与编辑入口回归；不调用模型 |
| `plugins-application-ui.spec.ts` | 1/1，7 秒 | 使用最终真实用户插件工程，验证默认声明、明确汇率、精确表达式、非默认交叉表与原始业务回执 |

真实操作页的最终引擎构建为 `sha256:46b39a5a04006140bd2d5d3e0b6668ea0d586697eaa5ee8af9e6468cc73629b4`。插件为 `currency-converter` v1.0.1，使用审计通过后的 6 文件工程；复制后逐文件 SHA256 与审计源核对相同。实际原生导入仅存储 5 个文件：`aether-plugin.json` 被 importer 解析为独立 manifest 对象后不作为文件镜像保存，因此其快照 hash `sha256:00b9d6055e87d571bb3dd0516034d7785fcdf477fd9580637f10670473e87fd8` 与含清单镜像的 6 文件直接创建/更新快照 `sha256:8e448e4fa07cc1437c82427aaeda957608fc623074831372cfdc52adf8689213` 不同。所有可执行源码字节一致；身份对照单独落盘，没有将二者称为同一快照。

真实交互确认：默认 `100 USD → 710.00 CNY` 显示明确的演示汇率声明；指定 7.28 时为 `728.00 CNY`；`1.005 × 3` 正确显示 `≈ 3.02`；`100,000,000 × 7.12345678` 显示完整汇率及 `= 712,345,678.00`。`10,000 JPY` 交叉表单位正确，CNY/USD 分别为 467.11/65.79。负金额、同币种非法直接汇率、停用插件均被拒绝且旧结果消失。运行页固定 r1，不显示已保存但未发布的 r2 内容；打开操作页未增加 Agent 工具包。渲染进程错误为 0。

## 证据路径

路径相对前端仓库。测试产物位于忽略目录；未来同输出目录重跑可能覆盖。

- 最终 Mock：`.e2e-tmp/plugins/native-final-results/` 下的 8 个 `plugins-ui-*` 用例目录。
- 真实引擎回归：`.e2e-tmp/plugins/native-real-regression-results/`。
- 最终货币操作页：`.e2e-tmp/plugins/native-final-currency-results/plugins-application-ui-正式货币插件可直接输入、选择币种并换算，固定版本与停用状态真实生效/`，包含浅色、深色、窄窗、默认汇率和交叉表截图。
- 上述目录的 `currency-app-receipt.json` 保留所有实际业务运行原回执；`currency-import-identity.json` 保留导入记录、原工程文件、逐文件 SHA256、5/6 文件数量与 hash 区别说明。

合并的最后 9 项执行曾出现 8 个 Mock 通过、1 个货币取图辅助超时；trace 定位为首次业务成功后，测试辅助等待浏览器动画结束而未返回。已改用 Playwright 的 `screenshot({animations:'disabled'})` 稳定过渡，最终货币用例重新通过；旧红测 trace 保留在 `native-final-results`，未将其报告为产品运行失败。此前空请求误带 JSON Content-Type 也只修正了测试 HTTP 助手。

最终检查：12541/12591 无监听，命令行含本次 `.e2e-tmp/plugins` 或 `.e2e-tmp/plugin-app` 的 Electron/Node 测试进程为 0。Electron 独占已交还协调者，未操作生产插件或用户 Aether 窗口。
