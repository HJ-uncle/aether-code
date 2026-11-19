import type { Locator } from '@playwright/test'

/** A disposable page can witness a real 32-byte Web Crypto draw and a copy
 * without returning the draft, writing the OS clipboard, or recording secrets. */
interface DraftObserver {
  lastDraw: string
  writes: string[]
  rejectCopy: boolean
}
declare global {
  interface Window {
    __credentialDraftObserver?: DraftObserver
  }
}

export function observeCredentialDrafts(): void {
  const state: DraftObserver = { lastDraw: '', writes: [], rejectCopy: false }
  window.__credentialDraftObserver = state
  const nativeRandom = window.crypto.getRandomValues.bind(window.crypto)
  Object.defineProperty(window.crypto, 'getRandomValues', {
    configurable: true,
    value: (view: Uint8Array) => {
      const result = nativeRandom(view)
      if (result instanceof Uint8Array && result.byteLength === 32)
        state.lastDraw = Array.from(result, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return result
    }
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (state.rejectCopy) throw new Error('Clipboard access denied in test')
        state.writes.push(text)
      }
    }
  })
}

export function refuseClipboardWrites(): void {
  const observer = window.__credentialDraftObserver
  if (!observer) throw new Error('Missing test clipboard observer')
  observer.rejectCopy = true
}
interface DraftEvidence {
  digest: string
  masked: boolean
  fresh: boolean
  exposed: boolean
  copies: number
  lastCopyMatches: boolean
  allSelected: boolean
}
export function readDraftEvidence(field: Locator): Promise<DraftEvidence> {
  return field.evaluate(async (input) => {
    const state = window.__credentialDraftObserver
    if (!state) throw new Error('Missing test credential observer')
    const element = input as HTMLInputElement,
      value = element.value
    const hex = (buffer: ArrayBuffer): string =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const inText =
      !!value &&
      (document.body.innerText.includes(value) ||
        [...document.querySelectorAll('[title], [aria-label]')].some((node) =>
          [node.getAttribute('title'), node.getAttribute('aria-label')].some((label) =>
            label?.includes(value)
          )
        ))
    const inStorage =
      !!value &&
      [localStorage, sessionStorage].some((storage) =>
        Object.values(storage).some((item) => typeof item === 'string' && item.includes(value))
      )
    return {
      digest: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      masked: element.type === 'password',
      fresh: /^[a-f0-9]{64}$/.test(value) && state.lastDraw === value,
      exposed: inText || inStorage,
      allSelected:
        value.length > 0 &&
        document.activeElement === element &&
        element.selectionStart === 0 &&
        element.selectionEnd === value.length,
      copies: state.writes.length,
      lastCopyMatches: !!value && state.writes.at(-1) === value
    }
  })
}
