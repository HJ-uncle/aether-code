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

/**
 * 探测从 preferredPort 开始的第一个可用 TCP 端口。
 *
 * @throws 超过 maxTries 次仍被占用时抛错
 */
export function findAvailablePort(preferredPort = 12323, maxTries = 100): Promise<number> {
  return new Promise((resolve, reject) => {
    let tried = 0

    function tryPort(port: number): void {
      if (tried >= maxTries) {
        reject(
          new Error(
            `No available port found after ${maxTries} attempts starting from port ${preferredPort}`
          )
        )
        return
      }
      tried++

      const server = net.createServer()

      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close()
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          tryPort(port + 1)
        } else {
          reject(err)
        }
      })

      server.once('listening', () => {
        // 占位服务器只用于试探，拿到结果立刻释放
        server.close(() => resolve(port))
      })

      server.listen(port, '127.0.0.1')
    }

    tryPort(preferredPort)
  })
}
