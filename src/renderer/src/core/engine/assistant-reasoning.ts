export interface AssistantReasoningText {
  content: string
  thinking: string
}

/** Older providers placed their reasoning envelope in the content channel.
 * Only a leading envelope is protocol: quoted examples and code stay literal.
 * This is a display adapter; archived messages remain untouched. */
export function splitAssistantReasoning(text: string, streaming = false): AssistantReasoningText {
  let content = text
  const thoughts: string[] = []
  while (true) {
    const leading = content.trimStart()
    const whitespace = content.slice(0, content.length - leading.length)
    const indentation = whitespace.slice(whitespace.lastIndexOf('\n') + 1)
    if (indentation.includes('\t') || indentation.length >= 4) break
    const opening = /^<think>/i.exec(leading)
    if (!opening) {
      // The stream may stop anywhere inside the opening delimiter. Avoid
      // flashing protocol fragments before enough characters establish it.
      if (streaming && leading && '<think>'.startsWith(leading.toLowerCase())) content = ''
      break
    }
    const remaining = leading.slice(opening[0].length)
    const closing = /<\/think>/i.exec(remaining)
    if (!closing) {
      // A cancelled stream can leave an unfinished envelope. Its tail is
      // reasoning, never a completed answer.
      const partialClose = streaming ? /<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i : null
      thoughts.push(partialClose ? remaining.replace(partialClose, '') : remaining)
      content = ''
      break
    }
    thoughts.push(remaining.slice(0, closing.index))
    content = remaining.slice(closing.index + closing[0].length)
  }
  return { content, thinking: thoughts.filter(value => value.trim()).join('\n\n').trim() }
}
