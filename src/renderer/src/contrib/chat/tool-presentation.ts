import type { ToolActivity } from '@renderer/core/engine/useChat'
import { parseToolResult, type ParsedToolResult } from './tool-result'

// Immutable tool snapshots can be shared by the timeline and compact rows without
// decoding large image results again as unrelated message text streams in.
const presentations = new WeakMap<ToolActivity, ParsedToolResult>()

export function toolPresentation(tool: ToolActivity): ParsedToolResult {
  let result = presentations.get(tool)
  if (!result) {
    result = parseToolResult(tool.result)
    presentations.set(tool, result)
  }
  return result
}
