# Work 图标约定

Work 的导航、操作、状态和弹出菜单使用 `workbench/outline-icons.ts` 中的统一 SVG 目录：24×24 画布、1.5 描边、圆端点与圆连接，颜色继承所在控件。

`App` 根据当前模式设置 `IconProvider`，覆盖设置、确认弹窗及通知等全局宿主；保活的 Work / Code 子树各自固定图标风格。React portal 继承同一 Provider，不能只靠 `.work-view svg` 的 CSS 后代选择器实现。

## 语义

| 功能 | 图标 |
| --- | --- |
| 工作台 | `dashboard` |
| 项目 / 工作区 | `folder-outline` |
| Agent / 子代理集合 | `account-outline` / `users` |
| 插件 / 内置插件管理工具包 | `puzzle` / `extensions` |
| 浏览器 / 搜索 | `globe` / `search` |
| 自动化 / 引擎监控 | `clock-outline` / `activity` |
| 全局运行列表 | `list-play` |
| 成果 / 资料 | `file-check` / `library` |
| Skill / 知识库 / MCP | `package-variant-closed` / `book-open` / `plug` |
| 刷新数据 / 重新执行 | `refresh` / `restart` |
| 下载、导出 / 上传 | `download` / `upload-outline` |

同义操作（复制、删除、搜索等）的旧名称映射到同一几何。工具包菜单、输入框标签和历史引用共用目录；子代理按持久化的角色身份选择图标，不根据显示名称猜测身份。

## 尺寸与例外

- 侧栏 18px，常规操作 16px，紧凑状态 12–14px，空态 24–28px；点击区域由按钮负责。
- 图标在有文本或按钮标签时作为装饰，保持 `aria-hidden`，图标按钮必须保留可访问名称。
- 文件类型、品牌标识保留自己的识别图形。进度圆环、图表及浏览器坐标图是数据可视化，不替换成操作图标。
- 图片标注工具采用相同线宽，撤销/重做复用统一目录。

## 验证

先运行 `npm run build`，再运行：

```sh
npx playwright test --config e2e/config/playwright.work-icons.config.ts
npx playwright test --config e2e/config/playwright.mention-toolkit.config.ts --grep "@ 单列分组|MCP 管理工具包与插件共同选择|资源菜单紧凑"
```

图标用例在隔离 Electron 配置中检查语义、尺寸、描边、门户继承、模式切换和全目录 SVG 边界，并输出深浅主题截图。不要用固定 SVG 子节点数量代替状态语义断言。
