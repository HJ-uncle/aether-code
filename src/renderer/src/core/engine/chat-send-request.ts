import type { SendOptions } from './useChat'
import { clientCapabilities } from '../workbench/capabilities'
import { getEngineSource } from './source'

export class ChatRequestRejectedError extends Error {
  readonly requestRejected = true
  constructor(message: string) { super(message); this.name = 'ChatRequestRejectedError' }
}

/** Keep request serialization on the same boundary for direct and queued turns. */
export async function dispatchChatRequest(
  transport: (body: Record<string, unknown>) => Promise<void>,
  text: string,
  options: SendOptions,
  remote: boolean
): Promise<void> {
  const attachments = options.attachments ?? []
  const serializedAttachments = attachments.map(file => ({
    ...(remote && file.remoteUploadId ? { remoteUploadId: file.remoteUploadId } : { name: file.path, type: file.type }),
    displayName: file.name, size: file.size,
    ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}),
    ...(file.referenceLabel ? { referenceLabel: file.referenceLabel } : {})
  }))
  await transport({
    message: text,
    sessionId: options.sessionId || undefined,
    agentId: options.agentId || undefined,
    collaborators: options.collaborators,
    model: options.model || undefined,
    knowledgeBases: options.knowledgeBases,
    skills: options.skills,
    mcpServers: options.mcpServers,
    toolkits: options.toolkits,
    workspacePaths: !remote && options.workspacePaths?.length ? options.workspacePaths : undefined,
    thinkingMode: options.thinkingMode,
    subagentModel: options.subagentModel,
    utilityModel: options.utilityModel,
    memoryScope: options.memoryScope,
    clientCapabilities: clientCapabilities(getEngineSource(), options.sessionId, 'work'),
    attachments: serializedAttachments.length ? serializedAttachments : undefined
  })
}
