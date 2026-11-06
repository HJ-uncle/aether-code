# Git 历史异步缓存与增删统计验收

日期：2026-11-05。范围：默认加载提交历史、请求缓存、Work 底部 `+0 -0` 漏统计。最终相关测试 **117 passed / 0 failed / 0 skipped**；包含 19 项真实 Electron 窗口或 IPC 验证，并非全仓库测试总数。

## 根因与改动

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 历史默认显示零且未请求 | 仅展开时读取，未区分未加载与成功空结果 | 首轮文件状态就绪后异步加载前 50 条；历史有独立的加载、错误、重试状态 |
| 切回面板重复加载 | 缺少成功结果的新鲜度和请求去重 | 按任务、引擎连接、目录及仓库保留内存缓存；同一查询合并在途请求 |
| Work 文件存在但增删合计为零 | 引擎 status 初始化行数为零，没有执行 numstat，也未统计未跟踪文本 | 补齐暂存、未暂存两次仓库级 numstat；未跟踪文本单独统计并缓存 |
| 子目录工作区漏统计 | status 和 numstat 使用不同的相对路径基准 | 统一为当前工作区相对路径，过滤目录外文件，并归一重命名前路径 |

历史缓存有效期为 60 秒，过期后在下一次读取/后台状态刷新时重验。展开、收起、切换工作区标签可复用缓存；提交、分支切换、手动刷新会更新历史。刷新期间保留旧列表，失败显示局部错误，不延长文件列表的全局 loading。成功空历史也缓存；新建但尚未提交的仓库返回空列表，非法引用仍然报错。

缓存保存在当前应用进程中，不跨应用重启；Work 复用已有最多 16 个闲置任务 store 的保留策略。筛选变化会清空旧筛选结果。超过 500 条的已加载历史分批重验，全部完成后原子替换；加载更早页不会延长首页缓存期限。

统计口径为暂存区 `HEAD→index` 与未暂存区 `index→worktree` 的增删之和，未跟踪文本全部计为新增。空文件为零，LF、CRLF、无末尾换行均覆盖。未跟踪文件保持 2 MiB 读取上限；二进制、超限、不可读和符号链接文件不提供文本行数，仍不应把本次结果理解为对这些文件内容的完整统计。

## 最终验证

| 验证 | 结果 |
| --- | --- |
| 桌面端 typecheck（node + web）和独立目录 build | 通过 |
| 引擎 typecheck 和 build | 通过 |
| Git store、任务隔离、实时同步、真实 Git 行数统计 | 66 passed |
| 本地 Git 服务真实 Electron IPC 矩阵 | 11 passed |
| Work 首屏、历史缓存/重试、底部统计、实际仓库读取 | 8 passed |
| 引擎 Git status / contracts / menu parity | 32 passed |

窗口测试前先完成引擎及桌面端构建，Playwright 串行、workers=1。桌面端最终一次运行 85 passed，耗时约 147 秒。Work 窗口均无渲染异常，Electron health 检查通过。

实际断言包括：

- 延迟历史 HTTP 请求时，变更文件已显示，刷新按钮可用；首次请求 limit=50。
- 连续展开/收起以及切换“工作区 → Git”不会新增历史请求；手动刷新才从 1 次增加到 2 次，并读到真实新提交。
- 首次历史请求 503 后显示局部错误，重试成功；未请求或失败不显示成成功零条。
- 无提交仓库返回零条，重复展开不重新请求。
- 新建三行文本显示 `+3/-0`；真实点击暂存后继续修改，暂存 `+3/-0`、未暂存 `+2/-1`，底部合计 **`+5/-1`**，并核对 index 和磁盘内容。
- 子目录 tracked/untracked 统计准确，父目录变更不进入列表；引擎使用返回的相对路径暂存到正确文件。
- 550 条历史分页重验保持全部条目；任务隔离、筛选 A→B→A、迟到响应、失败保留缓存均有断言。

只读性能抽样：`D:\dev\aether-code` 当时有 481 个变更，文件区出现耗时 2196 ms，分支区和刷新按钮就绪耗时 3442 ms；索引内容保持不变。这是一次本机首屏测量，不代表所有仓库或完整历史加载耗时。

## 复现与证据

引擎目录 `D:\dev\ai-agent-engine`：

```powershell
npm run typecheck
npx vitest run src/api/http/routes/__tests__/git-status-stats.test.ts src/api/http/routes/__tests__/git-contracts.test.ts src/api/http/routes/__tests__/git-menu-parity.test.ts
npm run build
```

引擎最终 build id：`sha256:53c9bada83868d6e0754108186c3f95d417322b5b1a28c7b60547ef5cc22368d`。

桌面端目录 `D:\dev\aether-code`：

```powershell
npm run build -- --outDir .e2e-tmp/git-history-build
$env:AETHER_E2E_APP_ENTRY = 'D:\dev\aether-code\.e2e-tmp\git-history-build\main\index.js'
$env:AETHER_GIT_LOADING_REPO = 'D:\dev\aether-code'
npx playwright test e2e/git-instance-scope.spec.ts e2e/git-store-scope.spec.ts e2e/git-live-sync.spec.ts e2e/git-status-stats.spec.ts e2e/work-git-loading.spec.ts e2e/git-service-matrix.spec.ts --output=.e2e-tmp/git-history-final-results
```

- [最终测试日志](D:/dev/aether-code/.e2e-tmp/git-history-final.log)
- [底部统计截图](D:/dev/aether-code/.e2e-tmp/git-history-final-results/work-git-loading-Work-Git--c8f95-未跟踪三行新文件，并准确合计同一文件的暂存与未暂存差异/work-git-footer-staged-unstaged.png)
- [历史请求次数证据](D:/dev/aether-code/.e2e-tmp/git-history-final-results/work-git-loading-Work-Git--32621-且不阻塞文件区，展开和切页复用缓存，手动刷新读取新提交/work-git-history-async-cache-refresh.json)
- [实际仓库首屏测量](D:/dev/aether-code/.e2e-tmp/git-history-final-results/work-git-loading-Work-Git-首屏加载-指定真实仓库的首屏读取耗时及变更数/work-git-real-repo-load.json)

本次使用独立测试配置、临时项目及本地 bare remote，临时项目已清理。当前用户运行中的应用与引擎没有被重启；主进程/引擎改动需重新启动相应进程后生效。
