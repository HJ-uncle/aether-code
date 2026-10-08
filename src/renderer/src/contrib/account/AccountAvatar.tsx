import { useState, type JSX } from 'react'
import { Icon } from '@renderer/workbench/icons'

export function AccountAvatar({ name, avatarUrl, large = false }: {
  name?: string; avatarUrl?: string | null; large?: boolean
}): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // Provider URLs are not fetched by the renderer. Only an already sanitized
  // raster payload can render within the application's existing CSP.
  const safeImage = avatarUrl && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarUrl) && avatarUrl !== failedUrl
  return <span className={`account-avatar${large ? ' account-avatar--large' : ''}`} aria-hidden="true">
    {safeImage ? <img src={avatarUrl} alt="" onError={() => setFailedUrl(avatarUrl)} />
      : name?.trim() ? Array.from(name.trim())[0].toLocaleUpperCase() : <Icon name="account-outline" size={large ? 28 : 17} />}
  </span>
}
