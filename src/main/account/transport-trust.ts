import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { remoteAuthTarget } from '../engine/remote-auth-contract'
import { accountTransport } from './transport-contract'

function trustFile(): string { return join(app.getPath('userData'), 'accounts', 'trusted-http-services.json') }
function readTrustedServices(): string[] {
  const path = trustFile()
  if (!existsSync(path)) return []
  try {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!stored || typeof stored !== 'object' || !('version' in stored) || stored.version !== 1 || !('services' in stored) || !Array.isArray(stored.services)) return []
    return stored.services.filter((value): value is string => typeof value === 'string')
  } catch { return [] }
}
export function getAccountTransport(url: string): ReturnType<typeof accountTransport> {
  return accountTransport(url, readTrustedServices())
}
export function saveHttpTrust(url: string, trusted: boolean): void {
  const target = remoteAuthTarget(url)
  if (new URL(target).protocol !== 'http:') throw new Error('只有 HTTP 服务需要内网信任设置。')
  const services = readTrustedServices().filter(value => value !== target)
  if (trusted) services.push(target)
  const file = trustFile(), temporary = `${file}.${process.pid}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, services }), { mode: 0o600 })
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
