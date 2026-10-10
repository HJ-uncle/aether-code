# Client受影响专项 – e1214

- buildId: `sha256:e1214ac419b520d8073466c6dacb74f52631c08e605eddb5a48f80da2d12d5ac`
- TGZ SHA256: `87238F2811F2DB02F969B186532B24B6B9CC5202D4BC70F289AB96A57872F058`
- command: `npx playwright test e2e/chat-artifact-link-ui.spec.ts e2e/composer-defaults-ui.spec.ts e2e/smoke.spec.ts --workers=1 --retries=0 --reporter=json`
- result: **50 passed, 0 failed, 0 skipped, 0 notRun, 0 flaky**, 98.529 seconds
- JSON evidence: `.e2e-tmp/client-e1214-contract-special-20261010.json`
- scope: 真实认证交付链接、嵌入/远端会话偏好隔离与刷新、memory/security CRUD、工作台和终端/编辑器 smoke