/**
 * 引擎子进程生命周期管理
 *
 * 来源：ai-agent-engine/sdk-package/src/embedded/processManager.ts
 * 逻辑与上游保持一致，差异有两点：
 *   1. 返回 ChildProcess 引用，使上层能记录 PID（用于退出时回收孤儿进程）
 *   2. 日志转发加统一前缀，便于主进程日志面板过滤
 *
 * 内联原因见 port-finder.ts 顶部说明。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { logger } from '../logger'

export interface StartProcessOptions {
  /** node 可执行文件路径（默认 process.execPath） */
  nodePath?: string
  /** Packaged runtimes execute from writable state rather than installation resources. */
  cwd?: string
  /** 引擎入口脚本绝对路径 */
  binPath: string
  /** 监听端口，注入为 PORT */
  port: number
  /** SQLite 数据库文件路径，注入为 DATA_DIR */
  dataDir?: string
  /** 额外环境变量（优先级高于 process.env） */
  env?: Record<string, string>
  /** 子进程意外退出回调 */
  onExit?: (code: number | null, signal: string | null) => void
}

export interface ProcessHandle {
  process: ChildProcess
  port: number
  /** 子进程 PID；spawn 失败时为 undefined */
  pid: number | undefined
  /** 优雅关闭：SIGTERM → 超时 SIGKILL */
  stop: (timeoutMs?: number) => Promise<void>
}

/**
 * 精确大小写地查找名为 SKILLs 的子目录。
 *
 * 不能用 fs.existsSync(path.join(dir, 'SKILLs'))：Windows 的 NTFS 大小写不敏感，
 * 而引擎编译产物里有 dist/skills/（src/skills 的编译结果），
 * 会被误判为技能目录，导致真正的 SKILLs/ 永远找不到、技能数为 0。
 * Linux/macOS 区分大小写不会踩到，因此这是 Windows 专有缺陷。
 */
function findExactSkillsDir(parent: string): string | null {
  try {
    const entries = fs.readdirSync(parent, { withFileTypes: true })
    const hit = entries.find((entry) => entry.isDirectory() && entry.name === 'SKILLs')
    return hit ? path.join(parent, hit.name) : null
  } catch {
    return null
  }
}

/**
 * 定位 SKILLS_ROOT：从入口目录向上最多 3 级，找第一个含 SKILLs/ 的目录。
 * 兼容 <pkg>/main.js 与 <pkg>/dist/main.js 两种布局。
 */
function resolveSkillsRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 3; i++) {
    const found = findExactSkillsDir(dir)
    if (found) return found
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(startDir, 'SKILLs')
}

export function startProcess(opts: StartProcessOptions): ProcessHandle {
  const nodePath = opts.nodePath ?? process.execPath
  const binDir = path.dirname(opts.binPath)

  const callerEnv = opts.env ?? {}
  const skillsRootEnv: Record<string, string> = callerEnv['SKILLS_ROOT']
    ? {}
    : { SKILLS_ROOT: resolveSkillsRoot(binDir) }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(opts.port),
    HOST: '127.0.0.1',
    // 关闭颜色，避免 ANSI 序列污染日志面板
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...(opts.dataDir ? { DATA_DIR: opts.dataDir } : {}),
    ...skillsRootEnv,
    ...callerEnv
  }

  const child = spawn(nodePath, [opts.binPath], {
    cwd: opts.cwd ?? binDir,
    windowsHide: true,
    env,
    // 不 detached：父进程退出时子进程随之终止，避免留下孤儿
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) logger.engine(line)
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      // 运行时噪音过滤：punycode 的 DEP0040 弃用警告来自 Electron 的 Node
      // 运行层（引擎与依赖用的都是用户land版 punycode），用户既修不了也不
      // 需要关心，显示出来只会让人以为引擎出错了。警告固定三行，
      // 中间一行只有 "userland alternative" 可匹配。
      if (
        line.includes('[DEP0040]') ||
        line.includes('userland alternative') ||
        line.includes('--trace-deprecation')
      ) {
        continue
      }
      if (line.trim()) logger.engineError(line)
    }
  })

  child.on('exit', (code, signal) => {
    opts.onExit?.(code, signal)
  })

  return {
    process: child,
    port: opts.port,
    pid: child.pid,
    stop: (timeoutMs = 5000) => stopProcess(child, timeoutMs)
  }
}

/** 优雅关闭：先 SIGTERM，超时后 SIGKILL */
export function stopProcess(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve()
      return
    }

    let timer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve()
    }

    child.once('exit', cleanup)

    try {
      child.kill('SIGTERM')
    } catch {
      cleanup()
      return
    }

    timer = setTimeout(() => {
      child.removeListener('exit', cleanup)
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已退出 */
      }
      child.once('exit', resolve)
      setTimeout(resolve, 200)
    }, timeoutMs)
  })
}
