import { expect, test } from '@playwright/test'
import { parseLaunchInstance } from '../src/shared/instance-profile'

/** Pure launch contract: default launches stay single-instance; opt-in profiles isolate state. */
test.describe('多实例启动标识', () => {
  test('默认启动保持历史单实例配置', () => {
    expect(parseLaunchInstance(['out/main/index.js'])).toEqual({ mode: 'default', id: null })
  })

  test('new-instance generates an isolated profile request', () => {
    expect(parseLaunchInstance(['out/main/index.js', '--new-instance'], 'instance-test-1')).toEqual({
      mode: 'new',
      id: 'instance-instance-test-1'
    })
  })

  test('named profile is deterministic and rejects path traversal', () => {
    expect(parseLaunchInstance(['--aether-instance=work-2'])).toEqual({ mode: 'named', id: 'work-2' })
    expect(() => parseLaunchInstance(['--aether-instance=..\\outside'])).toThrow(/无效的引擎实例标识/)
  })
})

