/**
 * 端口探测
 *
 * 来源：ai-agent-engine/sdk-package/src/embedded/portFinder.ts
 * 逻辑与上游保持一致（从首选端口起逐个尝试 TCP 绑定）。
 *
 * 为什么内联而不是依赖上游包：该包的发布产物经 javascript-obfuscator 混淆，
 * 字符串字面量被替换为运行时查表，导致 require 路径无法被构建工具静态解析，
 * 无法打进主进程产物。此处按源码逻辑重写为原生 ESM，语义等价。
 */
import * as net from 'node:net'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

export interface PortReservation {
  /** The port held for this reservation. */
  readonly port: number
  /** Release the probe socket while retaining the cross-process lease. */
  releaseSocket(): Promise<void>
  /** Release both the probe socket and the cross-process lease. */
  release(): Promise<void>
}

interface LeaseRecord {
  pid: number
  at: number
}

const LEASE_MAX_AGE_MS = 2 * 60 * 1000

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

async function staleLease(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseRecord>
    if (typeof value.pid !== 'number' || typeof value.at !== 'number') return true
    if (Date.now() - value.at > LEASE_MAX_AGE_MS) return true
    try {
      process.kill(value.pid, 0)
      return false
    } catch {
      return true
    }
  } catch {
    return true
  }
}

/** Reserve a port across Electron processes until the child has bound it. */
export async function reserveAvailablePort(
  preferredPort = 12323,
  maxTries = 100,
  leaseDirectory?: string
): Promise<PortReservation> {
  if (!validPort(preferredPort)) throw new Error(`Invalid preferred port: ${preferredPort}`)
  if (!Number.isInteger(maxTries) || maxTries < 1) throw new Error(`Invalid port probe limit: ${maxTries}`)
  if (leaseDirectory) await mkdir(leaseDirectory, { recursive: true })

  let tried = 0
  while (tried < maxTries) {
    const port = preferredPort + tried++
    if (!validPort(port)) break
    const leasePath = leaseDirectory ? join(leaseDirectory, `${port}.lock`) : null
    let leaseHandle: Awaited<ReturnType<typeof open>> | null = null
    if (leasePath) {
      try {
        leaseHandle = await open(leasePath, 'wx')
        await leaseHandle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LeaseRecord), 'utf8')
        await leaseHandle.close()
        leaseHandle = null
      } catch (error) {
        await leaseHandle?.close().catch(() => {})
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          if (await staleLease(leasePath)) await rm(leasePath, { force: true }).catch(() => {})
          continue
        }
        throw error
      }
    }

    const server = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
    } catch (error) {
      server.close()
      if (leasePath) await rm(leasePath, { force: true }).catch(() => {})
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE' || code === 'EACCES') continue
      throw error
    }

    let socketReleased = false
    let leaseReleased = false
    const releaseSocket = async (): Promise<void> => {
      if (socketReleased) return
      socketReleased = true
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    const release = async (): Promise<void> => {
      await releaseSocket()
      if (!leaseReleased) {
        leaseReleased = true
        if (leasePath) await rm(leasePath, { force: true }).catch(() => {})
      }
    }
    return { port, releaseSocket, release }
  }
  throw new Error(`No available port found after ${maxTries} attempts starting from port ${preferredPort}`)
}

/**
 * 探测从 preferredPort 开始的第一个可用 TCP 端口。
 *
 * @throws 超过 maxTries 次仍被占用时抛错
 */
export function findAvailablePort(preferredPort = 12323, maxTries = 100): Promise<number> {
  return reserveAvailablePort(preferredPort, maxTries).then(async reservation => {
    await reservation.release()
    return reservation.port
  })
}
