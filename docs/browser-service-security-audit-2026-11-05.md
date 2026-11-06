# 服务预览安全审计

审计日期：2026-11-05。项目：`D:\dev\aether-code`。

用户已取消新增本地文件预览。本轮仅检查现有 HTTP/HTTPS 服务预览、编辑器“运行 HTML”使用的内置 HTTP 服务，以及 Electron 页面与工作台的权限边界。没有修改产品源码，也没有将下列问题标记为已修复。

结论：确认一项预览访问凭据泄露问题、一个页面弹窗资源耗尽入口，以及关闭标签未撤销服务访问的生命周期问题。未发现预览页面可直接调用工作台 IPC 或 Node.js 的路径；这不等同于完整安全认证或排除 Chromium 的未知漏洞。

## 已复现的问题

### 1. P1：预览访问 Cookie 会泄露给其他本机端口

位置：`src/main/browser-preview.ts:81`、`:94`；共享浏览器会话位置：`src/main/browser/service.ts:192`。

内置服务用 `aether_preview_*` Cookie 作为访问凭据，属性是 `Path=/; HttpOnly; SameSite=Strict`。浏览器 Cookie 按主机划分，不按端口隔离；HttpOnly 只能阻止页面 JavaScript 读取，不能阻止另一端口的 HTTP 服务收到它。同一个浏览器会话中访问另一个 `http://127.0.0.1:端口` 服务时，预览 Cookie 会随请求发送。

真实 Electron 验证：

1. 在隔离测试工作区创建 HTML 与仅含合成标记的 `config.json`，通过正式 `browser.openFile` IPC 打开 HTML。
2. 通过正式 `browser.create` IPC 访问另一个测试 HTTP 服务，服务端收到预览凭据 Cookie。
3. 第二个测试服务使用收到的 Cookie 请求原预览服务的 `config.json`，返回 HTTP 200，内容包含合成标记。

影响与前提：攻击者需要能观察被访问的另一个同主机本地服务的请求，例如不可信开发服务或转发到第三方的本地代理。普通外部网站不会仅因为存在这个 Cookie 就自动收到它。另一端口本身并不应获得预览工作区的读取权限，但当前设计授予了这种能力。

读取范围是内置服务器发布的工作区，不是任意磁盘文件；当前服务排除点开头的隐藏路径，但允许普通 `config.json` 等非隐藏文件。该范围会放大凭据泄露的影响。

建议：移除跨端口通用的 Cookie 授权；由主进程仅对获授权标签和精确服务 origin 注入访问凭据，禁止凭据随重定向或其他服务请求流出。资源授权与标签生命周期绑定。仅换 Cookie 名、增加 HttpOnly/SameSite、校验 Origin 或单独换一个共享 partition，都不能单独解决这个问题。

### 2. P2：页面无手势弹窗可持续创建原生标签

位置：`src/main/browser/service.ts:637`；标签创建：`:168`；后台节流设置：`:203`。

`setWindowOpenHandler` 在返回 `deny` 前，已对每个请求手工调用 `create()`。当前没有标签总数、每页面速率或用户手势限制。返回 `deny` 仅阻止 Electron 默认弹窗，不会撤销已经创建的标签。

真实 Electron 验证：合成服务页面加载时调用三次 `window.open`，没有用户点击，应用实际增加三个原生浏览器标签。测试有意限制为三次，没有进行内存耗尽或崩溃测试。源码确认同一路径没有上限，持续调用可放大内存和 CPU 消耗，影响整个 IDE 的可用性。

建议：默认阻止无用户动作的弹窗，合法新窗口走受控入口；同时增加标签总数与每页面创建速率限制，后台页面恢复合理节流。

### 3. P2：关闭最后一个预览标签后，访问能力仍然有效

位置：`src/main/browser-preview.ts:38`、`:108`；`src/main/browser-ipc.ts:89`、`:129`。

HTTP 预览服务按工作区保存在 Map 中，仅在工作台窗口关闭时统一销毁。关闭标签只调用 `service.close()`，没有释放 HTTP 预览服务或轮换、撤销凭据。

