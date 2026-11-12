/** Product capability profiles are selected per request, not per engine process. */
export type ToolProfile = 'code' | 'general'

/** Keep the historical export for callers that need to request the optional Code profile explicitly. */
export const CODE_TOOL_PROFILE_HEADERS = { 'X-Aether-Tool-Profile': 'code' } as const

export function toolProfileHeaders(profile: ToolProfile = 'general'): Record<string, string> {
  // Work is the only desktop surface. Code remains an explicit protocol
  // option for other clients, never an implicit desktop default.
  return { 'X-Aether-Tool-Profile': profile, 'X-Aether-Run-Lifetime': 'durable' }
}
