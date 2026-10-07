# Workspace Shell 与引擎安全边界审计

当前实现不能认定为安全沙箱。隔离测试已证明：Workspace Shell 的路径检查没有限制外部程序的操作系统权限；在 `safe` 模式下，解释器仍可读写工作区外的测试文件、绕过引擎网络检查。接口层还存在认证、角色和租户隔离缺口。在完成下述修复与复验前，不应将它作为运行不可信代码或承载互不信任租户的安全边界。

本报告记录审计时的代码和测试结果，并非修复完成证明，也不证明当前运行中的本地或远程实例已经更新。本文编写阶段仅复核已有证据，没有追加攻击测试、修改生产代码或重启用户服务。

## 范围、证据与限制

- 运行平台为 Windows（`win32`），Shell 记录的 Node 版本为 `v24.20.0`。未在 Linux、macOS 或用户的真实远程服务器复验。
- 所有越界读写、删除都针对新建隔离目录中的假文件；凭据均为合成标记或测试签名。未访问真实机密、生产接口或真实用户数据。
- 网络探测仅连接本机 `127.0.0.1` 测试监听器，没有向外部服务传输数据。结论是子进程能绕过引擎网络检查，不是已经验证了任意互联网出口。
- Shell 测试直接启动真实 `workspace-shell.mjs`，经标准输入输出管道输入命令，未使用真实 PTY 或 UI。
- API 测试使用实际引擎源代码、Fastify 路由、认证钩子与 WebSocket，数据库和配置目录独立。**终端管理器的 PTY 被 stub 替代**：证明路由错误地允许跨租户读写、关闭一个终端对象，未验证真实 PTY 的执行链。`execute_cmd` 测试使用真实 Node 子进程。
- 没有进行进程炸弹、资源耗尽、长时间压力、内核逃逸或全面协议模糊测试。未覆盖所有命令、插件、操作系统和部署组合，不能据此给出“全面安全”或“已达到 7×24”结论。
- Shell 证据时间为 `2026-10-06T16:05:57.854Z`；API 证据时间为 `2026-10-06T16:07:05.383Z`。原始时间均保留为 UTC。

| 证据 | 位置与用途 |
|---|---|
| Shell 原始记录的永久副本 | [sandbox-shell-audit-results.json](D:/dev/aether-code/docs/sandbox-shell-audit-results.json)，逐项输出与磁盘副作用 |
| Shell 原始记录 | [原 report.json](D:/dev/aether-code/.e2e-tmp/audit-workspace-shell-SVRhmg/report.json)，与副本逐字节一致 |
| API 原始记录 | [sandbox-api-audit-results.json](D:/dev/aether-code/docs/sandbox-api-audit-results.json)，包含 5 个目标源文件的 SHA-256 |
| Shell 测试实现 | [audit-workspace-shell.mjs](D:/dev/aether-code/scripts/audit-workspace-shell.mjs)，当前脚本已修正未验证状态，不能把脚本文本当作一次新的执行结果 |
| API 测试实现 | [audit-engine-boundaries.mjs](D:/dev/aether-code/scripts/audit-engine-boundaries.mjs)，显示隔离范围及 PTY stub 的具体替换 |
| API 测试夹具 | `D:\dev\aether-code\.e2e-tmp\audit-engine-boundaries-qMkzkJ` |

Shell 副本和原始文件的 SHA-256 均为 `202b104e054f92314738c42c3b82e122a82b9d99cade9e11653428664722d861`。夹具位于临时测试目录，可能被后续清理；`docs` 下的 JSON 是保留证据。

## 结果统计与口径修正

共 39 项探测：**30 项不良结果、6 项有效阻断、1 项正常功能、2 项未验证**。30 项不良结果包含同一根因的多种入口及 2 项稳定性问题，**不是 30 个独立漏洞**。

| 测试面 | 项数 | 不良结果 | 有效阻断 | 正常功能 | 未验证 |
|---|---:|---:|---:|---:|---:|
| Workspace Shell | 24 | 18（含 2 项稳定性问题） | 3 | 1 | 2 |
| API、工作区、策略与网络 | 15 | 12 | 3 | 0 | 0 |
| 合计 | 39 | 30 | 6 | 1 | 2 |

Shell 原始 JSON 的 `counts` 是 `18 vulnerable / 5 blocked / 1 pass`。以下两项原标为 `blocked`，但证据不支持安全阻断，本文将它们解释为未验证，保留原始 JSON 不改写：

