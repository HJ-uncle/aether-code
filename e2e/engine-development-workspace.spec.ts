/** Pure launch-policy coverage: stable scratch storage across dev builds,
 * desktop profile isolation, and explicit workspace override compatibility. */
import { expect, test } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { developmentRuntimeEnvironment } from '../src/main/engine/development-runtime'

const fixture = resolve('.e2e-tmp', 'development-workspace-policy')
const profile = join(fixture, 'desktop profile')
const entry = join(fixture, 'ai-agent-engine', '.tmp', 'aether-code-dev', 'first-build', 'dist', 'main.js')

test('开发构建更换入口后沿用同一用户工作区，运行目录仍各自隔离', () => {
  const next = join(fixture, 'ai-agent-engine', '.tmp', 'aether-code-dev', 'second-build', 'dist', 'main.js')
  const sibling = join(fixture, 'ai-agent-engine', 'dist', 'main.js')
  const expectedWorkspace = join(profile, 'engine', 'state', 'workspace')
  for (const runtime of [entry, next, sibling]) {
    expect(developmentRuntimeEnvironment(runtime, profile)).toEqual({
      cwd: dirname(runtime), env: { WORKSPACE_ROOT: expectedWorkspace }
    })
  }
})

test('不同桌面配置目录的默认开发工作区保持隔离', () => {
  const otherProfile = join(fixture, 'other profile')
  const first = developmentRuntimeEnvironment(entry, profile)
  const other = developmentRuntimeEnvironment(entry, otherProfile)
  expect(other.env.WORKSPACE_ROOT).toBe(join(otherProfile, 'engine', 'state', 'workspace'))
  expect(other.env.WORKSPACE_ROOT).not.toBe(first.env.WORKSPACE_ROOT)
  expect(other.cwd).toBe(first.cwd)
})

test('明确的绝对工作区覆盖继续优先于桌面默认目录', () => {
  const selected = join(fixture, 'selected workspace')
  expect(developmentRuntimeEnvironment(entry, profile, selected)).toEqual({
    cwd: dirname(entry), env: { WORKSPACE_ROOT: selected }
  })
})

test('明确的相对覆盖仍按原引擎运行目录解析', () => {
  const configured = '../existing workspace'
  const selected = developmentRuntimeEnvironment(entry, profile, configured)
  expect(selected.env.WORKSPACE_ROOT).toBe(join(dirname(dirname(entry)), 'existing workspace'))
  expect(selected.env.WORKSPACE_ROOT).not.toBe(resolve(configured))
  expect(selected.env.WORKSPACE_ROOT).not.toBe(resolve(profile, configured))
  expect(selected.cwd).toBe(dirname(entry))
})

test('空白环境配置使用稳定默认目录', () => {
  for (const empty of ['', '   ']) {
    expect(developmentRuntimeEnvironment(entry, profile, empty).env.WORKSPACE_ROOT)
      .toBe(join(profile, 'engine', 'state', 'workspace'))
  }
})
