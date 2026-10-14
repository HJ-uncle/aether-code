import type { SendOptions } from './useChat'

/** Keep request serialization on the same boundary for direct and queued turns. */
export async function dispatchChatRequest(
  transport: (body: Record<string, unknown>) => Promise<void>,
  text: string,
  options: SendOptions,
  remote: boolean
): Promise<void> {
  const attachments = options.attachments ?? []
  await transport({
    message: text,
    sessionId: options.sessionId || undefined,
    agentId: options.agentId || undefined,
    collaborators: options.collaborators,
    model: options.model || undefined,
    knowledgeBases: options.knowledgeBases,
    skills: options.skills,
    mcpServers: options.mcpServers,
    workspacePaths: !remote && options.workspacePaths?.length ? options.workspacePaths : undefined,
    thinkingMode: options.thinkingMode,
    subagentModel: options.subagentModel,
    utilityModel: options.utilityModel,
    memoryScope: options.memoryScope,
    attachments: attachments.length > 0
      ? remote
        ? attachments.map(file => file.remoteUploadId
          ? { remoteUploadId: file.remoteUploadId }
          : { name: file.path, type: file.type })
        : attachments.map(file => ({ name: file.path, type: file.type }))
      : undefined
  })
}
