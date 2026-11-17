# 项目内的 Aether 数据目录

源码核对日期：2026-11-17。项目辅助数据的默认命名空间是 `.ae/`，但不同功能的读取、合并与显式覆盖规则不同，不能用一条“找到新目录就完全忽略旧目录”概括。

本文中的项目根是当前功能已经解析和授权的根目录。启动配置默认相对引擎 `process.cwd()`；会话附件、上下文和工作区操作使用当前会话绑定。远端目录属于引擎所在电脑，不是前端窗口的本地目录。

## 写入位置与读取规则

| 数据 | 默认写入／使用位置 | 当前读取与优先级 |
| --- | --- | --- |
| 上传、粘贴、终端选区及队列附件 | `<workspace>/.ae/attachments/` | 本地与远端上传共用目录名；历史附件按记录路径读取，不整体搬移原有 `uploads/` |
| 项目技能 | `<project>/.ae/skills/` | 按技能名称合并 `.ae/skills`、`.aether/skills`、`SKILLs`，同名按此顺序优先；非同名旧技能仍可见 |
| 技能启停及旧副本删除标记 | `.ae/skills/skills.config.json` | 新目录的禁用副本仍覆盖旧启用副本；旧技能启停覆盖与删除标记写新配置，防止旧副本静默复活 |
| 项目 MCP | `.ae/mcp.json` | 选第一个存在文件：`.ae/mcp.json` → `.aether/mcp.json` → 根目录 `mcp.config.json`；不是把三份项目文件全部合并 |
| 项目引擎启动配置 | `.ae/aether.json` | 新文件存在即选用；否则读 `.aether/aether.json`，再与用户级配置合并，项目字段优先 |
| 项目上下文 | `.ae/AE.md` | 新文件存在时只读这一份项目上下文；不存在时同时读取 `.aether/AE.md` 与根目录 `AE.md`，并额外拼接用户级 `AE.md` |
| 代码图缓存 | `.ae/codegraph.db` 及相应 WAL／SHM 等 | 代码图模块固定设置 `CODEGRAPH_DIR=.ae`；重新索引生成新缓存，不迁移或删除旧 `.codegraph/` |
| OpenSpec 与讨论预览 | `.ae/openspec/changes/`、`.ae/brainstorm/` | 对应技能／脚本采用这些路径；不是所有会话自动生成的目录 |
| Agent 计划、临时脚本与日志 | `.ae/plans/`、`.ae/tmp/`、`.ae/logs/` | 属于提示与技能中的默认工作约定，用户或项目明确指定位置时按其要求 |
| Git 协调锁 | 非仓库回退锁可位于 `.ae/git-operation.lock`；克隆协调使用父目录 `.ae/git-clones/` | 已有 Git 仓库可能在实际 Git 目录使用锁；不能把这些运行锁当普通历史缓存删除 |

源码依据：[前端目录常量](../src/shared/project-storage.ts)、[附件目录](../src/shared/attachments.ts)、[本地文件服务](../src/main/fs/file-service.ts)、[远端附件上传](../src/main/engine/upload-remote-attachment.ts)，以及引擎的 [project-storage.ts](../../ai-agent-engine/src/core/project-storage.ts)、[project-skills.ts](../../ai-agent-engine/src/skills/project-skills.ts)、[mcp-config.ts](../../ai-agent-engine/src/storage/mcp/mcp-config.ts)、[aether-config.ts](../../ai-agent-engine/src/core/aether-config.ts)、[project-context.ts](../../ai-agent-engine/src/core/project-context.ts) 与[代码图适配](../../ai-agent-engine/src/tools/codegraph/codegraph-module.ts)。

## 容易混淆的边界

**MCP 的第一次修改会承接当前选中的旧项目配置，再写入新位置。** 新文件建立后，即使里面是空配置，也不会回头读取旧项目文件。通常还会合并全局 `mcp.json`，同 ID 的项目条目覆盖全局条目；删除项目覆盖后，全局同 ID 条目可能重新可见。这与旧项目文件复活是两回事。

**空的 `.ae/AE.md` 也会阻止两个旧项目位置被再次注入。** 全局上下文独立追加，不随项目文件清空而消失。读取器每次调用读取文件，单份内容上限为 32,768 个字符；不能承诺所有层的全部文本无上限进入模型。不同请求入口传入的项目根以对应服务调用为准。

**存在但格式损坏的新配置不会自动降级到旧文件。** `aether.json` 与 MCP 定位先按文件存在性选择，再解析；错误会记录日志并按该读取器的空配置处理。排查时先看实际选中的文件，不要只修改旧位置。

代码图重建只针对自己的数据库与关联文件，不应删除整个 `.ae`。用户已经维护的 `.ae/.gitignore` 也需要保留，不能由可选 SDK 默认文件无条件覆盖。

## 显式路径与全局配置

- `AETHER_GLOBAL_DIR` 指定引擎用户级全局目录；未指定时使用 `~/.aether`。它影响用户配置、上下文、技能与 MCP 等相应全局层，不表示项目根也改变。
- `MCP_CONFIG_PATH` 指定 MCP 单文件读写路径，并关闭该读取器的全局／项目合并。显式配置不会自动搬进 `.ae`。
- 技能导入的显式目标参数优先；普通项目导入可被 `SKILLS_ROOT` 覆盖。全局导入仍进入全局技能目录，不因 `SKILLS_ROOT` 改写成项目目录。
- 技能注册表的显式 `start(root)` 为单根模式；环境 `SKILLS_ROOT` 仍可与用户全局技能共存。没有显式根时，自动发现合并各项目旧位置。
- 技能管理接口有明确项目根时，使用经授权解析的该项目 `.ae/skills`；不能把进程级部署技能目录当成任意租户都能管理的项目目录。管理权限与可见层以服务端判断为准。

启动配置在当前引擎主入口中先应用用户／项目 `aether.json`，再同步允许的数据库设置，随后应用受管配置；受管配置高于普通 UI／文件配置。实例身份和鉴权启动项还有单独信任边界，不能根据这个顺序推断任意 JSON 能更改实例身份。启动配置文件修改通常要重启相应引擎；技能目录有监听与动态发现，`AE.md` 由读取器即时读取，不是所有修改都必须重启。

## 与账号数据、交付和测试的区别

账号凭据、会话历史、模型配置、记忆和应用设置属于相应应用／引擎的数据层，不应整体复制进项目 `.ae`。用户要求的源码、交付文档和项目自己的构建输出仍遵循项目约定；不会自动迁移原有 `data/`、`docs/`、`uploads/` 或第三方目录。

本仓库及配对引擎的工程验证有更具体的约定：测试临时脚本、夹具、报告、截图和日志放在 `.e2e-tmp/<任务名>/`，不能引用 Agent 的通用 `.ae/tmp` 建议绕过 [AGENTS.md](../AGENTS.md)。本文没有授权清理生产数据或运行锁。

仅更新前端不会改变远端引擎的存储规则。排查路径时同时核对客户端、实际运行引擎及其工作区身份；源码已修改不等于现有进程已替换。操作概览见[使用指南](user-guide.md)，配置链路见[前端结构](frontend-architecture.md)。
