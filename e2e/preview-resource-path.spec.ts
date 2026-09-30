/** 本地预览资源解析边界，纯函数，不启动 Electron。 */
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolvePreviewResource } from '../src/renderer/src/core/editor/preview-resource-path'

test('宿主 CSP 仅放行源码内固定的预览滚动桥脚本', () => {
  const bridge = readFileSync(resolve(__dirname, '../src/renderer/src/contrib/editor/preview-bridge.js'), 'utf8').replace(/\r\n?/g, '\n')
  const hash = createHash('sha256').update(bridge).digest('base64')
  const host = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8')
  expect(host).toContain(`'sha256-${hash}'`)
  const policy = host.match(/content="([^"]+)"/)?.[1] ?? ''
  expect(policy.match(/script-src[^;]+/)?.[0]).not.toContain('unsafe-inline')
})

test('预览资源相对当前文件解析，保留中文空格并忽略版本参数', () => {
  expect(resolvePreviewResource('D:\\project\\docs\\index.html', '../images/中文 logo.png?v=1#x', 'D:\\project'))
    .toBe('D:/project/images/中文 logo.png')
  expect(resolvePreviewResource('/project/docs/readme.md', '../images/logo.png', '/project'))
    .toBe('/project/images/logo.png')
})

test('Windows 路径大小写不同仍可读取同一工作区', () => {
  expect(resolvePreviewResource('D:/Project/docs/index.html', 'file:///d:/project/images/a.png', 'D:/Project'))
    .toBe('d:/project/images/a.png')
})

test('预览不能读取其他工作区、编码越界路径或网络地址', () => {
  const from = 'D:/project/docs/index.html'
  for (const resource of ['../../secrets.png', '../../project-other/logo.png', '..%2f..%2fsecrets.png', 'file:///C:/Users/me/secret.png', 'https://example.com/x.png', 'javascript:alert(1)', 'data:text/html,hello']) {
    expect(resolvePreviewResource(from, resource, 'D:/project'), resource).toBeNull()
  }
})

test('UNC 工作区路径能解析相邻文件但不能跳到另一共享目录', () => {
  expect(resolvePreviewResource('\\\\server\\share\\project\\docs\\index.html', '../logo.png', '\\\\server\\share\\project'))
    .toBe('//server/share/project/logo.png')
  expect(resolvePreviewResource('\\\\server\\share\\project\\docs\\index.html', 'file://server/other/logo.png', '\\\\server\\share\\project')).toBeNull()
})
