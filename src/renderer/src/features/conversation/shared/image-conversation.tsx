import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type JSX, type ReactNode } from 'react'

export interface ImageConversation {
  scope: string
  addImage: (file: File, replacePath?: string) => Promise<void>
}

const ImageConversationContext = createContext<ImageConversation | null>(null)
const receivers = new Map<string, ImageConversation>()
const listeners = new Set<() => void>()
let currentReceiver: ImageConversation | null = null
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = (): ImageConversation | null => currentReceiver
function publish(): void {
  const next = [...receivers.values()].at(-1) ?? null
  if (next === currentReceiver) return
  currentReceiver = next
  for (const listener of listeners) listener()
}

/** Editor tabs are siblings of the conversation. Only the visible mode may
 * receive their images; a viewer keeps the receiver it originally opened with. */
export function ImageConversationProvider({ value, active = true, children }: {
  value: ImageConversation; active?: boolean; children: ReactNode
}): JSX.Element {
  const id = useId()
  const lifetime = useRef({ scope: value.scope, active })
  if (lifetime.current.scope !== value.scope || lifetime.current.active !== active) lifetime.current = { scope: value.scope, active }
  const owner = lifetime.current
  const add = useRef(value.addImage)
  add.current = value.addImage
  const receiver = useMemo<ImageConversation>(() => ({ scope: value.scope, addImage: async (file, replacePath) => {
    const assertCurrent = (): void => {
      if (!owner.active || owner !== lifetime.current) throw new Error('图片所属会话已变化，请返回原会话后重试。')
    }
    assertCurrent()
    await add.current(file, replacePath)
    assertCurrent()
  } }), [value.scope, owner])
  useLayoutEffect(() => {
    owner.active = active
    if (active) { receivers.set(id, receiver); publish() }
    return () => { owner.active = false; receivers.delete(id); publish() }
  }, [active, id, owner, receiver])
  return <ImageConversationContext.Provider value={active ? receiver : null}>{children}</ImageConversationContext.Provider>
}

export function useImageConversation(): ImageConversation | null {
  const inherited = useContext(ImageConversationContext)
  const active = useSyncExternalStore(subscribe, snapshot, () => null)
  return inherited ?? active
}
