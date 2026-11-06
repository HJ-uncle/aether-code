# Work Git 更多菜单验收记录（2026-11-05）

**状态：验收完成。42/42 个菜单入口、43/43 个场景最终均有通过记录。** 第二轮完整执行为 41 passed / 2 failed；最后的布局修复后，7 条相关复测全部通过，覆盖此前两项失败。这里汇总的是各场景最新结果，不是单次执行 43 passed。

## 结果总览

| 项目 | 记录 |
| --- | --- |
| 执行状态 | 完成；43 场景最新结果均为 passed，无待修复失败项。 |
| 菜单范围 | 42 个入口；按实际菜单点击证据核对 42/42。 |
| 用例数量 | 43 条独立用例；额外一条验证 force-with-lease 拒绝覆盖未知远端提交 |
| 首轮实际结果 | 43 条：28 passed / 15 failed；失败分类见下文。首轮不作为最终结论。 |
| 第二轮完整执行 | 43 条：41 passed / 2 failed，耗时 9.4 分钟；两项失败为“推送到…”和“删除远程仓库…”。 |
| 7 条相关复测 | 7 passed / 0 failed / 0 skipped；99.8 秒。 |
| Aether 产物 | 第二轮使用 `.e2e-tmp/git-menu-final-build`。长 URL 布局修复后 typecheck 与 build 已完成，新构建目录：`.e2e-tmp/git-menu-verified-build`。 |
| 引擎产物 | typecheck、4 项 Vitest 验证与 build 已完成；buildId：`sha256:4a64d4dd870cfc48cb691408952b20a78c7fb8290765e2321cbdf150beb1716d`。 |
| 已完成的纯逻辑回归 | git-parsers、instance-scope、store-scope、live-sync，共 70 条 passed。 |
| 执行时间（北京时间） | 完整复测 11:12:31–11:21:57，566.2 秒；布局复测 11:22:30–11:24:10，99.8 秒。命令见文末。 |
| 第二轮完整执行目录 | `.e2e-tmp/git-menu-acceptance-20261105-final`；[results.json](D:/dev/aether-code/.e2e-tmp/git-menu-acceptance-20261105-final/results.json)、[run.log](D:/dev/aether-code/.e2e-tmp/git-menu-acceptance-20261105-final/run.log)。 |
| 相关复测目录 | `.e2e-tmp/git-menu-acceptance-20261105-verified` |
| 截图与证据索引 | [43 项通过记录与测试项目](D:/dev/aether-code/.e2e-tmp/git-menu-acceptance-20261105-verified/INDEX.md)；[机器校验汇总](D:/dev/aether-code/.e2e-tmp/git-menu-acceptance-20261105-verified/summary.json)。 |
| 运行错误及修复后复跑 | 四类缺陷均已修复并验证：远程 URL 空格解析、stash 刷新、旧错误提示、长 URL 挤占名称。 |
| 窗口与请求检查 | 最新通过记录共 48 次 Git action，绑定项目检查通过，渲染错误为 0；两轮 4 个 Electron worker 均正常退出，原生崩溃信号为 0。 |
| 最终验收结论 | 本文限定的本地 Git 菜单功能验收通过；SSH/HTTP 鉴权与网络行为不在本轮覆盖内。 |

## 首轮发现与修复

首轮为 **28 passed / 15 failed**，项目与已有截图保留在 `D:/dev/aether-code/.e2e-tmp/git-menu-acceptance-20261105`。最终通过记录使用后续轮次证据。

| 分类 | 首轮数量 | 已确认原因与处理 |
| --- | --- | --- |
| 远程列表解析 | 3 failed | 远程 URL 含空格时解析不完整，影响相关远程选择操作。已修复两端的远程 URL 解析。 |
| stash 列表刷新 | 7 failed | Git 操作后的 store 刷新未纳入 stash 列表，造成菜单与实际仓库状态不一致。已将 stash 纳入 store 刷新。 |
| 最后 5 条标记用例的 worker 启动 | 5 failed | 根任务在首轮仍运行时重建引擎，后续 worker 读到尚未完成的 manifest。这属于本轮测试安排错误，不能据此判定标记产品功能存在缺陷；后续使用完整稳定产物重测，这 5 项已全部通过。 |

