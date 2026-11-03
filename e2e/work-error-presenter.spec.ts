import { expect, test } from '@playwright/test'
import { presentWorkError } from '../src/renderer/src/contrib/work/work-error-presenter'

test.describe('Work 错误摘要', () => {
  test('把引擎重启中断转换成可读摘要并保留诊断上下文', () => {
    const result = presentWorkError('[子代理最终结果]\n[子任务状态] {"status":"interrupted","errorCode":"ENGINE_RESTARTED","runId":"run-123456789"}')
    expect(result.title).toBe('任务已中断')
    expect(result.summary).toContain('引擎已重启')
    expect(result.retryable).toBe(true)
    expect(result.detail).toContain('ENGINE_RESTARTED')
    expect(result.detail).toContain('run-123456789')
  })

  test('只有机器标记时不会把内部协议标记当作用户摘要', () => {
    const result = presentWorkError('[子代理最终结果]\n[子任务状态] {"status":"failed"}')
    expect(result.summary).toBe('引擎未提供具体原因，请查看诊断详情。')
    expect(result.summary).not.toContain('子代理最终结果')
    expect(result.retryable).toBe(true)
  })

  test('等待确认或受阻状态不提供重复执行建议', () => {
    expect(presentWorkError('[子任务状态] {"status":"waiting"}').retryable).toBe(false)
    expect(presentWorkError('[子任务状态] {"status":"blocked"}').retryable).toBe(false)
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

  test('根运行输出上限使用中文原因，并保留英文、错误码与运行标识', () => {
    const original = 'Model response ended before completion'
    const result = presentWorkError(original, {
      status: 'failed', runId: 'root-output-limit', stopReason: 'output_limit',
      error: { code: 'OUTPUT_LIMIT', message: original }
    })
    expect(result.title).toBe('模型输出达到上限')
    expect(result.summary).toBe('模型本轮输出达到上限，已保留现有内容。可调整思考或输出设置后重试。')
    expect(result.summary).not.toContain('只有思考')
    expect(result.detail).toContain(original)
    expect(result.detail).toContain('OUTPUT_LIMIT')
    expect(result.detail).toContain('root-output-limit')
    expect(result.detail).toContain('停止原因：output_limit')
    expect(result.retryable).toBe(true)
  })

  test('旧运行只有 stopReason 时仍可准确识别输出上限', () => {
    const result = presentWorkError('Model response ended before completion', {
      status: 'failed', runId: 'legacy-limit', stopReason: 'output_limit',
      error: 'Model response ended before completion'
    })
    expect(result.title).toBe('模型输出达到上限')
    expect(result.summary).toContain('调整思考或输出设置')
    expect(result.detail).toContain('legacy-limit')
  })

  test('同一句通用英文的 INCOMPLETE_RESPONSE 不误报输出上限或网络故障', () => {
    const original = 'Model response ended before completion'
    const result = presentWorkError(original, {
      status: 'failed', runId: 'root-incomplete',
      error: { code: 'INCOMPLETE_RESPONSE', message: original }
    })
    expect(result.title).toBe('模型响应未完成')
    expect(result.summary).toBe('模型响应提前结束，未返回完整结果。')
    expect(result.summary).not.toMatch(/上限|断网|网络/)
    expect(result.detail).toContain(original)
    expect(result.detail).toContain('INCOMPLETE_RESPONSE')
  })

  test('缺少结构化原因时只呈现响应未完成，不猜长度限制', () => {
    const original = 'Model response ended before completion'
    const result = presentWorkError(original)
    expect(result.title).toBe('模型响应未完成')
    expect(result.summary).toBe('模型响应提前结束，未返回完整结果。')
    expect(result.detail).toContain(original)
    expect(result.code).toBeUndefined()
  })

  test('根运行原因优先于正文中的其他错误标记，并保留两份原始诊断', () => {
    const raw = '[子任务状态] {"status":"failed","errorCode":"OUTPUT_LIMIT","runId":"quoted-run"}'
    const original = 'Model response ended before completion'
    const result = presentWorkError(raw, {
      status: 'failed', runId: 'actual-run',
      error: { code: 'INCOMPLETE_RESPONSE', message: original }
    })
    expect(result.title).toBe('模型响应未完成')
    expect(result.code).toBe('INCOMPLETE_RESPONSE')
    expect(result.runId).toBe('actual-run')
    expect(result.detail).toContain(raw)
    expect(result.detail).toContain(original)
  })

  test('其他明确运行原因不被通用英文覆盖，等待状态仍禁止重试', () => {
    const original = 'Model response ended before completion'
    const timeout = presentWorkError(original, {
      status: 'failed', runId: 'timeout-run', error: { code: 'TIMEOUT', message: original }
    })
    expect(timeout.summary).toContain('超时')
    const waiting = presentWorkError(original, {
      status: 'waiting', runId: 'waiting-run', error: { code: 'NEEDS_USER', message: original }
    })
    expect(waiting.title).toBe('任务需要处理')
    expect(waiting.retryable).toBe(false)
  })
})