真实 Electron 验证：关闭该 HTTP 预览唯一的标签后，原预览 URL 仍返回 HTTP 200。之前已经获取链接或 Cookie 的主体仍可继续读取已发布工作区文件。该项延长第一个问题的暴露时间，单独利用仍需要事先拿到访问能力。

建议：对使用同一预览服务的标签计数，最后一个标签关闭后撤销凭据并关闭服务。复制标签需显式保留引用，普通隐藏、切换模式不应误撤销仍打开的标签。

## 已确认的保护与边界

| 检查 | 结果 |
| --- | --- |
| 页面 Electron 参数 | 实测 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false` |
| 页面可见的工作台能力 | 实测 `window.aether`、`require`、`process` 均为 `undefined` |
| 无凭据访问内置预览文件 | HTTP 404 |
| 凭据路径访问隐藏 `.env` | HTTP 403 |
| 编码的父目录越界访问 | HTTP 403 |
| 内置服务监听地址 | `127.0.0.1`，不直接绑定局域网接口 |
| 摄像头、麦克风、外部协议等权限 | 源码检查默认拒绝，未进行系统权限弹窗测试 |
| 工作台 IPC | 校验主窗口和主帧；工作台另有导航守卫及 preload 文档身份检查 |
| 应用托管引擎鉴权 | 源码确认主进程生成随机实例令牌，引擎敏感路由检查该令牌；未启动或攻击实际用户引擎 |

“仅支持服务地址”并不使网页脚本失去网络能力。用户自行启动的开发服务器还需要自己的鉴权、文件根目录和代理边界；本轮未审计任意第三方服务器。

## 待加固项与未确认项

- **工作区发布范围：**内置服务发布整个授权工作区内的非隐藏文件。合成 `config.json` 返回 200 是确认行为，但这是当前工作区服务器设计，未单独当成路径穿越漏洞。建议缩小到明确的静态输出或预览目录。
- **Host 检查：**带有效能力的请求使用其他 Host 仍返回 200。没有复现不持有凭据的 DNS rebinding 文件读取，因此不将“缺少 Host 校验”夸大为已证实的免认证读取漏洞；仍建议校验精确 Host，并增加适当请求来源约束。
- **剪贴板：**`service.ts:566` 对所有页面授予 `clipboard-sanitized-write`。这是源码确认的权限，建议按明确复制动作授予。未操作用户剪贴板，也没有声称已验证无焦点、无手势的覆盖攻击。
- 本轮未做依赖漏洞库扫描、内存耗尽压测、浏览器引擎漏洞研究，未发现直接系统命令执行不代表能保证零风险。

## 验证和证据

1. `npm run build` 通过，包含 node/web 两段类型检查；存在已有的 Vite 静态与动态混合导入提示。
2. 真实 Electron 夹具由当前构建启动，使用独立用户目录和合成工作区，关闭引擎自动启动。夹具完成后关闭应用、停止测试服务器，并在校验目录边界后清理合成文件。
3. 以下边界回归 **9 passed**：

   ```powershell
   npx playwright test e2e/browser-native-validation.spec.ts e2e/ipc-security-contract.spec.ts --reporter=list --output=.e2e-tmp/service-preview-boundary-tests
   ```

本地审计脚本：`.e2e-tmp/service-preview-security-audit.cjs`；运行命令：`node .e2e-tmp/service-preview-security-audit.cjs`。该脚本用于观察当前风险，并非修复后的验收测试。结果：`.e2e-tmp/service-preview-security-results.json`。临时目录可能被后续清理，以下保留不含任何凭据的结果摘要：

```json
{
  "previewLoaded": true,
  "noTokenStatus": 404,
  "hiddenFileStatus": 403,
  "outsideFileStatus": 403,
  "nonHiddenWorkspaceFileStatus": 200,
  "previewCredentialSentToOtherPort": true,
  "otherServiceCanReadFixture": true,
  "closedTabUrlStatus": 200,
  "foreignHostWithCapabilityStatus": 200,
  "popupsCreatedWithoutGesture": 3
}
```

建议优先修复跨端口凭据泄露，再处理弹窗限制与服务撤销。保留 HTTP/HTTPS 服务预览本身可行，无需为了处理这些问题新增本地文件预览功能。