此外，首轮三个中止用例的 Git 磁盘状态虽已恢复，证据中的 `alerts` 仍保留此前合并、变基或拣选冲突错误。原断言只验证磁盘与引用，未捕获这个界面缺陷；这三项并非上述 15 条失败中的新增计数。现已在下一条更多菜单命令开始时清理旧 `notice`，本次失败仍如实报告；回归断言同时要求冲突时错误可见、中止成功后 `alert` 消失。

首轮确认并修复了三类产品根因：**远程 URL 空格解析、stash 状态刷新、旧错误提示清理**。Aether 与引擎构建已完成，另有 70 条纯逻辑回归记录为 passed；随后进行了下述第二轮完整执行。

## 第二轮结果与长 URL 布局修复

第二轮完整执行 43 条，实际为 **41 passed / 2 failed，耗时 9.4 分钟**，记录位于 `.e2e-tmp/git-menu-acceptance-20261105-final` 的 `results.json` 和 `run.log`。所有存储、标记用例均成功；三个中止用例也已验证成功中止后旧 `alert` 消失。

剩余失败的精确测试名为：

- `拉取，推送 / 推送到…：只更新选择的 backup 远程`
- `远程 / 删除远程仓库…：移除选定配置与跟踪引用，保留远端仓库及 origin`

这两项暴露第四类产品根因：**长 URL 的布局把远程名称挤到零宽度**。远程列表解析已正确，但单选弹窗的 URL 提示禁止收缩，长本地路径撑出列表；`backup` 名称存在于 DOM 却不可见、不可正常点击。

修复限定单选提示的宽度并允许省略，给名称保留剩余空间；单选、多选均增加完整 URL 的 `title`。多选继续使用原有两行布局。相关用例增加名称可见且有完整宽度、列表与弹窗不横向溢出、完整 URL 提示存在的断言，没有通过强制点击或更换为父层选择来掩盖问题。

长 URL 修复后的 Aether typecheck 与 build 已完成，产物在 `.e2e-tmp/git-menu-verified-build`。7 条相关复测位于 `.e2e-tmp/git-menu-acceptance-20261105-verified`，范围为所选远程推送、多远程推送、删除远程仓库、合并、拣选、旧存储记录恢复和单标签推送。**实际结果为 7 passed / 0 failed / 0 skipped。**

最终按测试名称合并第二轮完整执行与这 7 条复测，形成 43 场景矩阵。证据索引每行指向该场景最新通过记录，脚本同时核对 42 个菜单定义均有实际点击记录、43 项最终状态均为 passed，以及窗口正常退出。

## 验收方式与边界

菜单定义来自 [GitChangesPanel.tsx](D:/dev/aether-code/src/renderer/src/contrib/git/GitChangesPanel.tsx) 的 `moreMenuGroups`。三个 spec 分别覆盖拉取/推送及远程、分支及提交、存储及标记；“推送所有标签”在两个分组中分别作为独立入口验收。

公共夹具为 [work-git-menu.ts](D:/dev/aether-code/e2e/helpers/work-git-menu.ts)。每条用例建立独立 `project/`、本地裸仓库 `origin.git/` 和 `peer/` 克隆。基础项目为 `main` 分支的一次提交，包含 `tracked.txt = baseline\n` 和 `other.txt = second\n`，已建立 `origin/main` 上游。附加的 `backup.git`、`untouched.git` 等也位于本条用例目录内；所有推送、拉取和远程删除都只针对这些本地裸仓库，不操作用户项目或外部 Git 服务。

本轮覆盖真实 Git 本地裸仓库交互，**未覆盖 SSH/HTTP 远程服务的鉴权与网络行为**，包括凭据获取、证书或主机校验及网络异常场景。不能从本轮结果推断这些网络能力已经验收。

CLI 负责准备分叉、文件、提交和远程前置状态，并读取磁盘结果。被验收操作从真实 Electron Work Git 的“更多操作”菜单发起，经过输入、选择、确认弹窗和真实引擎通信。测试检查 refs、提交父链、Git 对象、暂存区、工作树及冲突状态，不以成功提示代替实际副作用。三个中止用例先通过对应菜单制造真实冲突，再点击中止入口。

