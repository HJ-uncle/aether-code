import { expect, test } from '@playwright/test'
import {
  ACTION_LABELS,
  MODE_DESCRIPTORS,
  SECURITY_MODES,
  buildModePayload,
  isRiskyMode,
  isSecurityMode,
  parseSecurityMode
} from '../src/renderer/src/core/engine/security'

/**
 * 安全客户端测试
 *
 * 这些是纯函数：security.ts 只把 request 当普通 import，而 request 依赖的
 * client.ts 里对 @shared/ipc 是 type-only import（编译后擦除），
 * 因此整个模块在 Node 里加载不会碰到 window.aether。
 *
 * 为什么值得测：
 *  - 安全模式的取值必须在发请求前校验好。发一个非法 mode 给引擎会被拒，
 *    但界面如果先乐观更新就会显示成"已切换"，形成表里不一的假象。
 *  - GET /security/mode 的返回形状是 { sessionId, mode } 而非裸字符串，
 *    这里对两种形状都做兼容，需要断言兼容逻辑本身没写反。
 */

test.describe('isSecurityMode', () => {
  test('只接受三种合法取值', () => {
    expect(isSecurityMode('safe')).toBe(true)
    expect(isSecurityMode('standard')).toBe(true)
    expect(isSecurityMode('full-access')).toBe(true)
  })

  test('非法取值一律拒绝', () => {
    expect(isSecurityMode('SAFE')).toBe(false)
    expect(isSecurityMode('fullAccess')).toBe(false)
    expect(isSecurityMode('')).toBe(false)
    expect(isSecurityMode(undefined)).toBe(false)
    expect(isSecurityMode(null)).toBe(false)
    expect(isSecurityMode({ mode: 'safe' })).toBe(false)
  })
})

test.describe('parseSecurityMode', () => {
  test('兼容引擎的对象形状 { sessionId, mode }', () => {
    expect(parseSecurityMode({ sessionId: 's1', mode: 'full-access' })).toBe('full-access')
  })

  test('兼容裸字符串（引擎若将来简化返回也不会崩）', () => {
    expect(parseSecurityMode('standard')).toBe('standard')
  })

  test('无法识别时返回 null，由调用方兜底为 safe', () => {
    expect(parseSecurityMode({ mode: 'unknown' })).toBeNull()
    expect(parseSecurityMode({ sessionId: 's1' })).toBeNull()
    expect(parseSecurityMode(null)).toBeNull()
  })
})

test.describe('buildModePayload', () => {
  test('合法入参原样带出 sessionId 与 mode', () => {
    expect(buildModePayload('s-1', 'standard')).toEqual({ sessionId: 's-1', mode: 'standard' })
  })

  test('缺少 sessionId 时抛错（模式是会话级的，缺了就必然设错）', () => {
    expect(() => buildModePayload('', 'safe')).toThrow(/会话 ID/)
  })

  test('非法 mode 抛错而不是静默发出', () => {
    // 引擎侧也会校验，但界面必须先失败，否则乐观更新会显示成已切换
    expect(() => buildModePayload('s-1', 'yolo' as never)).toThrow(/安全模式/)
  })
})

test.describe('模式元数据', () => {
  test('三种模式都有描述，且 full-access 必须带风险提示', () => {
    expect(MODE_DESCRIPTORS.map((d) => d.value)).toEqual([...SECURITY_MODES])
    for (const descriptor of MODE_DESCRIPTORS) {
      expect(descriptor.summary.length).toBeGreaterThan(0)
    }
    expect(MODE_DESCRIPTORS.find((d) => d.value === 'full-access')?.warning).toBeTruthy()
  })

  test('只有 full-access 属于高风险模式', () => {
    expect(isRiskyMode('full-access')).toBe(true)
    expect(isRiskyMode('standard')).toBe(false)
    expect(isRiskyMode('safe')).toBe(false)
  })

  test('三种动作都有中文标签（下拉框依赖它渲染）', () => {
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(['allow', 'ask', 'deny'])
    expect(ACTION_LABELS.allow).toBe('放行')
  })
})
