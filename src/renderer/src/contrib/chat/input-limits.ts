/** Keep the editor budget separate from transport byte limits and attachment sizes. */
export const COMPOSER_MAX_CHARS = 100_000

export function composerCharacterCount(text: string): number {
  let count = 0
  for (const _character of text) count++
  return count
}

export function composerInputIssue(text: string): string | null {
  return composerCharacterCount(text) > COMPOSER_MAX_CHARS
    ? '输入最多支持 100,000 个字符，请精简内容或将长文本作为附件添加。'
    : null
}

/** Old drafts remain editable even when their original size exceeds today's limit. */
export function acceptsComposerChange(previous: string, next: string): boolean {
  const count = composerCharacterCount(next)
  return count <= COMPOSER_MAX_CHARS || count <= composerCharacterCount(previous)
}