1. `python-read-write`：测试环境找不到可运行的 Python。没有运行成功不等于应用阻止了越界。
2. `root-delete`：Windows 返回 `EPERM`，`workspaceDeleted=false`。原描述“可被整体删除”未被本次执行证明；操作系统拒绝也不证明产品有根目录保护。

### Shell 逐项结果

| ID | 本报告判定 | 观察到的结果 |
|---|---|---|
| `builtin-inside-read` | 正常 | 正常读取工作区内假文件 |
| `builtin-dotdot-read` | 阻断 | 内置文件读取拒绝直接 `..` 越界 |
| `builtin-absolute-read` | 阻断 | 内置文件读取拒绝直接外部绝对路径 |
| `builtin-sibling-prefix` | 阻断 | 内置文件读取拒绝名称相似的相邻目录 |
| `node-script-read` | 不良 | Node 脚本读取工作区外假文件 |
| `node-inline-read` | 不良 | Node 单行脚本读取工作区外假文件 |
| `node-script-write` | 不良 | Node 脚本在工作区外创建假文件 |
| `native-shell-read` | 不良 | 原生系统命令读取工作区外假文件 |
| `python-read-write` | 未验证 | Python 不可用 |
| `compound-command-write` | 不良 | 组合命令在工作区外创建假文件 |
| `redirect-outside-write` | 不良 | 重定向在工作区外创建假文件 |
| `pipe-outside-write` | 不良 | 管道调用的脚本在工作区外创建假文件 |
| `npm-script-write` | 不良 | 本地项目脚本在工作区外创建假文件；没有安装依赖或联网 |
| `builtin-env-canary` | 不良 | 内置环境查询返回假引擎凭据 |
| `child-env-canary` | 不良 | 子进程继承并读取假引擎凭据 |
| `junction-cat` | 不良 | 内置读取经目录链接访问工作区外假文件 |
| `junction-touch` | 不良 | 内置创建经目录链接写入工作区外 |
| `junction-mkdir` | 不良 | 内置建目录经目录链接写入工作区外 |
| `junction-cp` | 不良 | 内置复制经目录链接写入工作区外 |
| `junction-rm` | 不良 | 内置删除经目录链接删除工作区外假文件 |
| `root-delete` | 未验证 | 操作系统拒绝删除根目录；不是安全防护通过 |
| `loopback-canary-transfer` | 不良 | 子进程向自有本机监听器发送假凭据 |
| `invalid-regex` | 不良：稳定性 | 畸形正则触发未捕获异常，Shell 退出码为 1 |
| `concurrent-lines` | 不良：稳定性 | 连续输入的后一个命令先运行，检测到顺序竞争 |

### API 与策略逐项结果

| ID | 判定 | 观察到的结果与前提 |
|---|---|---|
| `API-anonymous-auth-enabled` | 不良 | `AUTH_ENABLED=true` 且未配置实例令牌时，匿名请求读取安全模式成功 |
| `API-instance-token-negative-control` | 阻断 | 配置实例令牌后，未携带令牌返回 HTTP 401 |
| `API-viewer-mutates-global-network-policy` | 不良 | 合成 `viewer` JWT 成功修改全局网络策略 |
| `API-anonymous-mode-escalation` | 不良 | 未配置实例令牌时，匿名请求成功把默认租户的测试会话设为 `full-access` |
| `API-cross-tenant-terminal-read-write` | 不良 | B 租户知道 A 的终端 UUID 后，可经真实 WebSocket 路由读取假 PTY 输出、写入假 PTY |
| `API-cross-tenant-terminal-delete` | 不良 | B 租户可删除 A 的假 PTY 对象 |
| `POLICY-tenant-session-key-collision` | 不良 | 不同租户/会话组合共用同一个安全模式存储键 |
| `PATH-session-id-traversal` | 不良 | 路径管理器接受含路径分隔的会话 ID，计算出工作区根之外的路径；该项本身未写文件 |
| `PATH-direct-traversal-negative-control` | 阻断 | 正常会话的直接外部绝对路径被安全路径解析拒绝 |
| `API-session-traversal-read` | 不良 | 上述会话 ID 路径问题经真实文件接口读出外部假文件 |
| `API-junction-file-read` | 不良 | 真实文件接口经工作区内目录链接读出外部假文件 |
| `API-workspace-binding-cross-tenant` | 不良 | B 租户能绑定全局允许根下 A 的测试目录并读出其假文件 |
| `POLICY-safe-interpreter-outside-read-write` | 不良 | `safe` 模式执行 Node 项目脚本，无需确认，读写工作区外假文件成功 |
| `NETWORK-safe-guard-negative-control` | 阻断 | `guardedHttp` 拒绝私网回环地址，监听器命中次数为 0 |
| `NETWORK-safe-interpreter-bypass` | 不良 | 相同策略下，Node 子进程成功访问自有回环监听器 |

