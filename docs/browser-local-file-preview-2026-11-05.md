# 浏览器本地文件与目录预览

日期：2026-11-05。已实现，未提交 Git commit。

## 使用方式

- 在浏览器地址栏粘贴绝对文件路径或 `file://` 地址，按 Enter 打开。支持中文、空格及 Windows“复制为路径”产生的外层引号。
- 点击地址栏旁的文件夹按钮“打开本地文件”，使用系统文件选择器。
- 地址栏也接受目录路径：显示目录列表，支持进入子目录、返回上级、前进后退、刷新和按名称筛选。通过“浏览器更多操作 → 打开本地目录”可使用系统目录选择器。
- 点击目录中的文件会在新标签预览，原目录及浏览位置保留。目录列表包含隐藏项；链接逃出选定根目录时显示不可用。
- 文件在独立标签中打开，原网页保留；本地标签中输入 HTTP/HTTPS 地址会新建网页标签。
- 支持文本、日志、代码、HTML、常见图片及 SVG；PDF、DOCX、XLSX、PPTX 复用现有文档查看器。其他二进制使用现有十六进制视图。
- 刷新按钮和 Ctrl+R 重新读取磁盘；复制标签后，关闭原标签不影响副本。

## 文件与权限范围

- 新的 `openLocalFile` IPC 只接受工作台主窗口、主帧调用。文件选择不向全局文件服务添加目录授权。
- 文本和文档按单文件授权，通过标签 ID 读取；关闭标签后无法继续读取。
- HTML 使用随机 `aether-local` origin，与所选文件所在目录绑定，继续限制路径越界、隐藏资源、网络请求及跨标签资源访问。完整开发服务仍走现有 HTTP/HTTPS 预览。
- HTML 页面保持 sandbox、contextIsolation，无 Node.js 和工作台 preload。
- 新建本地标签没有 AI context 或待收养身份，禁止通过浏览器分享接口交给 AI。远端任务可由用户在本机查看文件，但远端引擎不会因预览获得文件权限。
- 离线到引擎就绪时，只迁移经过来源校验的展示身份，不授予 AI 权限。
- 新读取接口限制单文件 32 MiB；文本显示前 4 MiB，并提示截断。文档解析器继续执行自身的大小和复杂度限制（现有文档输入上限 16 MB）。
- 文本支持 UTF-8、带 BOM 的 UTF-16 LE/BE，并在无 BOM 的非 UTF-8 文本上尝试 GB18030。网络共享、设备路径、备用数据流及不存在的文件均拒绝。

## 验证

`npm run build` 通过，包含 node/web 类型检查。已检查最终产物包含最新文件路径校验及离线展示身份迁移代码。

| 测试 | 结果 |
| --- | --- |
| `browser-local-input.spec.ts`、`browser-duplicate-contract.spec.ts`、`browser-native-validation.spec.ts` | 16 passed |
| `browser-user-local-ui.spec.ts` | 完整串行运行 10 passed |
| `browser-native-file-ui.spec.ts`、`browser-navigation-ui.spec.ts` | 6 passed |
| `browser-work-scope-ui.spec.ts` | 2 passed |

共 34 个不同的定向用例通过，未运行仓库全量 E2E。Electron 健康记录正常退出，无渲染异常和原生进程失败。文本与 PDF 的真实 UI 截图已目检，内容、工具栏和滚动区域正常。

首次联合运行时，新 UI 首用例曾出现一次地址框缺失前缀，文件内容已正常打开。原样单条重跑、完整 10 条测试、再独立重复该用例 3 次均通过，共 5 次后续检查未再出现。录制显示缺失字符数等于上一个网址的长度，但没有足够 DOM 输入事件确认根因；没有据此猜测修改产品。测试现保留最多 200 条输入、选区、组合输入及焦点记录，仅在失败时输出，便于后续定位。该项仍作为未稳定复现的观察记录保留。

## 证据

- 完整本地文件用例结果：`D:\dev\aether-code\.e2e-tmp\browser-local-preview-complete`
- 原生文件与网页导航回归（亦含首次失败记录）：`D:\dev\aether-code\.e2e-tmp\browser-local-preview-ui-results`
- 输入重复验证：`D:\dev\aether-code\.e2e-tmp\browser-local-input-stability`
- Code/Work 范围回归：`D:\dev\aether-code\.e2e-tmp\browser-local-work-scope-results`
- 纯逻辑回归：`D:\dev\aether-code\.e2e-tmp\browser-local-contract-results`

测试使用合成文件、独立用户目录及关闭自动启动的引擎；测试完成后关闭实例并清理各自工作区。结果目录中的截图与 trace 为临时验收产物。

此前服务预览审计发现的问题未在本次功能变更中修复。本次本地文件预览使用独立授权机制，不依赖内置 HTTP 服务的 Cookie。

## 目录支持补充验收

目录是新的显式授权入口，不加入全局工作区授权。只读取当前层，最多显示 2,000 项并提示截断；进入子目录及打开文件时重新校验真实路径与授权根，拒绝链接越界或根目录替换。目录副本独立保存浏览历史，关闭原标签后副本仍可使用。

目录功能完成后的 `npm run build` 与 node/web 类型检查通过；以下本轮用例全部通过，共 **39 项**：

- 路径、AI 权限与复制相关纯测试：16 项。
- 新增目录真机测试：8 项。
- 原有本地文件真机测试：10 项。
- 原生 HTML 授权回归：3 项。
- Code/Work 范围与显示回归：2 项。

本轮真实窗口测试没有失败、环境跳过或 Electron 健康异常；未再次出现上文记录的地址栏异常。目录列表截图已经目检，窄面板会隐藏修改时间列以保留名称空间。

结果路径：`D:\dev\aether-code\.e2e-tmp\browser-directory-ui-results`、`D:\dev\aether-code\.e2e-tmp\browser-directory-contract-results`。