Playwright 由根任务串行运行，保持 `workers: 1`。相关复测使用上述已完成的应用与引擎构建产物；本报告更新过程没有另外启动测试。用户此前已启动的旧应用或引擎实例不会自动加载这些构建修复，需重启应用及其引擎实例后再核对实际体验。

夹具保留新建项目供人工复核。证据索引链接每条用例的 `menu-N.png`、`result.png`、`evidence.json` 和项目目录；worker 目录另有 `engine-tail.log`。`evidence.json` 记录菜单入口、Git action 请求、session/root/epoch、HEAD、refs、状态、stash 和渲染进程错误。

## 42 个入口与用例映射

以下 42 个入口均通过对应场景验收；逐项最新运行证据见顶部索引。断言列说明实际验证的文件、Git 对象和界面结果。

### 拉取，推送：10 项

文件：[e2e/work-git-menu-remotes.spec.ts](D:/dev/aether-code/e2e/work-git-menu-remotes.spec.ts)，含下表 10 项、远程分组 2 项及额外保护用例，共 13 条。

| # | 菜单入口 | 精确测试名称 | 主要断言 |
| --- | --- | --- | --- |
| 1 | 同步 | 拉取，推送 / 同步：合并双方提交并将完整历史推回 origin | 先构造本地与 peer 分叉；合并提交的两个父节点依次为原本地、peer HEAD；双方文件落盘，origin/main 等于新 HEAD，工作树干净。 |
| 2 | 拉取 | 拉取，推送 / 拉取：将 origin 的提交和文件更新到当前分支 | 本地 HEAD 更新到 peer 已推送的提交，`tracked.txt` 为远端内容，工作树干净。 |
| 3 | 拉取（变基） | 拉取，推送 / 拉取（变基）：将本地提交重放到真实远端新提交之后 | 新 HEAD 的父为 peer 提交，本地提交哈希被重写且信息保留；无新增 merge，双方文件保留，远端引用不被推送修改。 |
| 4 | 拉取自… | 拉取，推送 / 拉取自…：从选定的 backup 分支拉取且保留现有上游 | 选择 `backup/release/incoming`；HEAD 和文件来自所选提交，仍处于 main，upstream 仍为 origin/main，origin 原引用不变。 |
| 5 | 推送 | 拉取，推送 / 推送：将当前分支提交写入 origin/main | bare origin/main 更新为本地新提交，远端 Git 对象内含新增文件，上游关系保留。 |
| 6 | 推送到… | 拉取，推送 / 推送到…：只更新选择的 backup 远程 | 远程名称可见且完整，长 URL 不撑破列表或弹窗并可通过 title 查看完整值；所选 backup/main 获得新提交及文件，origin/main 与原 upstream 均不变。 |
| 7 | 推送到其他分支… | 拉取，推送 / 推送到其他分支…：只改选定远端引用，不切换本地分支 | 选择并确认 origin/review/target；只更新该远端分支及其文件，origin/main、本地 main 和上游关系保持不变。 |
| 8 | 推送到多个远程… | 拉取，推送 / 推送到多个远程…：所选 origin 和 backup 均收到当前分支 | 检查名称完整可见、长 URL title 和列表/弹窗边界；从三个远程中仅勾选 origin、backup，两者引用与文件更新。未勾选 untouched 不出现 main 分支，哨兵标签和完整 refs 列表不变；结果弹窗只列所选远程。 |
| 9 | 强制推送（force-with-lease） | 拉取，推送 / 强制推送：已知远端状态允许 force-with-lease 更新重写历史 | 先发布再改写本地提交；确认后 origin/main 指向改写提交，文件更新，旧发布提交不再处于 main 历史。另有拒绝未知远端更新的保护用例，见后文。 |
| 10 | 推送所有标签 | 拉取，推送 / 推送所有标签：轻量和附注标签均落到 origin，分支不随之推送 | bare origin 获得轻量与附注标签的准确对象；校验 commit/tag 类型及附注标签解引用目标，origin/main 保持原提交。 |

