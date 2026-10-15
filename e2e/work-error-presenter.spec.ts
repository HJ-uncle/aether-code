import { expect, test } from '@playwright/test'
import { presentWorkError } from '../src/renderer/src/contrib/work/work-error-presenter'

test.describe('Work 错误摘要', () => {
  test('把引擎重启中断转换成可读摘要并保留诊断上下文', () => {
    const result = presentWorkError('[子代理最终结果]\n[子任务状态] {"status":"interrupted","errorCode":"ENGINE_RESTARTED","runId":"run-123456789"}')
    expect(result.title).toBe('任务已中断')
    expect(result.summary).toContain('引擎已重启')
    expect(result.detail).toContain('ENGINE_RESTARTED')
    expect(result.detail).toContain('run-123456789')
  })

  test('只有机器标记时不会把内部协议标记当作用户摘要', () => {
    const result = presentWorkError('[子代理最终结果]\n[子任务状态] {"status":"failed"}')
    expect(result.summary).toBe('引擎未提供具体原因，请查看诊断详情。')
    expect(result.summary).not.toContain('子代理最终结果')
  })

  test('成功状态的正文引用旧错误码时不重新标记为引擎重启', () => {
    const result = presentWorkError('[子代理最终结果]\n[子任务状态] {"status":"succeeded"}\n说明：日志中提到 ENGINE_RESTARTED 作为历史案例')
    expect(result.summary).not.toContain('引擎已重启')
  })

  test('长诊断被限制在可展开详情范围内', () => {
    const result = presentWorkError('x'.repeat(20_000))
    expect(result.detail.length).toBeLessThan(16_200)
    expect(result.detail).toContain('诊断信息过长')
  })
})