`blocked` 只证明对应控制在本次输入下生效；不能推导为整条功能链安全。UUID 不易猜测也不能替代资源所有权检查。

## 关键根因

### 1. 当前只有应用路径检查，没有操作系统执行隔离（P0）

[workspace-shell.mjs:71](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:71) 只用词法路径判断限制部分内置操作。外部命令在 [workspace-shell.mjs:489](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:489) 进入 `child_process.exec`，继承引擎用户的操作系统权限。`cwd` 决定相对路径起点，不能阻止进程访问其他可读写位置。Node、原生 shell、项目脚本和重定向的多项结果是这个根因的不同表现。

[policy-engine.ts:139](D:/dev/ai-agent-engine/src/security/policy-engine.ts:139) 允许 Node；[execute-command.ts:25](D:/dev/ai-agent-engine/src/tools/cmd/execute-command.ts:25) 的策略判定无法判断脚本内部的任意文件和网络行为。即使无 shell 字符串解释，解释器本身也足以执行这些操作。网络检查只覆盖调用 [guarded-http.ts:21](D:/dev/ai-agent-engine/src/security/guarded-http.ts:21) 的工具，无法拦截未隔离子进程的系统调用。

因此提示词、命令黑名单或更多字符串过滤都不能把这一执行模型变成安全沙箱。保留正常编译、包管理和脚本能力，需要把执行放在真正受限的工作进程或容器/虚拟机中。

### 2. 环境变量暴露及启动失败时权限扩大（P0）

[terminal/index.ts:54](D:/dev/ai-agent-engine/src/terminal/index.ts:54) 和 [workspace-shell.mjs:476](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:476) 复制整个进程环境；[workspace-shell.mjs:375](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:375) 允许按名字读取任意环境变量。已复现合成凭据泄露。真实凭据是否存在于某个部署的环境中未探测，不能宣称发生真实泄露。

静态代码还显示：工作目录不存在会回退到主目录，受限 Shell 无法启动会回退原生系统 Shell。见 [terminal/index.ts:37](D:/dev/ai-agent-engine/src/terminal/index.ts:37)、[terminal/index.ts:87](D:/dev/ai-agent-engine/src/terminal/index.ts:87) 和 [terminal.ts:47](D:/dev/ai-agent-engine/src/api/http/routes/terminal.ts:47)。这些失败分支尚未动态注入验证，但与“启动失败应保持原安全边界”相冲突。

### 3. 认证开关、角色与资源所有权不是完整边界（P0）

[auth/middleware.ts:27](D:/dev/ai-agent-engine/src/auth/middleware.ts:27) 在没有用户凭据时回退默认租户。实例令牌在 [HTTP middleware.ts:46](D:/dev/ai-agent-engine/src/api/http/middleware.ts:46) 是另一层控制，测试证实它配置后会阻断缺令牌请求；这不补足租户身份认证和授权。

[security.ts:95](D:/dev/ai-agent-engine/src/api/http/routes/security.ts:95) 的全局网络策略修改没有拒绝 `viewer` 角色。[terminal.ts:82](D:/dev/ai-agent-engine/src/api/http/routes/terminal.ts:82) 及删除处理按 UUID 找到终端，却未核验该终端归属请求租户。终端对象本身也没有保存所有者。测试使用已知的测试 UUID，不涉及枚举真实终端。

### 4. 工作区路径与会话状态可跨边界（P0）

[workspace/manager.ts:23](D:/dev/ai-agent-engine/src/workspace/manager.ts:23) 直接把租户/会话 ID 拼入目录；`resolveSafePath` 的根因此可能已经被不可信 ID 改写。路径检查未解析目录链接的实际落点，导致 Junction 绕过。全局允许目录只表示运营方允许使用该目录范围，不等于范围内所有目录归所有租户共享；[workspace/manager.ts:44](D:/dev/ai-agent-engine/src/workspace/manager.ts:44) 的绑定缺少租户所有权验证。