### 提交：3 项

文件：[e2e/work-git-menu-branches.spec.ts](D:/dev/aether-code/e2e/work-git-menu-branches.spec.ts)，含本组 3 项及分支分组 12 项，共 15 条。

| # | 菜单入口 | 精确测试名称 | 主要断言 |
| --- | --- | --- | --- |
| 11 | 修补上次提交（amend） | 修补上次提交：保留父链和信息并纳入暂存内容 | HEAD 改变但原父节点与提交信息保留；原文件和新增暂存文件均写入新提交，暂存差异及工作树状态清空。 |
| 12 | 撤销上次提交 | 撤销上次提交：HEAD 回退但提交内容保留在暂存区 | HEAD 回到上一提交；被撤销提交的新增文件仍存在磁盘和 index，暂存状态为新增；HEAD 树中不含该文件，无额外未暂存差异。 |
| 13 | 空提交 | 空提交：新建带信息的提交且保持树完全一致 | 新 HEAD 以原 HEAD 为父，提交信息精确匹配，tree 对象完全一致，工作树仍干净。 |

### 分支：12 项

文件：[e2e/work-git-menu-branches.spec.ts](D:/dev/aether-code/e2e/work-git-menu-branches.spec.ts)。

| # | 菜单入口 | 精确测试名称 | 主要断言 |
| --- | --- | --- | --- |
| 14 | 新建分支… | 新建分支：从当前 HEAD 创建并切换 | 当前分支切换为输入名称，新分支与 main 均指向原 HEAD；文件内容和干净状态不变。 |
| 15 | 基于其他分支/提交新建… | 基于其他分支/提交新建：采用指定提交而非当前 HEAD | 两步输入旧提交哈希与分支名；新分支准确指向旧提交，main 保留较新提交，较新提交独有文件不在新分支工作树。 |
| 16 | 合并分支… | 合并分支：保留两个父提交并落盘双方文件 | 构造真实分叉并选择 menu-source；新提交父链为 target、source，双方新增文件落盘，source 引用不动且工作树干净。 |
| 17 | 中止合并 | 中止合并：真实合并冲突恢复原 HEAD 和工作树 | 先用合并菜单制造冲突，验证 unmerged index、冲突标记、MERGE_HEAD 及可见错误；中止后这些状态消失，main、source、HEAD 和目标文件恢复，UI 不再残留 alert。 |
| 18 | 变基到分支… | 变基到分支：重写当前提交并以目标分支为父 | 重写后的 HEAD 以 source 为父，提交信息保留；双方文件存在，source 引用不动，工作树干净。 |
| 19 | 中止变基 | 中止变基：真实变基冲突恢复原分支和提交 | 先用变基菜单制造冲突，验证 rebase-merge/rebase-apply 状态、unmerged index 及可见错误；中止后恢复原 main、HEAD、文件和干净 index，UI 不再残留 alert。 |
| 20 | 拣选提交（cherry-pick）… | 拣选提交：通过全部分支历史选择旁支提交并生成新父链 | 通过历史 UI 选择“全部分支”，从菜单选中旁支提交；新提交以原 target 为父且不同于 source 哈希，信息及双方文件正确，source 引用不动。 |
| 21 | 中止拣选 | 中止拣选：真实拣选冲突移除状态并恢复原提交 | 先通过菜单拣选冲突提交，验证 CHERRY_PICK_HEAD、unmerged index、文件冲突标记及可见错误；中止后状态文件消失，原 HEAD、分支及文件恢复，UI 不再残留 alert。 |
| 22 | 重命名当前分支… | 重命名当前分支：迁移本地引用并保留提交 | 当前分支为新名称，旧 main 引用不存在，新引用仍指向原 HEAD，工作树干净。 |
| 23 | 删除分支… | 删除分支：确认后只移除选中的本地引用 | 选择并确认 menu-delete；该引用消失，menu-keep、main 和 HEAD 保持原提交。 |
| 24 | 删除远程分支… | 删除远程分支：确认后移除 bare origin 的目标引用 | 选择并确认 origin/menu-delete-remote；bare origin 中目标分支消失，origin/main 与本地 HEAD 不变。 |
| 25 | 发布分支到 origin | 发布分支到 origin：无 upstream 的分支推送并建立跟踪关系 | 从无 upstream 的新分支开始；origin 获得该分支及文件，建立 origin/menu-publish 跟踪关系，本地 HEAD 和干净状态保留。 |

