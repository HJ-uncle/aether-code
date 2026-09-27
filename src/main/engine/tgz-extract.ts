/**
 * 纯 Node.js 实现的 .tgz 解压（POSIX ustar 读取器）
 *
 * 为什么不用系统 tar：
 *   - Windows 自带的 bsdtar 在长路径/符号链接上行为不稳定
 *   - 不想为一次解压引入额外 npm 依赖
 *   - CDN 下载与本地包解压共用同一条路径，需要跨平台确定性
 *
 * 支持的 entry 类型：
 *   '0'/'\0' 普通文件、'5' 目录、'L' GNU LongLink（长文件名）、
 *   'x'/'g' pax 扩展头（跳过内容，路径由后续普通 header 决定）、
 *   '1'/'2' 硬/软链接（按跳过处理——发布包内不依赖链接）
 */
import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const BLOCK_SIZE = 512
const NAME_OFFSET = 0
const NAME_SIZE = 100
const SIZE_OFFSET = 124
const SIZE_SIZE = 12
const TYPEFLAG_OFFSET = 156
const PREFIX_OFFSET = 345
const PREFIX_SIZE = 155

/** 读取以 \0 结尾的 ASCII/UTF-8 字段 */
function readString(buf: Buffer, offset: number, size: number): string {
  const end = buf.indexOf(0, offset)
  const limit = offset + size
  const stop = end === -1 || end > limit ? limit : end
  return buf.toString('utf-8', offset, stop).trim()
}

/** 读取八进制数值字段（字段可能以空格/\0 结尾，也可能为空表示 0） */
function readOctal(buf: Buffer, offset: number, size: number): number {
  const raw = readString(buf, offset, size)
  if (!raw) return 0
  const value = parseInt(raw, 8)
  return Number.isNaN(value) ? 0 : value
}

export interface ExtractProgress {
  files: number
  bytes: number
}

export interface ExtractOptions {
  /** 解压进度回调（按文件计） */
  onProgress?: (progress: ExtractProgress) => void
}

/**
 * 将 .tgz 解压到 targetDir。
 *
 * 安全性：拒绝任何解析后逃逸出 targetDir 的路径（防目录穿越）。
 *
 * @returns 解压出的文件数量
 */
export async function extractTgz(
  tgzPath: string,
  targetDir: string,
  options: ExtractOptions = {}
): Promise<number> {
  const root = resolve(targetDir)
  await mkdir(root, { recursive: true })

  const gunzip = createGunzip()
  const source = createReadStream(tgzPath)
  source.pipe(gunzip)

  let pending: Buffer = Buffer.alloc(0)
  let fileCount = 0
  let totalBytes = 0
  /** GNU LongLink 提供的下一个 entry 的真实路径 */
  let longName: string | null = null
  /** 正在等待写入的异步任务，保证目录先于文件创建 */
  let writeChain: Promise<void> = Promise.resolve()

  const resolveEntryPath = (name: string): string => {
    const full = resolve(root, name)
    if (full !== root && !full.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error(`tgz entry escapes target directory: ${name}`)
    }
    return full
  }

  for await (const chunk of gunzip) {
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer])

    // 逐块解析；不足 512 字节的部分留到下一轮
    while (pending.length >= BLOCK_SIZE) {
      const header = pending.subarray(0, BLOCK_SIZE)

      // 全零块 = 归档结束
      if (header.every((b) => b === 0)) {
        pending = Buffer.alloc(0)
        break
      }

      const size = readOctal(header, SIZE_OFFSET, SIZE_SIZE)
      const typeFlag = header.toString('ascii', TYPEFLAG_OFFSET, TYPEFLAG_OFFSET + 1)
      const dataBlocks = Math.ceil(size / BLOCK_SIZE)
      const totalLen = BLOCK_SIZE + dataBlocks * BLOCK_SIZE

      if (pending.length < totalLen) break // 数据未到齐

      const data = pending.subarray(BLOCK_SIZE, BLOCK_SIZE + size)
      pending = pending.subarray(totalLen)

      const prefix = readString(header, PREFIX_OFFSET, PREFIX_SIZE)
      const rawName = readString(header, NAME_OFFSET, NAME_SIZE)
      const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
      longName = null

      if (!name) continue

      // GNU LongLink：本 entry 的 data 就是下一个 entry 的完整路径
      if (typeFlag === 'L') {
        longName = data.toString('utf-8').replace(/\0+$/, '')
        continue
      }
      // pax 扩展头：跳过其数据，路径继续由后续普通 header 提供
      if (typeFlag === 'x' || typeFlag === 'g') continue
      // 链接类型：发布包内不使用，跳过
      if (typeFlag === '1' || typeFlag === '2') continue

      const target = resolveEntryPath(name)

      if (typeFlag === '5') {
        const dir = target
        writeChain = writeChain.then(() => mkdir(dir, { recursive: true }).then(() => undefined))
        continue
      }

      // 普通文件（'0' 或 '\0'）。Buffer 是复用切片，写盘前必须复制。
      const payload = Buffer.from(data)
      fileCount++
      totalBytes += payload.length
      const finalCount = fileCount
      const finalBytes = totalBytes
      writeChain = writeChain.then(async () => {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, payload)
        if (options.onProgress && finalCount % 500 === 0) {
          options.onProgress({ files: finalCount, bytes: finalBytes })
        }
      })
    }
  }

  // 等所有落盘任务结束，避免调用方在文件写完前就启动引擎
  await writeChain
  options.onProgress?.({ files: fileCount, bytes: totalBytes })
  return fileCount
}