[policy-engine.ts:21](D:/dev/ai-agent-engine/src/security/policy-engine.ts:21) 用冒号拼接租户与会话键。包含冒号的不同组合可以得到相同键，导致安全模式互相影响。应采用无歧义编码并验证 ID，不能只在前端限制输入。

### 5. 输入异常和命令调度影响持续运行（P1）

[workspace-shell.mjs:300](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:300) 在异常捕获外构造正则，错误输入会结束整个 Shell。[workspace-shell.mjs:631](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:631) 的异步 `line` 事件没有跨事件串行队列；已观察到后续命令抢跑。代码中的共享 `currentChild` 还存在被后续命令覆盖的风险，但本次未进一步验证取消或进程树遗留行为。

此外，路径统一转小写在大小写敏感文件系统上不可靠；真实路径检查后的链接切换竞争、完整进程树回收、输出积压也需专门验证。上述内容属于静态待验证项，不计入已复现的 30 项结果。

## 修复优先级与验收条件

| 优先级 | 工作 | 通过条件 |
|---|---|---|
| P0 | 将“安全沙箱”“所有操作严格限制在工作空间内”等表述改为符合实际能力的名称与说明；明确可信本地执行和隔离执行的区别 | 用户能看到真实执行边界；不因修改文案就把系统标为安全 |
| P0 | 建立操作系统边界：远程部署使用隔离工作账户配合容器/虚拟机，限定挂载、权限及出口；Windows 使用经验证的受限令牌/AppContainer 或独立隔离工作环境 | 解释器、构建工具和项目脚本都受同一文件、网络、进程权限约束；独立账户本身不是充分条件 |
| P0 | 移除执行环境中的引擎凭据，按需要允许环境变量；工作目录/隔离执行器异常时明确失败，不回退主目录或裸 Shell | 假引擎凭据无法被命令读取；失败注入不会扩大执行权限 |
| P0 | 启用认证时缺少凭据必须拒绝；独立验证实例身份、用户身份和角色；生产缺失安全配置时启动失败 | 未认证访问、只读用户修改全局配置、默认开发密钥部署均被阻止 |
| P0 | 给终端、工作区绑定、会话及相关资源保存租户/用户所有权；每次读写、订阅、调整大小和删除均核验 | A/B 租户矩阵中仅所有者或显式授权者能操作；知道 UUID 不授予权限 |
| P0 | 服务端校验租户/会话 ID；使用无歧义状态键；统一实际路径边界与租户目录授权 | 直接路径、ID 路径穿越、Junction/符号链接及相邻前缀均不能越界；新建目标要检查真实父路径 |
| P1 | 命令输入串行化、单条异常隔离、取消关联正确进程树 | 粘贴多行顺序稳定；畸形输入不使 Shell 退出；取消后无遗留任务 |
| P1 | 增加资源预算、背压、恢复与可观察性，并开展持续运行复验 | 单个任务超载不拖垮服务；断连重连、崩溃恢复和重启后状态可解释且可恢复 |

实际路径检查仍有检查与使用之间的竞争问题；应结合文件句柄/平台能力和 OS 边界设计，不能把一次 `realpath` 校验视为任意并发场景下的充分保护。修复后必须在目标平台使用真实 PTY、真实 UI 和本地/远程连接复验，API stub 结果不能替代这一步。

## 7×24 运行需要保留哪些限制

长期运行不应被任意轮数或短固定时限无故中断，但**服务稳定需要可配置、可观测的资源和并发边界**。把所有上限删除会让单个卡住或异常任务耗尽服务资源。

- 保留每租户/用户的并发进程、终端、连接、文件句柄与排队预算，超额时排队或明确拒绝。
- 保留内存、CPU、磁盘/日志容量、网络连接和输出缓冲预算，配合背压、轮转与清理，不能无限堆积内存。
- 长任务使用可续期租约、心跳、检查点和持久任务状态；用户主动停止、失联、异常进程回收各自有明确规则，不能靠一个总时长上限混在一起处理。
- 取消与服务关闭应回收整个受管进程树；断线后的任务保留或终止须有一致策略，重连不能重复启动同一任务。
- 在本地和远程使用相同状态协议与错误语义，并进行持续运行、断网、引擎重启、限额压力及失败恢复测试。测试报告应记录时长、负载、泄漏趋势和未覆盖平台。

目前证据足以确认安全边界存在缺口；没有证据支持宣称这些缺口已修复，或系统已经满足不可信多租户云端与 7×24 持续运行要求。
