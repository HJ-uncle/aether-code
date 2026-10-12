/** Product capability profiles are selected per request, not per engine process. */
export type ToolProfile = 'code' | 'general'

/** Keep the historical export for callers that use the Code default. */
export const CODE_TOOL_PROFILE_HEADERS = { 'X-Aether-Tool-Profile': 'code' } as const

export function toolProfileHeaders(profile: ToolProfile = 'code'): Record<string, string> {
  // Both product modes own background jobs. Tool scope does not determine
  // whether leaving a conversation should cancel its producer.
  return { 'X-Aether-Tool-Profile': profile, 'X-Aether-Run-Lifetime': 'durable' }
}