### 远程：2 项

文件：[e2e/work-git-menu-remotes.spec.ts](D:/dev/aether-code/e2e/work-git-menu-remotes.spec.ts)。

| # | 菜单入口 | 精确测试名称 | 主要断言 |
| --- | --- | --- | --- |
| 26 | 添加远程仓库… | 远程 / 添加远程仓库…：两次输入后保存指定名称、URL 与 fetch refspec | 两步输入 backup 名称及本地裸仓库路径；配置保存正确 URL 与 `+refs/heads/*:refs/remotes/backup/*`，origin URL 不变。 |
| 27 | 删除远程仓库… | 远程 / 删除远程仓库…：移除选定配置与跟踪引用，保留远端仓库及 origin | 选择并确认 backup；本地远程配置及 backup 跟踪引用消失，但 bare backup 数据、origin 配置和 origin/main 保留。 |

### 存储：10 项

文件：[e2e/work-git-menu-stash-tags.spec.ts](D:/dev/aether-code/e2e/work-git-menu-stash-tags.spec.ts)，含本组 10 项及标记分组 5 项，共 15 条。

| # | 菜单入口 | 精确测试名称 | 主要断言 |
| --- | --- | --- | --- |
| 28 | 存储当前更改… | 存储 · 存储当前更改…保存跟踪文件并保留未跟踪文件 | 跟踪文件恢复基线，未跟踪文件仍在工作树；stash 内容及文件列表只包含所存跟踪文件，说明正确。 |
| 29 | 存储当前更改（含未跟踪文件）… | 存储 · 存储当前更改（含未跟踪文件）…把新文件写入stash第三父节点 | 跟踪文件恢复基线，新文件从工作树移除；stash 保存跟踪内容，第三父节点保存原未跟踪文件内容。 |
| 30 | 只存储已暂存的更改… | 存储 · 只存储已暂存的更改…保留未暂存文件内容 | 已暂存文件恢复基线并写入 stash；未暂存文件内容保留，index 清空，stash 文件列表准确。 |
| 31 | 恢复最新一次存储的改动 | 存储 · 恢复最新一次存储的改动恢复最新内容并保留两条记录 | 最新记录的文件内容恢复，另一文件保持基线，两条 stash 的哈希及顺序均保留。 |
| 32 | 恢复某次存储的改动… | 存储 · 恢复某次存储的改动…选择旧记录并保留它 | 选择较旧的第 1 条记录；恢复其独有文件，不应用最新记录内容，两条 stash 均保留。 |
| 33 | 恢复最新一次并删除该存储 | 存储 · 恢复最新一次并删除该存储仅移除最新记录 | 最新文件内容恢复，stash 列表仅剩原较旧哈希，另一文件保持基线。 |
| 34 | 恢复某次并删除… | 存储 · 恢复某次并删除…恢复旧记录且不删除最新记录 | 选择较旧记录；旧文件内容恢复，仅删除旧记录，最新记录哈希保留且其文件未被应用。 |
| 35 | 删除某次存储… | 存储 · 删除某次存储…只删除所选记录且不应用其文件 | 选择并确认较旧记录；stash 列表仅剩最新哈希，两个工作树文件都保持基线。 |
| 36 | 查看存储详情… | 存储 · 查看存储详情…显示所选记录的真实hash和文件且不修改仓库 | 选择旧记录后，详情显示准确说明、完整哈希和文件名；stash 列表及工作树内容不变。 |
| 37 | 清空全部存储 | 存储 · 清空全部存储删除所有记录且不恢复工作区内容 | 确认后 stash 列表为空、refs/stash 消失，两个工作树文件仍为基线。 |

### 标记：5 项

