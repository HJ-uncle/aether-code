/**
 * 轻任务 LLM 调用（提交信息生成 / 输入润色等辅助场景）
 *
 * 走引擎 POST /utility/chat：单次非流式问答，不进会话、不写历史、没有工具。
 * model 传空字符串时由引擎回退到默认模型；传「轻任务模型」设置值时使用对应凭据。
 */
import { requestOrThrow } from './client'

export interface UtilityChatInput {
  /** 模型 modelId；空串 = 引擎默认模型 */
  model?: string
  systemPrompt?: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
}

export function utilityChat(input: UtilityChatInput): Promise<{ text: string }> {
  return requestOrThrow<{ text: string }>({
    method: 'POST',
    path: '/utility/chat',
    body: {
      model: input.model?.trim() || undefined,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens
    }
  })
}
