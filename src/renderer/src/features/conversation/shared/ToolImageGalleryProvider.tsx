import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react'
import type { ChatMessage } from '@renderer/core/engine/useChat'
import { isVisibleToolActivity } from '@renderer/core/engine/task-plan'
import { toolPresentation } from './tool-presentation'
import { buildToolImageGallery, type ToolImageGalleryIndex } from './tool-image-gallery'

const GalleryContext = createContext<{ index: ToolImageGalleryIndex; active: boolean } | null>(null)
export const useToolImageGallery = (): { index: ToolImageGalleryIndex; active: boolean } | null => useContext(GalleryContext)

export function ToolImageGalleryProvider({ messages, source, sessionId, active = true, children }: {
  messages: readonly ChatMessage[]; source: number; sessionId: string; active?: boolean; children: ReactNode
}): JSX.Element {
  const index = useMemo(() => buildToolImageGallery(messages.flatMap(message => message.tools.filter(isVisibleToolActivity)
    .map(tool => ({ toolId: tool.id, toolName: tool.name, args: tool.args, result: toolPresentation(tool) }))), { source, sessionId }), [messages, source, sessionId])
  const value = useMemo(() => ({ index, active }), [index, active])
  return <GalleryContext.Provider value={value}>{children}</GalleryContext.Provider>
}
