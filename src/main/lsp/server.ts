/**
 * TS 语言服务进程管理（主进程）
 *
 * spawn 一个真实的 typescript-language-server（以 Electron 的 Node 模式跑），
 * 通过 stdio 走 LSP 的 Content-Length 分帧协议。渲染进程经 IPC 与服务器交换
 * JSON-RPC 消息，本模块只负责：
 *   - 进程生命周期（spawn / kill / 退出通知）
 *   - stdout 的 LSP 分帧解析（Content-Length 头 + JSON body）
 *   - stdin 的 LSP 分帧写入
 *
 * 单实例：全应用只有一个工作区根，一个语言服务进程足够；重复 start 先停旧的。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { LspExitInfo, LspMessage } from '../../shared/ipc'

interface LspServerCallbacks {
  /** 服务器往渲染进程推一条 JSON-RPC 消息（响应 / 通知） */
  onMessage: (message: LspMessage) => void
  /** 进程退出（正常或崩溃都算） */
  onExit: (info: LspExitInfo) => void
}

let server: ChildProcessWithoutNullStreams | null = null
let callbacks: LspServerCallbacks | null = null

/** stdout 分帧缓冲：LSP 帧头是 ASCII，body 是 UTF-8 JSON，必须按字节切 */
let pending: Buffer = Buffer.alloc(0)

/** 启动语言服务。重复调用会先停掉旧进程。 */
export function startLsp(serverEntry: string, cbs: LspServerCallbacks): void {
  stopLsp()
  callbacks = cbs
  pending = Buffer.alloc(0)

  // ELECTRON_RUN_AS_NODE：让 Electron 可执行文件以纯 Node 模式跑服务器入口，
  // 免去系统必须装有 Node 的假设（与 wuzu-client 的做法一致）
  const child = spawn(process.execPath, [serverEntry, '--stdio'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  server = child

  child.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    drainFrames()
  })
  child.stderr.on('data', () => {
    // 服务器的 stderr 多为启动日志/警告，不进协议；忽略即可
  })
  child.on('exit', (code, signal) => {
    if (server === child) server = null
    callbacks?.onExit({ code, signal })
  })
  child.on('error', () => {
    if (server === child) server = null
    callbacks?.onExit({ code: null, signal: null })
  })
}

/** 停止语言服务（幂等）。退出通知仍会通过 onExit 送达。 */
export function stopLsp(): void {
  const child = server
  server = null
  pending = Buffer.alloc(0)
  if (child && !child.killed) child.kill()
}

/** 渲染进程发来一条 JSON-RPC 消息，写进服务器 stdin（带 Content-Length 帧头） */
export function sendToLsp(message: LspMessage): void {
  if (!server) return
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  server.stdin.write(Buffer.concat([header, body]))
}

/**
 * 从缓冲里尽可能多地解出完整帧。
 *
 * 帧格式：`Content-Length: N\r\n` （可跟其它头）`\r\n` + N 字节 JSON。
 * 数据可能半包到达（header 全了 body 没到），不足时留到下一次 data。
 */
function drainFrames(): void {
  for (;;) {
    const headerEnd = pending.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = pending.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) {
      // 坏帧：丢弃头继续找，避免死循环卡死协议流
      pending = pending.subarray(headerEnd + 4)
      continue
    }
    const bodyLength = Number(match[1])
    const bodyStart = headerEnd + 4
    if (pending.length < bodyStart + bodyLength) return
    const body = pending.subarray(bodyStart, bodyStart + bodyLength).toString('utf8')
    pending = pending.subarray(bodyStart + bodyLength)
    try {
      callbacks?.onMessage(JSON.parse(body) as LspMessage)
    } catch {
      // 单条消息解析失败不影响后续帧：跳过
    }
  }
}
