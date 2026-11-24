import { useEffect, useMemo, useState, type JSX } from 'react'
import type { RemoteTokenStatus } from '@shared/ipc'
import { remoteServiceUrl } from '@shared/remote-service-url'
import { SettingsRow } from './SettingsGroup'
import { CredentialInput } from './CredentialInput'

export interface SecretDraft { address: string; instanceToken?: string; instanceGenerated?: boolean }

export function EngineCredentialFields({ address, secrets, onChange, disabled, revision }: {
  address: string
  secrets: SecretDraft
  onChange: (patch: Partial<Omit<SecretDraft, 'address'>>) => void
  disabled: boolean
  revision: number
}): JSX.Element {
  const service = useMemo(() => { try { return remoteServiceUrl(address.trim()) } catch { return '' } }, [address])
  const [status, setStatus] = useState<{ service: string; revision: number; token: RemoteTokenStatus | null } | null>(null)
  useEffect(() => {
    if (!service) return
    let current = true
    const timer = window.setTimeout(() => {
      const done = (token: RemoteTokenStatus | null): void => { if (current) setStatus({ service, revision, token }) }
      void window.aether.settings.remoteTokenStatus(service).then(done, () => done(null))
    }, 220)
    return () => { current = false; window.clearTimeout(timer) }
  }, [service, revision])
  const target = status?.service === service && status.revision === revision ? status : null
  const token = target?.token, tokenError = !!target && !token, disabledField = disabled || !service
  return (
    <SettingsRow label="实例令牌" description="使用部署方提供的令牌；自建服务可在此生成。">
      <CredentialInput
        key={`${address}:${revision}:${disabledField}`}
        kind="instance"
        value={secrets.instanceToken}
        generated={secrets.instanceGenerated}
        placeholder={
          secrets.instanceToken === ''
            ? '应用后移除'
            : token?.source === 'environment'
              ? '启动配置已提供'
              : token?.configured
                ? '已保存，留空保留'
                : '输入实例令牌'
        }
        disabled={disabledField}
        canRemove={token?.source === 'stored' || tokenError}
        readError={tokenError}
        edit={(instanceToken, instanceGenerated) =>
          onChange({ instanceToken, instanceGenerated })
        }
      />
    </SettingsRow>
  )
}
