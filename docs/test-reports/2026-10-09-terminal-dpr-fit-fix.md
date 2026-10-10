# 终端字号恢复与125%缩放修复（2026-10-09）

字号12px改为20px，再恢复12px，画面和远端PTY都只恢复到11行，原先有12行。全量和两次专项均复现；未通过增加等待、修改精确行数或归类偶发来掩盖。

现场DPR为1.25，容器始终为830×202.387px，字体已加载，字体家族相同，祖先滚动位置全部为0。排除了容器变化、字体尚未加载或滚动导致的解释。

xterm DOM renderer将总画布高度取整后除以当前行数，得到下一次FitAddon使用的CSS字符高度。字体恢复时当前为7行：`round(21*7/1.25)/7=16.857px`，第一次拟合202px得到11行；resize后字符高度变为`185/11=16.818px`，下一次应得到12行。12行的字符高度变为`202/12=16.833px`，此时稳定。

旧实现只执行一次fit；容器高度未变化，ResizeObserver不会再触发。`use-terminal-fit.ts`现使用公开的fit/proposeDimensions API，最多4次同步收敛，只有最终行列通过transport发送PTY。同尺寸请求仍去重，隐藏容器仍不拟合，不依赖xterm私有API。

- `npm run build`（含typecheck）：通过，日志`.e2e-tmp/terminal-fit-build-20261009.log`。
- 原严格终端回归4/4通过：面板拖动、窗口改变、隐藏/切回、多次相同resize、字体恢复。
- 12→20→12回到原精确行数，未放宽断言。
- 原始失败：`.e2e-tmp/terminal-geometry-20261009.json`，独立trace为`.e2e-tmp/terminal-geometry-traces-20261009`。
- 修复后：`.e2e-tmp/terminal-fit-fixed-20261009.json`，几何数据记录在测试附件。
- 精简现场证据：[2026-10-09-terminal-dpr-fit-evidence.json](D:/dev/aether-code/docs/test-reports/2026-10-09-terminal-dpr-fit-evidence.json)。
- 完整客户端最终轮：`.e2e-tmp/client-converged-final-full-20261009.{json,log}`，固定workers=1、retries=0。结果另见完整验收报告。

此用例通过真实Electron、xterm、preload、IPC和WebSocket；远端PTY为受控协议夹具。不能据此宣称互联网跨机器PTY全部场景已经通过。