文件：[e2e/work-git-menu-stash-tags.spec.ts](D:/dev/aether-code/e2e/work-git-menu-stash-tags.spec.ts)。

| # | 菜单入口 | 精确测试名称 | 主要断言 |
| --- | --- | --- | --- |
| 38 | 创建标签… | 标记 · 创建标签…创建指向当前HEAD且保存说明的附注标签 | 两步输入名称和说明；标签对象类型为 tag，解引用目标为原 HEAD，说明精确匹配，HEAD 不动。 |
| 39 | 删除标签… | 标记 · 删除标签…仅删除所选本地标签并保留远程标签 | 选择并确认本地 delete-local；仅剩 keep-local，远端完整标签引用列表保持不变。 |
| 40 | 推送标签… | 标记 · 推送标签…只推送所选标签到origin | 选择 push-selected；origin 仅获得该标签及正确哈希，未选择标签不被推送，两条本地标签保留。 |
| 41 | 推送所有标签 | 标记 · 推送所有标签从标记分组推送所有本地标签 | 从“标记”分组点击独立入口；origin 标签引用集合等于两条本地标签集合，本地标签不变。 |
| 42 | 删除远程标签… | 标记 · 删除远程标签…删除origin所选标签并保留本地和其他远程标签 | 选择并确认 delete-remote；origin 仅保留 keep-remote 的准确引用，本地完整标签列表保持不变。 |

## 第 43 条：force-with-lease 额外保护

文件：[e2e/work-git-menu-remotes.spec.ts](D:/dev/aether-code/e2e/work-git-menu-remotes.spec.ts)。

精确测试名称：`拉取，推送 / 强制推送保护：远端被 peer 更新后拒绝覆盖未知提交`。

先发布本地提交，再由 peer 更新 origin；本地仍持有旧 remote-tracking ref，并改写自己的提交。关闭后台自动 fetch，保持“远端发生了本地尚未知晓的更新”这一前提。通过真实菜单点击并确认 force-with-lease 后，断言界面报告拒绝，bare origin/main 与 peer 文件未被覆盖，本地改写提交和旧跟踪引用也不被更改。

该用例是第 9 项强制推送入口的额外拒绝分支，因此 **42 个入口对应 43 条用例**。

## 复现命令与产物

在 `D:/dev/aether-code` 执行，构建和测试串行；最新构建使用独立目录，避免覆盖用户运行实例正在占用的 `out/`。

```powershell
npm run build -- --outDir .e2e-tmp/git-menu-verified-build
npx playwright test e2e/git-parsers.spec.ts e2e/git-instance-scope.spec.ts e2e/git-store-scope.spec.ts e2e/git-live-sync.spec.ts --output .e2e-tmp/git-menu-pure-results
$env:AETHER_E2E_APP_ENTRY = 'D:\dev\aether-code\.e2e-tmp\git-menu-verified-build\main\index.js'
$env:AETHER_GIT_MENU_RUN_DIR = 'D:\dev\aether-code\.e2e-tmp\git-menu-recheck'
npx playwright test e2e/work-git-menu-branches.spec.ts e2e/work-git-menu-remotes.spec.ts e2e/work-git-menu-stash-tags.spec.ts --output .e2e-tmp/git-menu-recheck/playwright-results
```

实际最后 7 条定向复测在上述三份 spec 上使用 `--grep '推送到…：|推送到多个远程|删除远程仓库|合并分支：|拣选提交：|恢复某次存储的改动|推送标签…只'`。第二轮完整测试使用 `git-menu-final-build`；各轮实际结果由索引中的 `results.json`、`run.log` 保存。

引擎在 `D:/dev/ai-agent-engine` 完成 `npm run typecheck`、`npx vitest run src/api/http/routes/__tests__/git-remotes.test.ts`（4 passed）、`npm run build`。构建标识见总览。

最新 Aether 主进程 SHA-256：`c7e042d149e1a3f6cd87657225fd6c635f1d171d2a10129261ffd218b838b9a7`；渲染入口 `index-DfKq9And.js` SHA-256：`3038366101a162278a573d0b6505302bb260fa716cc718432f39ddbfd3ec4f06`。
