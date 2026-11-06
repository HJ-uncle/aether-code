# Work 打开文件与工作区同步验收（2026-11-05）

从 Git 打开文件原来只更新右侧预览，工作区树没有收到定位请求。现在 Git、成果当前文件和具有任务身份的文件资源标签会产生同一类定位请求：按真实目录逐层加载，保留其他展开分支，选中目标文件并滚动到无遮挡的位置。请求按引擎、任务和工作目录隔离；完成后消费，避免关闭并重开工作区时覆盖用户后来的筛选与滚动。

目录使用已有缓存；缓存中找不到新文件时重读该分支一次。对已删除文件的定位请求也会结束。外部电脑文件和网页不会改变任务文件树。

实测同时发现右键菜单会收到打开之前已产生、但延后派发的滚动事件，并立即关闭。ContextMenu 现忽略这类过期事件；后续滚动仍按原行为关闭菜单。

## 验证结果

- `npm run build -- --outDir .e2e-tmp/work-file-reveal-build` 通过，包含 Node/Web 两段 typecheck。
- 26 条逻辑测试通过：file-tree-reveal、workspace-tree-selection、work-file-open-contract。
- 7 条真实 Electron 文件树记忆回归通过：展开、筛选、滚动、任务隔离、Windows 路径、读取失败重试、延迟恢复时的新选择。
- 1 条真实 Electron 右键菜单回归通过：原生右键、定位、退出、打开创建文件弹窗并实际落盘。
- 1 条真实 Electron + 引擎 + 临时 Git 仓库的完整文件同步用例通过（10.8 秒；含夹具总计 43.3 秒）。

完整同步用例用两个各有 80 个占位文件的多级目录验证：

1. Git 差异页按钮打开第一个文件，自动展开、唯一选中并滚动。
2. Git 行右键菜单打开第二个文件，预览与选中项切换。
3. 两个文件资源标签往返，再进入工作区，树和预览同步；向上定位不会被固定目录行挡住。
4. 全部收起并设置不匹配筛选后，重开同一个文件仍能定位并清除阻碍显示的筛选。
5. 定位完成后手动筛选、滚动至 360，关闭再重开工作区，保留筛选、选择和 360 的滚动位置。
6. 目标行完整处于树的 client viewport 内，位于固定目录层下方，中心点实际命中目标文件行；仓库 HEAD、状态和 diff 均未被浏览操作修改。

## 证据与重跑

截图、几何 JSON 和真实 Electron trace 位于：

`D:/dev/aether-code/.e2e-tmp/work-file-reveal-verified/work-git-panel-Work-Git-完整-a1b81-动展开工作区多级目录、选中并滚动定位，切换文件同步更新/`

关键文件：`work-git-open-file-tree-reveal.png`、`work-git-open-file-tree-reveal.json`、`work-git-consumed-reveal-memory.png`、`work-git-electron-trace.zip`。

```powershell
$env:AETHER_E2E_APP_ENTRY = 'D:\dev\aether-code\.e2e-tmp\work-file-reveal-build\main\index.js'
npx playwright test e2e/work-git-panel.spec.ts -g 'Git 打开文件自动展开工作区多级目录、选中并滚动定位，切换文件同步更新'
npx playwright test e2e/work-file-tree-memory-ui.spec.ts -g 'Work 展开嵌套目录|同根不同会话|Code 共用虚拟树|Windows 混合分隔符|刷新目录临时失败|延迟恢复旧目录|重新载入同一 Windows'
npx playwright test e2e/motion-ui.spec.ts -g '右键菜单与创建文件 Dialog'
npx playwright test e2e/file-tree-reveal.spec.ts e2e/workspace-tree-selection.spec.ts e2e/work-file-open-contract.spec.ts
```

所有 Electron 用例串行执行。此次针对文件同步及关联交互验收，没有运行全量 Git 操作套件。首次回归中的初始化阻塞已修正：Git 夹具先关闭默认设置页，文件树夹具直接初始化为 Work；收起后的目录断言遵循已有单子目录折叠显示规则，没有放宽选择和几何断言。
