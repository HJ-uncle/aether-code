# 弹层与菜单统一实现（2026-11-06）

本次承接 `popup-layer-and-menu-audit-2026-11-06.md` 的调研，处理设置内菜单被遮挡，以及共享菜单左右没有留白的问题。

## 实现

- 新增 `workbench/overlay.tsx`，按所属关系和打开顺序管理弹层。Dialog、Popover、右键菜单及子菜单共用层级、外部点击、Esc、焦点约束和关闭后的焦点恢复。
- Esc 只交给最上层；嵌套模态框隔离背后的界面。Tab 支持所属 Portal 内的控件，不再回到父设置页。关闭菜单后打开的确认框仍保持有效。
- 命令面板、快速打开、编辑器路径选择、搜索替换预览、补全和运行列表接入同一套管理。补全保留编辑器焦点，只由最上层处理选择按键。
- 删除模型表单、自动化和 Agent 编辑页的局部 `z-index + 1` 补丁。
- 文件选择及账号确认、导入、导出的系统对话框绑定发起它们的窗口。

## 菜单外观

- 统一四周 6px 留白、8px 选项圆角、32px 单行最小高度，说明文字按内容增高。
- 选项采用低对比背景与右侧勾选；可选图标、标题及说明保持固定列对齐。
- 共享选择器、操作菜单、右键菜单、顶部菜单、输入框选项、工作区菜单和相关列表使用同一组 `--menu-*` 令牌，支持明暗主题。
- MCP 3 处、知识库 1 处、记忆 3 处、文档缩放 1 处原生下拉均迁移到共享选择器。并发数量菜单宽度改为 160px，避免默认值换行。

这些尺寸是本项目参考 macOS 菜单习惯选择的实现值，不声称是 Apple 对所有桌面菜单的强制尺寸。

## 验收方法

`e2e/popup-layer-and-menu-ui.spec.ts` 使用真实 Electron 窗口与隔离的本地模拟后端：检查鼠标实际命中、设置真实落盘、请求实际值、逐层 Esc、Tab 焦点范围、关闭还焦，以及明暗/窄窗口菜单边界。

截图在入场动画结束、透明度为 1 且位置稳定后生成。其他回归复用已有设置、模型、动效、文档预览、后台服务、搜索和补全用例。

## 验收结果

`npm run typecheck`、`npm run build` 通过；本轮相关差异的 `git diff --check` 通过。

最终共 **57 条相关真实窗口用例通过**，不包括重复复跑的计数：

| 用例组 | 通过 |
|---|---:|
| 新增弹层/菜单专项 | 8 |
| 知识库设置与资源绑定 | 6 |
| 记忆设置 CRUD | 2 |
| 模型配置表单 | 4 |
| 共享菜单/弹窗/命令面板动效 | 7 |
| Office/PDF 预览与选区 | 4 |
| Work 后台服务弹层 | 5 |
| Work 工作区搜索/替换 | 15 |
| smoke：右键、命令面板、快速打开、替换落盘、渲染错误 | 5 |
| Work/Code 窄窗补全、分类、Tab/Esc 与隐藏模式键盘释放 | 1 |

另 4 条 `office-warm-reuse.spec.ts` 用例需要 `AETHER_OFFICE_FIXTURE_ROOT` 指向外部大型办公文件夹具，本次未提供，因此按已有条件跳过。没有执行整个项目的全量 E2E。系统原生文件/账号对话框完成 owner 透传并通过类型检查与构建，未自动操作其系统 UI。

回归中修复了 Code 资源选择迁移时误加的会话就绪门槛，保留原来的资源浏览行为。也修正了测试夹具的会话标识、快照游标及 Code/Work 接纳协议，以核对真实副作用；没有放宽请求值或落盘断言。

复现入口（先 build，所有 Electron 用例串行执行）：

```powershell
npx playwright test e2e/popup-layer-and-menu-ui.spec.ts
npx playwright test e2e/knowledge-ui.spec.ts e2e/memory-settings-crud.spec.ts e2e/model-config-ui.spec.ts e2e/motion-ui.spec.ts e2e/office-selection-ui.spec.ts e2e/work-service-tray-ui.spec.ts
npx playwright test e2e/work-workspace-search-ui.spec.ts
npx playwright test e2e/smoke.spec.ts -g '资源管理器右键菜单|命令面板：|快速打开：|全局替换：|渲染进程无'
npx playwright test e2e/work-mode.spec.ts -g '共享 @ 弹层在短窗口独立滚动'
```

验收截图保存在 `.e2e-tmp/popup-menu-final/`，搜索、基础交互与补全结果分别保存在 `.e2e-tmp/popup-search-acceptance/`、`.e2e-tmp/popup-smoke-acceptance/` 和 `.e2e-tmp/popup-completion-acceptance/`。构建产物已更新；未重启用户正在使用的窗口。
