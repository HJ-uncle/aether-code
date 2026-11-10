# PPT 内容设计与原文件逐页验收

## 范围与结果

本次替换旧的固定 PPT 生成器，只保留一套内容驱动流程。没有 classic/quick/preset 双轨模板；旧 title/bullets/table 输入仍进入同一生成器。移除强制蓝色边条和 Aether 页脚，增加可选主题、图文、对照、时间线、引述、自定义元素及可编辑原生图表/表格。Skill 详细指南按需读取，参数以工具 schema 为准，不重复提供旧模板。

引擎与客户端 typecheck、build 通过。新增专项 37 项、真实 Electron E2E 2 项通过；未运行旧 E2E 或导出界面测试。最新 E2E 用时 6.3 秒。

## 用例与证据

| 范围 | 新用例 | 结果 |
| --- | --- | --- |
| PPT 生成器 | 16 项：十种布局、原生图表与内嵌工作簿、原生表格、图片字节、等比定位、时间线连接、编辑保留部件、密度/边界/互斥字段、工作区授权与防覆盖 | 通过 |
| 渲染工具与模型适配 | 10 项：模型视觉能力、标准 hash、文件变化、客户端离线/不支持、会话与页码、PNG 回执、取消、只读子 Agent、真实 SDK 请求中的图片载荷 | 通过 |
| Skill/提示词 | 4 项：有无渲染能力分支、内容设计、逐页视觉检查、能力边界 | 通过 |
| 原生图表预处理 | 1 项：xmldom 下安全移除关系，保留图表关系、分类、数值缓存及原文件 | 通过 |
| 预览转换 | 6 项：源码匹配保护、字体大小、数据标签开关、折线图图例、饼图比例与标签位置、图片 contain/cover | 通过 |
| Work 真实窗口 | 2 项：13 页逐页截图、用户预览、图片实际比例和裁切、图表字体与图例、饼图标签不压扇区、旧版本/越界页/外部路径失败、隐藏窗口释放 | 通过 |

13 页样例覆盖封面、章节、要点、双列、图片 contain、柱状图、表格、引述、时间线、自定义构图、多系列折线图、饼图及图片 cover。已实际查看所有页面，修复后重新检查受影响页面。所有测试文件位于隔离目录，测试后的 profile/工作区已清理。

截图与逐页回执保留在 `.e2e-tmp/ppt-design-results/ppt-design-render-ui-new-c-09fd4-h-the-connected-Work-client/`。
最后一轮样例 SHA-256：`d3b2375d8220fb7ccddb746fe0266485b2ef52015e9d963e1ad3c6d79379918e`。

## 实际发现并修复的问题

1. 引述页的装饰引号误触容量限制，导致引用页无法生成。
2. 原生图表的嵌入工作簿关系触发 `relation.remove is not a function`，导致整份 PPT 无法预览；改用 xmldom 支持的 DOM 删除操作。
3. contain 的负裁切被转换器截为零，图片拉伸；新生成器直接写入等比矩形，同时修复旧文件的负裁切预览。
4. 图表预览忽略原稿字号，轴标签过小；改为使用原稿字体大小。
5. `showValue:false` 仍显示数字，多系列折线图漏图例；修正标签开关和图例绘制。
6. 时间线连接线在预览中丢失；内建连接改为可编辑薄矩形。
7. 饼图文字压在深色扇区上；标签按方向移到圆外，并以真实 SVG 填充区域检查遮挡。

转换器修复通过 `scripts/pptx-preview-transform.ts` 在开发和构建时统一应用，不直接修改 node_modules。补丁针对锁定的 `@jvmr/pptx-to-html@1.1.2`，升级依赖时必须复核源码匹配及这些用例。

## 复跑

引擎目录 `D:\dev\ai-agent-engine`：

```powershell
npm run typecheck
npm run build
npx vitest run src/tools/office/__tests__/pptx-design.test.ts src/tools/workbench/__tests__/render.test.ts src/core/__tests__/office-presentation-design-prompt.test.ts
```

客户端目录 `D:\dev\aether-code`：

```powershell
node --test scripts/pptx-preview-transform.test.mjs src/renderer/src/contrib/documents/pptx-chart-archive.contract.test.mjs
npm run build -- --outDir .e2e-tmp/ppt-design-build-20261110 --logLevel warn
$env:AETHER_E2E_APP_ENTRY = Join-Path (Get-Location) '.e2e-tmp\ppt-design-build-20261110\main\index.js'
npx playwright test -c playwright.ppt-design.config.ts
```

## 运行与验收边界

- `workbench_render(path,page,expectedHash)` 使用同会话的原始 PPTX，返回图片和版本。文件在渲染前后变化会失败，逐页解析缓存有容量上限；截图成功本身不等于视觉检查通过。
- 当前画面由 Aether 的 PPTX 转换器和 Chromium 产生，固定 960×540；非 16:9 原稿会缩放，不代表 PowerPoint 原生像素保真。动画、SmartArt、嵌入字体及部分高级图形仍有限制。
- 自动看图需要连接中的客户端及声明支持视觉的模型；非视觉模型会得到明确失败，不能把文本读回当成视觉验收。
- SDK 测试检查实际序列化请求中的图片、页码和 hash，但未向在线模型服务提交生成任务；真实 E2E 使用隔离服务夹具、真实桥接和真实渲染，不是模型自由规划效果的评估。
- 既有开发进程固定使用启动时的引擎快照。完成当前任务后重新运行 `npm run dev`，新生成能力和 skill 才会进入该开发进程。本次验收使用新构建的隔离客户端与引擎产物。
