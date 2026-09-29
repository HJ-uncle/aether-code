import { expect, test } from '@playwright/test'
import {
  buildToolResponse,
  mergePending,
  normalizePending,
  type PendingInteraction
} from '../src/renderer/src/core/engine/pending'

/**
 * 纯函数测试：交互帧归一化（pending.ts）。
 *
 * 本文件覆盖：normalizePending（安全拦截帧 / 提问帧的多种形状）、
 * mergePending（同 id 帧的优先级合并）、buildToolResponse（回传值构造）。
 *
 * 这块逻辑是"对话卡住"这个 bug 的修复核心，且引擎侧的帧形状不统一
 * （ask_user 的 options 有对象数组与字符串数组两种），因此单独覆盖。
 *
 * 这些是纯函数：pending.ts 只 import type，运行时无任何依赖，
 * 所以可以直接被 Playwright 的 TS 加载器编译执行。
 */

test.describe('normalizePending', () => {
  test('安全拦截帧：工具名取真实工具、选项固定为 approved/rejected', () => {
    const pending = normalizePending({
      permissionRequest: {
        requestId: 'call_01_abc',
        toolName: 'execute_cmd',
        description: '安全策略拦截了此操作，是否允许执行？',
        args: { command: 'git', args: ['log'] }
      }
    })

    expect(pending).not.toBeNull()
    expect(pending!.kind).toBe('permission')
    expect(pending!.toolCallId).toBe('call_01_abc')
    // 关键：回传时必须用被拦截的真实工具名，而不是 'ask_user'
    expect(pending!.toolName).toBe('execute_cmd')
    expect(pending!.question).toContain('是否允许执行')
    expect(pending!.options.map((o) => o.value)).toEqual(['approved', 'rejected'])
  })

  test('安全拦截帧：缺少 description 时自行生成可读问题', () => {
    const pending = normalizePending({
      permissionRequest: { requestId: 'r1', toolName: 'execute_cmd' }
    })
    expect(pending!.question).toContain('execute_cmd')
  })

  test('提问帧：对象数组选项取 label 作为显示与回传值', () => {
    const pending = normalizePending({
      ask_user: {
        toolCallId: 'call_02',
        question: '要使用哪个包管理器？',
        options: [{ label: 'npm', description: '用 package-lock.json' }, { label: 'pnpm' }]
      }
    })

    expect(pending!.kind).toBe('ask')
    expect(pending!.toolName).toBe('ask_user')
    expect(pending!.options).toEqual([
      { label: 'npm', value: 'npm', description: '用 package-lock.json' },
      { label: 'pnpm', value: 'pnpm' }
    ])
  })

  test('提问帧：字符串数组选项（引擎的另一种形状）也能处理', () => {
    const pending = normalizePending({
      ask_user: { toolCallId: 'call_03', question: '继续吗？', options: ['是', '否'] }
    })
    expect(pending!.options).toEqual([
      { label: '是', value: '是' },
      { label: '否', value: '否' }
    ])
  })

  test('提问帧：无选项时保留自由输入，不合成批准或拒绝按钮', () => {
    const pending = normalizePending({
      ask_user: { toolCallId: 'call_04', question: '需要确认' }
    })
    expect(pending!.options).toEqual([])
    expect(pending!.groups).toEqual([{
      tab: '', question: '需要确认', options: [], multiSelect: false, allowInput: true
    }])
    expect(buildToolResponse(pending!, ['请先检查配置'])).toEqual({
      toolCallId: 'call_04', name: 'ask_user', output: '请先检查配置'
    })
    expect(buildToolResponse(pending!, ['跳过'])).toEqual({
      toolCallId: 'call_04', name: 'ask_user', output: '跳过'
    })
  })

  test('非交互帧返回 null', () => {
    expect(normalizePending({ content: '普通文本' })).toBeNull()
    expect(normalizePending({ toolStart: { name: 'read_file' } })).toBeNull()
  })

  test('缺少 toolCallId 时返回 null（无法应答，不应产生死卡片）', () => {
    expect(normalizePending({ ask_user: { question: '没有 id' } })).toBeNull()
    expect(normalizePending({ permissionRequest: { toolName: 'execute_cmd' } })).toBeNull()
  })
})

test.describe('mergePending', () => {
  test('同一 toolCallId 时以 permission 帧为准（它带真实工具名）', () => {
    // 引擎对授权场景会先发 ask_user 别名帧、再发 permission 帧
    const askAlias = normalizePending({
      ask_user: {
        toolCallId: 'call_05',
        question: '是否允许执行？',
        options: ['approved', 'rejected']
      }
    })!
    const permission = normalizePending({
      permissionRequest: { requestId: 'call_05', toolName: 'execute_cmd', description: '拦截了' }
    })!

    expect(askAlias.toolName).toBe('ask_user')
    const merged = mergePending(askAlias, permission)
    expect(merged.kind).toBe('permission')
    expect(merged.toolName).toBe('execute_cmd')
  })

  test('permission 先到、ask 别名后到时不会被覆盖回 ask_user', () => {
    const permission = normalizePending({
      permissionRequest: { requestId: 'call_06', toolName: 'execute_cmd' }
    })!
    const askAlias = normalizePending({
      ask_user: {
        toolCallId: 'call_06',
        question: '是否允许执行？',
        options: ['approved', 'rejected']
      }
    })!

    const merged = mergePending(permission, askAlias)
    expect(merged.toolName).toBe('execute_cmd')
  })

  test('不同 toolCallId 时替换为新交互', () => {
    const first: PendingInteraction = {
      kind: 'ask',
      question: '第一个',
      options: [{ label: 'a', value: 'a' }],
      toolCallId: 'id-1',
      toolName: 'ask_user',
      multiSelect: false,
      groups: [{ tab: '', question: '第一个', options: [{ label: 'a', value: 'a' }], multiSelect: false, allowInput: true }]
    }
    const second: PendingInteraction = { ...first, question: '第二个', toolCallId: 'id-2' }
    expect(mergePending(first, second).question).toBe('第二个')
  })
})

test.describe('buildToolResponse', () => {
  test('授权场景回传 value（approved）而非中文 label', () => {
    const pending = normalizePending({
      permissionRequest: { requestId: 'call_07', toolName: 'execute_cmd' }
    })!
    // UI 上点的是「允许执行」，但必须回传 approved —— 引擎是严格 === 匹配
    const response = buildToolResponse(pending, ['approved'])
    expect(response).toEqual({
      toolCallId: 'call_07',
      name: 'execute_cmd',
      output: 'approved'
    })
    expect(response.output).not.toBe('允许执行')
  })

  test('多选时用逗号连接', () => {
    const pending: PendingInteraction = {
      kind: 'ask',
      question: '选哪些？',
      options: [],
      toolCallId: 'id-3',
      toolName: 'ask_user',
      multiSelect: true,
      groups: [{ tab: '', question: '选哪些？', options: [], multiSelect: true, allowInput: true }]
    }
    expect(buildToolResponse(pending, ['a', 'b']).output).toBe('a,b')
  })
})
